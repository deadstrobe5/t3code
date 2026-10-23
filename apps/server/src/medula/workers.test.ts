// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeProjectFolder,
  isValidWorkerId,
  listWorkers,
  parseWorker,
  readWorkerLog,
  sortWorkers,
  summarizeTranscript,
  titleFromBrief,
} from "./workers.ts";

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "medula-workers-"));
const write = (file: string, body: unknown) =>
  NodeFS.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));

describe("titleFromBrief", () => {
  it("uses the quoted idea when present", () => {
    expect(titleFromBrief("\nIdeia I-23: «SerpApi como nervo».\nÉs o operário O-1.")).toBe(
      "SerpApi como nervo",
    );
  });
  it("falls back to the first line without heading marks", () => {
    expect(titleFromBrief("# Arrumar o painel\n\ntexto")).toBe("Arrumar o painel");
    expect(titleFromBrief("   \n")).toBeNull();
  });
});

describe("parseWorker", () => {
  it("maps the state file fields", () => {
    const worker = parseWorker(
      {
        id: "O-3",
        t: "2026-10-23T03:10:37+01:00",
        modelo: "opus",
        estado: "a-correr",
        ideia: "I-4",
      },
      "O-3",
      "Título",
    );
    expect(worker).toEqual({
      id: "O-3",
      title: "Título",
      model: "opus",
      state: "a-correr",
      idea: "I-4",
      startedAt: "2026-10-23T03:10:37+01:00",
      endedAt: null,
      summary: null,
    });
  });
  it("rejects unsafe ids and non-objects", () => {
    expect(parseWorker({ id: "../x" }, "x", null)).toBeNull();
    expect(parseWorker(null, "O-1", null)).toBeNull();
    expect(isValidWorkerId("O-12")).toBe(true);
    expect(isValidWorkerId("O-1/../../etc")).toBe(false);
  });
});

describe("sortWorkers", () => {
  it("puts running workers first, then newest", () => {
    const base = { title: "", model: null, idea: null, endedAt: null, summary: null };
    const sorted = sortWorkers([
      { ...base, id: "a", state: "acabou", startedAt: "2026-10-23T03:00:00Z" },
      { ...base, id: "b", state: "a-correr", startedAt: "2026-10-23T01:00:00Z" },
      { ...base, id: "c", state: "falhou", startedAt: "2026-10-23T04:00:00Z" },
    ]);
    expect(sorted.map((w) => w.id)).toEqual(["b", "c", "a"]);
  });
});

describe("summarizeTranscript", () => {
  it("keeps assistant text and tool names only", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "olá" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "A ler o código." },
            { type: "tool_use", name: "Bash", input: { description: "Listar ficheiros" } },
          ],
        },
      }),
      "not json",
    ].join("\n");
    expect(summarizeTranscript(lines)).toBe("A ler o código.\n\n→ Bash: Listar ficheiros");
  });
});

describe("listWorkers / readWorkerLog", () => {
  it("reads state files, brief titles and the best available log", async () => {
    const dir = tmp();
    const projects = tmp();
    const sessionCwd = "/w/.t/O-2";
    write(NodePath.join(dir, "O-1.json"), {
      id: "O-1",
      estado: "acabou",
      modelo: "sonnet",
      t: "2026-10-23T01:00:00Z",
      saida: "feito",
    });
    write(NodePath.join(dir, "O-1.brief.md"), "Ideia I-1: «Primeiro»");
    write(NodePath.join(dir, "O-1.out"), "relatório final");
    write(NodePath.join(dir, "O-2.json"), {
      id: "O-2",
      estado: "a-correr",
      modelo: "opus",
      t: "2026-10-23T02:00:00Z",
      sessao_cwd: sessionCwd,
    });
    write(NodePath.join(dir, "O-2.out"), "");
    write(NodePath.join(dir, "ids.trinco"), "");
    const folder = NodePath.join(projects, claudeProjectFolder(sessionCwd));
    NodeFS.mkdirSync(folder);
    write(
      NodePath.join(folder, "s.jsonl"),
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a trabalhar" }] } })}\n`,
    );

    const workers = await listWorkers(dir);
    expect(workers.map((w) => [w.id, w.title, w.state])).toEqual([
      ["O-2", "O-2", "a-correr"],
      ["O-1", "Primeiro", "acabou"],
    ]);

    expect(await readWorkerLog(dir, "O-1", projects)).toEqual({
      id: "O-1",
      source: "out",
      text: "relatório final",
    });
    expect(await readWorkerLog(dir, "O-2", projects)).toEqual({
      id: "O-2",
      source: "transcript",
      text: "a trabalhar",
    });
    expect(await readWorkerLog(dir, "../O-1", projects)).toBeNull();
    expect(await readWorkerLog(dir, "O-9", projects)).toBeNull();
    expect(await listWorkers(NodePath.join(dir, "nope"))).toEqual([]);
  });
});
