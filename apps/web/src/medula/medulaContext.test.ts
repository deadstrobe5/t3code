import { describe, expect, it } from "vite-plus/test";

import {
  filterMedulaContextGroups,
  formatMedulaChars,
  formatMedulaContextSummary,
  isMedulaContextBlockNew,
  isMedulaContextUnseen,
  MEDULA_CONTEXT_DEFAULT_ORIGINS,
  MEDULA_CONTEXT_ORIGINS,
  MEDULA_CONTEXT_SEEN_KEY,
  medulaContextSeenMark,
  parseMedulaContextResponse,
  readMedulaContextSeenAt,
  writeMedulaContextSeenAt,
  type MedulaContextGroup,
  type MedulaKeyValueStorage,
} from "./medulaContext";

const block = (id: string, origin: string, extra: Record<string, unknown> = {}) => ({
  id,
  at: "2026-10-23T03:00:00.000Z",
  origin,
  event: "UserPromptSubmit",
  label: `Bloco ${id}`,
  chars: 10,
  text: `texto ${id}`,
  truncated: false,
  ...extra,
});

const fullResponse = {
  available: true,
  sessionId: "s-1",
  updatedAt: "2026-10-23T03:05:00.000Z",
  latestBlockAt: "2026-10-23T03:04:00.000Z",
  sinceLastPrompt: { blocks: 2, chars: 1234 },
  groups: [
    { id: "inicio", at: "2026-10-23T02:00:00.000Z", prompt: null, blocks: [block("a", "sistema")] },
    {
      id: "u-1",
      at: "2026-10-23T03:00:00.000Z",
      prompt: "Faz isto",
      blocks: [
        block("b", "hora"),
        block("c", "mordomo", { text: "O Mordomo fundiu o ramo", label: "Mordomo · Fork" }),
      ],
    },
  ],
};

function memoryStorage(): MedulaKeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (name) => data.get(name) ?? null,
    setItem: (name, value) => {
      data.set(name, value);
    },
  };
}

describe("parseMedulaContextResponse", () => {
  it("keeps a well-formed full response", () => {
    const parsed = parseMedulaContextResponse(fullResponse);
    expect(parsed?.available).toBe(true);
    if (!parsed?.available) return;
    expect(parsed.sinceLastPrompt).toEqual({ blocks: 2, chars: 1234 });
    expect(parsed.groups?.map((group) => group.id)).toEqual(["inicio", "u-1"]);
    expect(parsed.groups?.[1]?.blocks[1]?.origin).toBe("mordomo");
  });

  it("treats a summary response as having no groups", () => {
    const { groups: _groups, ...summary } = fullResponse;
    const parsed = parseMedulaContextResponse(summary);
    expect(parsed?.available && parsed.groups).toBeNull();
  });

  it("reports unavailable reasons and rejects garbage", () => {
    expect(parseMedulaContextResponse({ available: false, reason: "no-claude-session" })).toEqual({
      available: false,
      reason: "no-claude-session",
    });
    expect(parseMedulaContextResponse({ available: false, reason: "??" })).toEqual({
      available: false,
      reason: "transcript-missing",
    });
    expect(parseMedulaContextResponse(null)).toBeNull();
    expect(parseMedulaContextResponse([])).toBeNull();
    expect(parseMedulaContextResponse({ ok: true })).toBeNull();
  });

  it("repairs malformed blocks instead of dropping the response", () => {
    const parsed = parseMedulaContextResponse({
      available: true,
      sinceLastPrompt: "x",
      groups: [
        {
          id: "u-2",
          at: "t",
          prompt: "",
          blocks: [{ origin: "novo-tipo", text: "abc", chars: -3 }, 42, null],
        },
        "lixo",
      ],
    });
    if (!parsed?.available) throw new Error("expected available");
    expect(parsed.sinceLastPrompt).toEqual({ blocks: 0, chars: 0 });
    expect(parsed.groups).toHaveLength(1);
    const [only] = parsed.groups?.[0]?.blocks ?? [];
    expect(parsed.groups?.[0]?.prompt).toBeNull();
    expect(only).toMatchObject({ origin: "hook", chars: 3, label: "Sem título", truncated: false });
    expect(only?.id).toBeTruthy();
  });
});

