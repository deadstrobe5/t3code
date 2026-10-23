import { describe, expect, it } from "vite-plus/test";

import {
  countUnseenMedulaItems,
  mergeMedulaItems,
  parseMedulaMessage,
  resolveMedulaBaseUrl,
} from "./medulaFeed";

const NOW = Date.parse("2026-10-23T02:00:00Z");

describe("resolveMedulaBaseUrl", () => {
  it("defaults to the page's host on the hub port so remote browsers reach the server", () => {
    expect(resolveMedulaBaseUrl("", { protocol: "http:", hostname: "100.64.0.9" })).toBe(
      "http://100.64.0.9:8800/",
    );
    expect(resolveMedulaBaseUrl("  ", { protocol: "http:", hostname: "127.0.0.1" })).toBe(
      "http://127.0.0.1:8800/",
    );
  });

  it("falls back to loopback outside a web page", () => {
    expect(resolveMedulaBaseUrl("", { protocol: "t3:", hostname: "" })).toBe(
      "http://127.0.0.1:8800/",
    );
    expect(resolveMedulaBaseUrl("", null)).toBe("http://127.0.0.1:8800/");
  });

  it("keeps an explicit URL and adds the trailing slash relative paths need", () => {
    expect(resolveMedulaBaseUrl("http://hub.local:9000/painel", null)).toBe(
      "http://hub.local:9000/painel/",
    );
  });
});

describe("parseMedulaMessage", () => {
  it("reads a named block event with one item", () => {
    const [item] = parseMedulaMessage(
      "ideias",
      JSON.stringify({
        id: "I-3",
        t: "2026-10-23T02:59:00+01:00",
        texto: "Arruma o painel",
        estado: "nova",
      }),
      NOW,
    );
    expect(item).toMatchObject({
      block: "ideias",
      text: "Arruma o painel",
      detail: "I-3 · nova",
      at: Date.parse("2026-10-23T01:59:00Z"),
    });
  });

  it("reads a snapshot keyed by block, with epoch seconds", () => {
    const items = parseMedulaMessage(
      "message",
      JSON.stringify({
        pensamentos: [{ t: 1792719000, sessao: "s1", texto: "A ver os logs" }],
        mordomo: [
          { t: 1792719006.2, taskId: "a1", descricao: "Mordomo: testes", resumo: "Um teste falha" },
        ],
      }),
      NOW,
    );
    expect(items.map((item) => [item.block, item.text, item.at])).toEqual([
      ["pensamentos", "A ver os logs", 1792719000000],
      ["mordomo", "Um teste falha", 1792719006200],
    ]);
    expect(items[1]?.detail).toBe("a1 · Mordomo: testes");
  });

  it("reads the hub's estado snapshot: columns of ideas and lines of thoughts and digests", () => {
    const data = JSON.stringify({
      boletim: { texto: "not a feed block" },
      ideias: {
        colunas: {
          espera: [{ id: "I-2", t: 1_700_000_100, texto: "second idea", nota: null }],
          feito: [{ id: "I-1", t: 1_700_000_000, texto: "first idea", nota: "done" }],
        },
        totais: { espera: 1, feito: 1 },
      },
      pensamentos: { linhas: [{ t: 1_700_000_050, sessao: "abc", texto: "a thought" }] },
      mordomo: {
        linhas: [{ t: 1_700_000_060.5, tarefa: "t1", descricao: "Task", resumo: "what it did" }],
      },
    });
    const items = parseMedulaMessage("estado", data, 0);
    expect(items.map((item) => [item.block, item.text, item.detail])).toEqual([
      ["ideias", "second idea", "I-2 · espera"],
      ["ideias", "first idea", "I-1 · feito · done"],
      ["pensamentos", "a thought", null],
      ["mordomo", "what it did", "Task"],
    ]);
    expect(items[3]!.at).toBe(1_700_000_060_500);
  });

  it("reads an unnamed message tagged with its block", () => {
    const items = parseMedulaMessage(
      "message",
      JSON.stringify({ bloco: "mordomo", item: { resumo: "Feito", t: 1792719000 } }),
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.block).toBe("mordomo");
  });

  it("ignores pings and shapes it does not know", () => {
    expect(parseMedulaMessage("message", "ping", NOW)).toEqual([]);
    expect(parseMedulaMessage("message", JSON.stringify({ ok: true }), NOW)).toEqual([]);
    expect(parseMedulaMessage("ideias", JSON.stringify({ sem: "texto" }), NOW)).toEqual([]);
  });

  it("gives a replayed item the same key, and a state change a new one", () => {
    const raw = { id: "I-1", t: "2026-10-23T01:00:00Z", texto: "x", estado: "nova" };
    const [first] = parseMedulaMessage("ideias", JSON.stringify(raw), NOW);
    const [again] = parseMedulaMessage("ideias", JSON.stringify(raw), NOW + 5000);
    const [done] = parseMedulaMessage(
      "ideias",
      JSON.stringify({ ...raw, estado: "feita", t_estado: "2026-10-23T01:30:00Z" }),
      NOW,
    );
    expect(again?.key).toBe(first?.key);
    expect(done?.key).not.toBe(first?.key);
  });
});

describe("mergeMedulaItems and countUnseenMedulaItems", () => {
  const item = (key: string, at: number) =>
    ({ key, block: "ideias", at, text: key, detail: null }) as const;

  it("orders newest first, drops duplicates and caps the list", () => {
    const current = [item("b", 2)];
    const merged = mergeMedulaItems(current, [item("a", 1), item("b", 2), item("c", 3)], 2);
    expect(merged.map((entry) => entry.key)).toEqual(["c", "b"]);
    expect(mergeMedulaItems(current, [item("b", 2)])).toBe(current);
  });

  it("counts only items newer than the last seen mark", () => {
    expect(countUnseenMedulaItems([item("a", 5), item("b", 10), item("c", 11)], 10)).toBe(1);
  });
});
