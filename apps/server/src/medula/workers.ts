// @effect-diagnostics nodeBuiltinImport:off
/**
 * Medula workers: background agents launched outside a T3 conversation that
 * leave one `<id>.json` state file each in a directory. The directory comes
 * from `T3CODE_MEDULA_WORKERS_DIR`; when unset the feature is off.
 *
 * Everything here is plain Node so it can be unit-tested without the server.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const MEDULA_WORKERS_DIR_ENV = "T3CODE_MEDULA_WORKERS_DIR";
export const MEDULA_WORKERS_PATH = "/api/medula/workers";
export const MEDULA_WORKER_LOG_PATH = "/api/medula/worker-log";

const WORKER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WORKERS = 50;
const LOG_TAIL_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MAX_LOG_ENTRIES = 40;

export interface MedulaWorker {
  readonly id: string;
  readonly title: string;
  readonly model: string | null;
  readonly state: string;
  readonly idea: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly summary: string | null;
}

export interface MedulaWorkerLog {
  readonly id: string;
  readonly source: "out" | "transcript" | "err" | "none";
  readonly text: string;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export function isValidWorkerId(id: string): boolean {
  return WORKER_ID.test(id);
}

/** First line of a brief, reduced to a short human title. */
export function titleFromBrief(brief: string): string | null {
  const firstLine = brief
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (!firstLine) return null;
  const quoted = /«([^»]+)»/.exec(firstLine);
  const title = (quoted ? quoted[1]! : firstLine.replace(/^#+\s*/, "")).trim();
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

export function parseWorker(
  raw: unknown,
  fallbackId: string,
  briefTitle: string | null,
): MedulaWorker | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = str(record.id) ?? fallbackId;
  if (!isValidWorkerId(id)) return null;
  const summary = str(record.saida) ?? str(record.motivo) ?? str(record.nota);
  return {
    id,
    title: briefTitle ?? str(record.titulo) ?? str(record.title) ?? id,
    model: str(record.modelo) ?? str(record.model),
    state: str(record.estado) ?? str(record.state) ?? "desconhecido",
    idea: str(record.ideia),
    startedAt: str(record.t),
    endedAt: str(record.t_fim),
    summary: summary && summary.length > 400 ? `${summary.slice(0, 399)}…` : summary,
  };
}

/** Running workers first, then the most recent. */
export function sortWorkers(workers: ReadonlyArray<MedulaWorker>): MedulaWorker[] {
  const time = (w: MedulaWorker) => (w.startedAt ? Date.parse(w.startedAt) || 0 : 0);
  return [...workers].sort((a, b) => {
    const running = Number(b.state === "a-correr") - Number(a.state === "a-correr");
    return running !== 0 ? running : time(b) - time(a);
  });
}

/** Turns a Claude Code transcript (jsonl) into a readable tail. */
export function summarizeTranscript(jsonl: string): string {
  const entries: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; message?: { content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
    for (const part of event.message.content as Array<Record<string, unknown>>) {
      if (part.type === "text" && str(part.text)) {
        entries.push((part.text as string).trim());
      } else if (part.type === "tool_use" && str(part.name)) {
        const input = part.input as Record<string, unknown> | undefined;
        const hint = str(input?.description) ?? str(input?.command) ?? str(input?.file_path);
        entries.push(
          `→ ${part.name as string}${hint ? `: ${hint.split("\n")[0]!.slice(0, 160)}` : ""}`,
        );
      }
    }
  }
  return entries.slice(-MAX_LOG_ENTRIES).join("\n\n");
}

/** `/a/.b/c` → `-a--b-c`, the folder name Claude Code uses for a cwd. */
export function claudeProjectFolder(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

async function readTail(file: string, bytes: number): Promise<string | null> {
  try {
    const handle = await NodeFSP.open(file, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function newestJsonl(dir: string): Promise<string | null> {
  try {
    const names = (await NodeFSP.readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    const stats = await Promise.all(
      names.map(async (name) => {
        const file = NodePath.join(dir, name);
        return { file, mtime: (await NodeFSP.stat(file)).mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats[0]?.file ?? null;
  } catch {
    return null;
  }
}

export async function listWorkers(dir: string): Promise<MedulaWorker[]> {
  let names: string[];
  try {
    names = (await NodeFSP.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const withTime = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, mtime: (await NodeFSP.stat(NodePath.join(dir, name))).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    }),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  const workers = await Promise.all(
    withTime.slice(0, MAX_WORKERS).map(async ({ name }) => {
      const id = name.slice(0, -".json".length);
      try {
        const raw = JSON.parse(await NodeFSP.readFile(NodePath.join(dir, name), "utf8"));
        const briefPath =
          str((raw as Record<string, unknown>).brief) ?? NodePath.join(dir, `${id}.brief.md`);
        const brief = await readTail(briefPath, 4096).then((text) =>
          text === null ? null : titleFromBrief(text),
        );
        return parseWorker(raw, id, brief);
      } catch {
        return null;
      }
    }),
  );
  return sortWorkers(workers.filter((w): w is MedulaWorker => w !== null));
}

export async function readWorkerLog(
  dir: string,
  id: string,
  claudeProjectsDir = NodePath.join(
    process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
  ),
): Promise<MedulaWorkerLog | null> {
  if (!isValidWorkerId(id)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await NodeFSP.readFile(NodePath.join(dir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
  const out = await readTail(NodePath.join(dir, `${id}.out`), LOG_TAIL_BYTES);
  if (out && out.trim() !== "") return { id, source: "out", text: out };

  const sessionCwd = str(raw.sessao_cwd);
  const transcript =
    str(raw.transcript) ??
    (sessionCwd
      ? await newestJsonl(NodePath.join(claudeProjectsDir, claudeProjectFolder(sessionCwd)))
      : null);
  if (transcript) {
    const tail = await readTail(transcript, TRANSCRIPT_TAIL_BYTES);
    const text = tail ? summarizeTranscript(tail) : "";
    if (text !== "") return { id, source: "transcript", text };
  }

  const err = await readTail(NodePath.join(dir, `${id}.err`), LOG_TAIL_BYTES);
  if (err && err.trim() !== "") return { id, source: "err", text: err };
  return { id, source: "none", text: str(raw.saida) ?? "" };
}
