// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createContextParseState,
  contextGroups,
  parseContextLines,
  pickClaudeSession,
  readThreadContext,
  readTranscriptContext,
  resetContextCache,
  transcriptPathFor,
  type MedulaContextGroup,
} from "./context.ts";

// Real transcript entries (Claude Code 2.1.307), long strings shortened.
const fixtures = JSON.parse(
  NodeFS.readFileSync(new URL("./context.fixtures.json", import.meta.url), "utf8"),
) as Record<string, Record<string, unknown>>;
const line = (name: string, patch: Record<string, unknown> = {}) =>
  JSON.stringify({ ...fixtures[name], ...patch });

const parse = (lines: string[]): MedulaContextGroup[] => {
  const state = createContextParseState();
  parseContextLines(lines, state);
  return contextGroups(state);
};
const summary = (group: MedulaContextGroup | undefined) =>
  group?.blocks.map((block) => `${block.origin}|${block.event}|${block.label}`);

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "medula-context-"));

beforeEach(() => resetContextCache());

describe("parseContextLines: classification", () => {
  it("splits the UserPromptSubmit context by source", () => {
    const groups = parse([
      line("prompt"),
      line("ups_mordomo"),
      line("ups_canalizador"),
      line("ups_ideias_correcao"),
      line("ups_parece"),
    ]);
    expect(groups).toHaveLength(1);
    expect(summary(groups[0])).toEqual([
      "hora|UserPromptSubmit|Hora e conta",
      "mordomo|UserPromptSubmit|Mordomo",
      "mordomo|UserPromptSubmit|Mordomo · Mordomo",
      "hora|UserPromptSubmit|Hora e conta",
      "canalizador|UserPromptSubmit|Mordomo · Canalizador",
      "ideias|UserPromptSubmit|Caixa de ideias",
      "hora|UserPromptSubmit|Hora e conta",
      "correcao|UserPromptSubmit|Correção registada",
      "mordomo|UserPromptSubmit|Mordomo · F2-a livro.py owner of livro.jsonl",
      "ideias|UserPromptSubmit|Caixa de ideias",
      "hora|UserPromptSubmit|Hora e conta",
      "correcao|UserPromptSubmit|Possível correção",
    ]);
    const [hora, mordomo] = groups[0]!.blocks;
    const uuid = fixtures.ups_mordomo!.uuid as string;
    expect(hora!.id).toBe(`${uuid}:0`);
    expect(hora!.text).toMatch(/^Agora: 2026-10-23 02:26 /);
    expect(mordomo!.text).toMatch(/^Mordomo: trata deste relatório/);
    expect(hora!.at).toBe(fixtures.ups_mordomo!.timestamp);
  });

  it("keeps unknown leading lines as a hook block and continues known ones", () => {
    const entry = structuredClone(fixtures.ups_parece!) as {
      attachment: { content: string[] };
    };
    entry.attachment.content = [
      "linha solta",
      "Agora: 10:00 · conta a1",
      "boletim 03:19 publicado",
    ];
    const [group] = parse([JSON.stringify(entry)]);
    expect(group!.blocks.map((b) => [b.origin, b.text])).toEqual([
      ["hook", "linha solta"],
      ["hora", "Agora: 10:00 · conta a1\nboletim 03:19 publicado"],
    ]);
  });

  it("maps hooks, Stop feedback, notifications, compaction and system reminders", () => {
    const groups = parse([
      line("prompt"),
      line("hook_SessionStart"),
      line("hook_success"),
      line("hook_PreToolUse"),
      line("assistant"),
      line("tool_result"),
      line("hook_blocking_error"),
      line("stop_feedback"),
      line("task_notification"),
      line("output_style"),
      line("task_status"),
      line("batching_reminder_sent"),
      line("date"),
      line("compact_boundary"),
      line("compact_summary"),
      line("instructions"),
    ]);
    expect(groups).toHaveLength(1);
    expect(summary(groups[0])).toEqual([
      "hook|SessionStart|Hook · SessionStart",
      "hook|PreToolUse:Bash|Hook · PreToolUse:Bash",
      "stop|Stop|Stop · devolvido ao modelo",
      "notificacao|task-notification|Tarefa terminou: Botões dos agentes periódicos",
      "sistema|output_style|Estilo de saída",
      "sistema|task_status|Estado da tarefa: GPU parada e retreino na ronda",
      "sistema|date|Data",
      "compactacao|compact_boundary|Conversa compactada",
      "compactacao|null|Resumo da compactação",
      "sistema|instructions|Instruções (CLAUDE.md)",
    ]);
    const blocks = groups[0]!.blocks;
    expect(blocks[2]!.text).toMatch(/^Memory check \(42 tool calls/);
    expect(blocks[4]!.text).toBe(
      "ADHD output style is active. Remember to follow the specific guidelines for this style.",
    );
    expect(blocks[6]!.text).toBe("Today's date is 2026-10-22.");
    expect(blocks[7]!.text).toContain("preTokens: 217125");
    expect(blocks[7]!.text).toContain("postTokens: 29926");
    expect(blocks[8]!.text).toMatch(/^This session is being continued/);
  });

  it("shows a notification once when it arrives queued and as a message", () => {
    const text = (fixtures.task_notification!.message as { content: string }).content;
    const queued = structuredClone(fixtures.queued_command!) as {
      attachment: { prompt: string };
    };
    queued.attachment.prompt = text.replace(/<tool-use-id>[^\n]*\n/, "");
    const groups = parse([line("prompt"), JSON.stringify(queued), line("task_notification")]);
    expect(summary(groups[0])).toEqual([
      "notificacao|task-notification|Tarefa terminou: Botões dos agentes periódicos",
    ]);
    // A different run of the same task (other result) is a block of its own.
    expect(
      summary(parse([line("prompt"), line("queued_command"), line("task_notification")])[0]),
    ).toHaveLength(2);
  });

  it("truncates long texts and reports the full size", () => {
    const entry = structuredClone(fixtures.hook_SessionStart!) as {
      attachment: { content: string[] };
    };
    entry.attachment.content = ["x".repeat(100_001)];
    const [block] = parse([JSON.stringify(entry)])[0]!.blocks;
    expect(block!.chars).toBe(100_001);
    expect(block!.text).toHaveLength(100_000);
    expect(block!.truncated).toBe(true);
  });
});

describe("parseContextLines: grouping", () => {
  it("opens a group per operator message, with 'inicio' before the first", () => {
    const groups = parse([
      line("hook_SessionStart"),
      line("prompt"),
      line("ups_parece"),
      line("task_notification"),
      line("stop_feedback"),
      line("prompt_image"),
      line("date"),
    ]);
    expect(groups.map((g) => [g.id, g.prompt === null ? null : g.prompt.slice(0, 20)])).toEqual([
      ["inicio", null],
      [fixtures.prompt!.uuid, "ah e o painel está a"],
      [fixtures.prompt_image!.uuid, expect.any(String)],
    ]);
    expect(groups[1]!.at).toBe(fixtures.prompt!.timestamp);
    expect(summary(groups[1])).toHaveLength(3);
    expect(summary(groups[2])).toEqual(["sistema|date|Data"]);
  });

  it("keeps the last 15 groups and clips prompts to 500 chars", () => {
    const prompts = Array.from({ length: 20 }, (_, index) =>
      line("prompt", {
        uuid: `p-${index}`,
        message: { role: "user", content: `${index} ${"a".repeat(600)}` },
      }),
    );
    const groups = parse(prompts);
    expect(groups).toHaveLength(15);
    expect(groups[0]!.id).toBe("p-5");
    expect(groups[0]!.prompt).toHaveLength(500);
    expect(groups[0]!.prompt!.endsWith("…")).toBe(true);
  });
});

describe("readTranscriptContext", () => {
  it("reads only appended bytes and waits for partial lines", async () => {
    const file = NodePath.join(tmp(), "s.jsonl");
    NodeFS.writeFileSync(file, `${line("prompt")}\n${line("ups_parece")}\n`);
    const first = await readTranscriptContext(file);
    expect(summary(first!.groups[0])).toHaveLength(2);

    // Bytes before the offset are never read again: a change there is unseen.
    const fd = NodeFS.openSync(file, "r+");
    NodeFS.writeSync(fd, "X", NodeFS.readFileSync(file, "utf8").indexOf("ah e o"));
    NodeFS.closeSync(fd);

    const next = line("date");
    NodeFS.appendFileSync(file, next.slice(0, 50));
    const partial = await readTranscriptContext(file);
    expect(summary(partial!.groups[0])).toHaveLength(2);

    NodeFS.appendFileSync(file, `${next.slice(50)}\n`);
    const full = await readTranscriptContext(file);
    expect(full!.groups).toHaveLength(1);
    expect(full!.groups[0]!.prompt).toMatch(/^ah e o painel/);
    expect(summary(full!.groups[0])).toHaveLength(3);
  });

  it("starts from the tail, dropping the first partial line", async () => {
    const file = NodePath.join(tmp(), "s.jsonl");
    const tail = `${line("hook_PreToolUse")}\n${line("prompt")}\n${line("date")}\n`;
    NodeFS.writeFileSync(file, `${line("prompt_image")}\n${line("ups_parece")}\n${tail}`);
    // A window that starts inside the ups_parece line.
    const read = await readTranscriptContext(file, { tailBytes: Buffer.byteLength(tail) + 20 });
    expect(read!.groups.map((g) => g.id)).toEqual(["inicio", fixtures.prompt!.uuid]);
    expect(summary(read!.groups[0])).toEqual(["hook|PreToolUse:Bash|Hook · PreToolUse:Bash"]);
  });

  it("starts over when the file shrinks or is replaced", async () => {
    const file = NodePath.join(tmp(), "s.jsonl");
    NodeFS.writeFileSync(file, `${line("prompt")}\n${line("ups_mordomo")}\n${line("date")}\n`);
    expect(summary((await readTranscriptContext(file))!.groups[0])).toHaveLength(4);
    NodeFS.writeFileSync(file, `${line("prompt_image")}\n`);
    const read = await readTranscriptContext(file);
    expect(read!.groups.map((g) => g.id)).toEqual([fixtures.prompt_image!.uuid]);
  });

  it("returns null for a missing file", async () => {
    expect(await readTranscriptContext(NodePath.join(tmp(), "none.jsonl"))).toBeNull();
  });
});

describe("transcriptPathFor", () => {
  it("uses the encoded cwd folder, then scans the project folders", async () => {
    const claudeDir = tmp();
    const direct = NodePath.join(claudeDir, "projects", "-home-a--t3-x");
    const other = NodePath.join(claudeDir, "projects", "-elsewhere");
    NodeFS.mkdirSync(direct, { recursive: true });
    NodeFS.mkdirSync(other, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(direct, "s1.jsonl"), "");
    NodeFS.writeFileSync(NodePath.join(other, "s2.jsonl"), "");

    expect(await transcriptPathFor(claudeDir, "/home/a/.t3/x", "s1")).toBe(
      NodePath.join(direct, "s1.jsonl"),
    );
    expect(await transcriptPathFor(claudeDir, "/home/a/.t3/x", "s2")).toBe(
      NodePath.join(other, "s2.jsonl"),
    );
    expect(await transcriptPathFor(claudeDir, null, "s2")).toBe(NodePath.join(other, "s2.jsonl"));
    expect(await transcriptPathFor(claudeDir, null, "s3")).toBeNull();
    expect(await transcriptPathFor(claudeDir, null, "../s1")).toBeNull();
  });
});

describe("readThreadContext", () => {
  it("summarises the last group and omits groups with summary", async () => {
    const claudeDir = tmp();
    const folder = NodePath.join(claudeDir, "projects", "-w");
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(folder, "sid.jsonl"),
      `${line("prompt")}\n${line("ups_parece")}\n${line("date")}\n`,
    );
    const full = await readThreadContext({ claudeDir, cwd: "/w", sessionId: "sid" });
    expect(full).toMatchObject({
      available: true,
      sessionId: "sid",
      latestBlockAt: fixtures.date!.timestamp,
      sinceLastPrompt: { blocks: 3 },
    });
    expect(full.available && full.groups).toHaveLength(1);
    const brief = await readThreadContext({
      claudeDir,
      cwd: "/w",
      sessionId: "sid",
      summary: true,
    });
    expect(brief.available && "groups" in brief).toBe(false);
    expect(brief.available && brief.sinceLastPrompt.chars).toBeGreaterThan(100);
    expect(await readThreadContext({ claudeDir, cwd: "/w", sessionId: "nope" })).toEqual({
      available: false,
      reason: "transcript-missing",
    });
  });
});