describe("formatting", () => {
  it("formats sizes the Portuguese way", () => {
    expect(formatMedulaChars(850)).toBe("850 chars");
    expect(formatMedulaChars(1234)).toBe("1,2 k chars");
    expect(formatMedulaChars(12_000)).toBe("12 k chars");
    expect(formatMedulaChars(123_456)).toBe("123 k chars");
  });

  it("summarises what came in since the last message", () => {
    expect(formatMedulaContextSummary({ blocks: 3, chars: 1234 })).toBe(
      "Desde a última mensagem entraram 3 blocos · 1,2 k chars",
    );
    expect(formatMedulaContextSummary({ blocks: 1, chars: 40 })).toBe(
      "Desde a última mensagem entrou 1 bloco · 40 chars",
    );
    expect(formatMedulaContextSummary({ blocks: 0, chars: 0 })).toBe(
      "Desde a última mensagem não entrou nada.",
    );
  });
});

describe("filterMedulaContextGroups", () => {
  const parsed = parseMedulaContextResponse(fullResponse);
  const groups: readonly MedulaContextGroup[] = (parsed?.available && parsed.groups) || [];

  it("hides system reminders by default and lists groups newest first", () => {
    expect(MEDULA_CONTEXT_DEFAULT_ORIGINS).not.toContain("sistema");
    const views = filterMedulaContextGroups(groups, {
      origins: MEDULA_CONTEXT_DEFAULT_ORIGINS,
      query: "",
    });
    expect(views.map((view) => view.group.id)).toEqual(["u-1", "inicio"]);
    expect(views[1]).toMatchObject({ blocks: [], hidden: 1 });
    expect(views[0]?.blocks.map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("searches label and text case-insensitively and drops groups without a match", () => {
    const byText = filterMedulaContextGroups(groups, {
      origins: [...MEDULA_CONTEXT_ORIGINS],
      query: "  FUNDIU ",
    });
    expect(byText.map((view) => view.group.id)).toEqual(["u-1"]);
    expect(byText[0]?.blocks.map((item) => item.id)).toEqual(["c"]);
    const byLabel = filterMedulaContextGroups(groups, {
      origins: [...MEDULA_CONTEXT_ORIGINS],
      query: "bloco a",
    });
    expect(byLabel.map((view) => view.group.id)).toEqual(["inicio"]);
  });
});

describe("seen marks", () => {
  it("lights only when a block is newer than a known mark", () => {
    const latest = "2026-10-23T03:04:00.000Z";
    const latestMs = Date.parse(latest);
    expect(isMedulaContextUnseen(latest, null)).toBe(false);
    expect(isMedulaContextUnseen(latest, latestMs - 1)).toBe(true);
    expect(isMedulaContextUnseen(latest, latestMs)).toBe(false);
    expect(isMedulaContextUnseen(null, 0)).toBe(false);
    expect(isMedulaContextUnseen("not a date", 0)).toBe(false);
  });

  it("marks blocks newer than the mark at opening as new", () => {
    const item = { at: "2026-10-23T03:00:00.000Z" } as Parameters<
      typeof isMedulaContextBlockNew
    >[0];
    expect(isMedulaContextBlockNew(item, Date.parse(item.at) - 1)).toBe(true);
    expect(isMedulaContextBlockNew(item, Date.parse(item.at))).toBe(false);
    expect(isMedulaContextBlockNew(item, null)).toBe(false);
  });

  it("stores a forward-only mark per thread", () => {
    const storage = memoryStorage();
    expect(readMedulaContextSeenAt(storage, "t-1")).toBeNull();
    expect(writeMedulaContextSeenAt(storage, "t-1", 100)).toBe(true);
    expect(writeMedulaContextSeenAt(storage, "t-1", 50)).toBe(false);
    expect(writeMedulaContextSeenAt(storage, "t-2", 70)).toBe(true);
    expect(readMedulaContextSeenAt(storage, "t-1")).toBe(100);
    expect(readMedulaContextSeenAt(storage, "t-2")).toBe(70);
  });

  it("survives corrupt storage", () => {
    const storage = memoryStorage();
    storage.data.set(MEDULA_CONTEXT_SEEN_KEY, "{not json");
    expect(readMedulaContextSeenAt(storage, "t-1")).toBeNull();
    expect(writeMedulaContextSeenAt(storage, "t-1", 5)).toBe(true);
    expect(readMedulaContextSeenAt(storage, "t-1")).toBe(5);
  });

  it("takes the later of now and the newest block as the mark", () => {
    const latest = "2026-10-23T03:04:00.000Z";
    expect(medulaContextSeenMark(latest, 0)).toBe(Date.parse(latest));
    expect(medulaContextSeenMark(latest, Date.parse(latest) + 5)).toBe(Date.parse(latest) + 5);
    expect(medulaContextSeenMark(null, 42)).toBe(42);
  });
});