describe("pickClaudeSession", () => {
  const thread = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    driver: "claudeAgent",
    providerSessionId: `ps-${id}`,
    ownerNodeId: null,
    nativeThreadRef: { nativeId: `native-${id}` },
    lastRunOrdinal: 1,
    ...patch,
  });

  it("picks the root Claude thread that ran last, with its session cwd", () => {
    expect(
      pickClaudeSession({
        activeProviderThreadId: "codex",
        worktreePath: "/wt",
        providerThreads: [
          thread("old", { lastRunOrdinal: 3 }),
          thread("new", { lastRunOrdinal: 9 }),
          thread("sub", { ownerNodeId: "node-1", lastRunOrdinal: 50 }),
          thread("codex", { driver: "codex", lastRunOrdinal: 99 }),
        ],
        providerSessions: [{ id: "ps-new", cwd: "/session" }],
      }),
    ).toEqual({ sessionId: "native-new", cwd: "/session" });
  });

  it("prefers the active thread, falls back to the worktree, and rejects non-Claude", () => {
    expect(
      pickClaudeSession({
        activeProviderThreadId: "old",
        worktreePath: "/wt",
        providerThreads: [thread("old"), thread("new", { lastRunOrdinal: 9 })],
        providerSessions: [],
      }),
    ).toEqual({ sessionId: "native-old", cwd: "/wt" });
    expect(
      pickClaudeSession({
        activeProviderThreadId: null,
        worktreePath: null,
        providerThreads: [thread("c", { driver: "codex" }), thread("n", { nativeThreadRef: null })],
        providerSessions: [],
      }),
    ).toBeNull();
  });
});
