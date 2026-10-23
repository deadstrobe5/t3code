// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node module, no Effect runtime.
/**
 * Medula context: what Claude Code hooks and the harness injected into a
 * thread's Claude session, read from the session transcript (`.jsonl`).
 *
 * Transcripts grow to hundreds of megabytes, so a file is never read whole:
 * the first request reads only the tail, and later requests read only the
 * bytes appended since, on top of a small per-file state kept in memory.
 *
 * Everything here is plain Node so it can be unit-tested without the server.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { claudeProjectFolder } from "./workers.ts";

export const MEDULA_CONTEXT_PATH = "/api/medula/context";

export const CONTEXT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_GROUPS = 15;
const MAX_CACHED_FILES = 20;
const MAX_CACHED_PATHS = 500;
const TEXT_LIMIT = 100_000;
const PROMPT_LIMIT = 500;
const LABEL_LIMIT = 120;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type MedulaContextOrigin =
  | "hora"
  | "mordomo"
  | "canalizador"
  | "correcao"
  | "ideias"
  | "hook"
  | "stop"
  | "notificacao"
  | "compactacao"
  | "sistema";

export interface MedulaContextBlock {
  readonly id: string;
  readonly at: string;
  readonly origin: MedulaContextOrigin;
  readonly event: string | null;
  readonly label: string;
  readonly chars: number;
  readonly text: string;
  readonly truncated: boolean;
}

export interface MedulaContextGroup {
  readonly id: string;
  readonly at: string;
  readonly prompt: string | null;
  readonly blocks: MedulaContextBlock[];
}

export type MedulaContextResponse =
  | {
      readonly available: false;
      readonly reason: "no-claude-session" | "transcript-missing" | "thread-not-found";
    }
  | {
      readonly available: true;
      readonly sessionId: string;
      readonly updatedAt: string;
      readonly latestBlockAt: string | null;
      readonly sinceLastPrompt: { readonly blocks: number; readonly chars: number };
      readonly groups?: MedulaContextGroup[];
    };

// ── Classification ──────────────────────────────────────────────────────────

type Entry = Record<string, unknown>;

interface Draft {
  readonly origin: MedulaContextOrigin;
  readonly event: string | null;
  readonly label: string;
  readonly text: string;
  /** Notifications arrive twice (queued attachment + user message). */
  readonly dedupeKey?: string;
}

const isRecord = (value: unknown): value is Entry =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** Text of a user message: the string itself or its `text` parts. */
function userText(entry: Entry): { text: string | null; toolResult: boolean } {
  const message = isRecord(entry.message) ? entry.message : null;
  const content = message?.content;
  if (typeof content === "string") return { text: content, toolResult: false };
  if (!Array.isArray(content)) return { text: null, toolResult: false };
  const parts: string[] = [];
  let toolResult = false;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "tool_result") toolResult = true;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return { text: parts.length > 0 ? parts.join("\n") : null, toolResult };
}

const isTaskNotificationText = (text: string) => text.trimStart().startsWith("<task-notification>");

/** The operator's own message, which opens a group; null for anything else. */
function operatorPrompt(entry: Entry): string | null {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) {
    return null;
  }
  if (isRecord(entry.origin) && entry.origin.kind === "task-notification") return null;
  const { text, toolResult } = userText(entry);
  if (text === null || toolResult || isTaskNotificationText(text)) return null;
  return text;
}

const tag = (text: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null;

const STATUS_LABEL: Record<string, string> = {
  completed: "Tarefa terminou",
  failed: "Tarefa falhou",
  killed: "Tarefa parada",
  stopped: "Tarefa parada",
  cancelled: "Tarefa parada",
};

function notificationDraft(text: string): Draft {
  const taskId = tag(text, "task-id");
  const status = tag(text, "status");
  const summary = tag(text, "summary");
  const name = summary ? (/"([^"]+)"/.exec(summary)?.[1] ?? summary) : taskId;
  const word = (status && STATUS_LABEL[status]) ?? "Tarefa";
  const result = tag(text, "result") ?? "";
  return {
    origin: "notificacao",
    event: "task-notification",
    label: clip(name ? `${word}: ${name}` : word, LABEL_LIMIT),
    text,
    ...(taskId ? { dedupeKey: `${taskId}|${status ?? ""}|${result.slice(0, 200)}` } : {}),
  };
}

const PROMPT_PREFIXES: ReadonlyArray<readonly [RegExp, MedulaContextOrigin]> = [
  [/^Agora:/, "hora"],
  [/^Mordomo · Canalizador:/, "canalizador"],
  [/^Mordomo(?::| · )/, "mordomo"],
  [/^(?:Correção registada|Isto parece uma correção)/, "correcao"],
  [/^(?:Caixa de ideias|Ideias por despachar)/, "ideias"],
];

function promptBlockLabel(origin: MedulaContextOrigin, firstLine: string, event: string): string {
  switch (origin) {
    case "hora":
      return "Hora e conta";
    case "canalizador":
      return "Mordomo · Canalizador";
    case "mordomo": {
      if (!firstLine.startsWith("Mordomo · ")) return "Mordomo";
      const rest = firstLine.slice("Mordomo · ".length);
      const cut = rest.indexOf(": ");
      return clip(`Mordomo · ${cut > 0 ? rest.slice(0, cut) : rest}`, LABEL_LIMIT);
    }
    case "correcao":
      return firstLine.startsWith("Isto parece") ? "Possível correção" : "Correção registada";
    case "ideias":
      return firstLine.startsWith("Caixa") ? "Caixa de ideias" : "Ideias por despachar";
    default:
      return `Hook · ${event}`;
  }
}

/** Splits the UserPromptSubmit context into its sources by line prefix. */
export function splitUserPromptSubmit(text: string, event: string): Draft[] {
  const parts: Array<{ origin: MedulaContextOrigin; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    const known = PROMPT_PREFIXES.find(([prefix]) => prefix.test(line));
    const current = parts.at(-1);
    if (known) parts.push({ origin: known[1], lines: [line] });
    else if (current) current.lines.push(line);
    else parts.push({ origin: "hook", lines: [line] });
  }
  return parts.flatMap(({ origin, lines }) => {
    const body = lines.join("\n").trim();
    if (body === "") return [];
    return [{ origin, event, label: promptBlockLabel(origin, lines[0] ?? "", event), text: body }];
  });
}

const SYSTEM_LABEL: Record<string, string> = {
  date: "Data",
  instructions: "Instruções (CLAUDE.md)",
  skill_listing: "Lista de skills",
  agent_listing_delta: "Lista de agentes",
  deferred_tools_delta: "Ferramentas adiadas",
  mcp_instructions_delta: "Instruções dos servidores MCP",
  output_style: "Estilo de saída",
  output_style_instructions: "Instruções do estilo de saída",
  silent_turn_reminder: "Lembrete: dizer o que está a fazer",
  environment: "Ambiente",
  model: "Modelo",
  auto_mode: "Modo de permissões",
  invoked_skills: "Skills invocadas",
  compact_file_reference: "Ficheiro lido antes da compactação",
  file: "Ficheiro",
  remote_session_change: "Atribuição de commits",
};

const stripReminder = (text: string) =>
  text
    .replace(/^\s*<system-reminder>\s*/, "")
    .replace(/\s*<\/system-reminder>\s*$/, "")
    .trim();

function renderedText(entry: Entry): string | null {
  if (!Array.isArray(entry.rendered)) return null;
  const parts = entry.rendered
    .map((part) => (isRecord(part) && typeof part.content === "string" ? part.content : null))
    .filter((part): part is string => part !== null)
    .map(stripReminder)
    .filter((part) => part !== "");
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function attachmentDrafts(entry: Entry, attachment: Entry): Draft[] {
  const type = str(attachment.type) ?? "attachment";
  switch (type) {
    case "hook_additional_context": {
      const event = str(attachment.hookName) ?? str(attachment.hookEvent);
      const content = attachment.content;
      const text = Array.isArray(content)
        ? content.filter((part) => typeof part === "string").join("\n")
        : typeof content === "string"
          ? content
          : "";
      if (text.trim() === "") return [];
      if ((str(attachment.hookEvent) ?? event) === "UserPromptSubmit") {
        return splitUserPromptSubmit(text, event ?? "UserPromptSubmit");
      }
      return [{ origin: "hook", event, label: `Hook · ${event ?? "?"}`, text }];
    }
    case "hook_blocking_error": {
      const event = str(attachment.hookName) ?? str(attachment.hookEvent);
      const error = attachment.blockingError;
      const text = isRecord(error)
        ? (str(error.blockingError) ?? "")
        : typeof error === "string"
          ? error
          : "";
      if (text === "") return [];
      const isStop = (str(attachment.hookEvent) ?? event) === "Stop";
      return [
        {
          origin: isStop ? "stop" : "hook",
          event,
          label: isStop ? "Stop · devolvido ao modelo" : `Hook · ${event ?? "?"}`,
          text,
        },
      ];
    }
    case "queued_command": {
      const prompt = str(attachment.prompt);
      return prompt && isTaskNotificationText(prompt) ? [notificationDraft(prompt)] : [];
    }
    default: {
      // hook_success repeats what hook_additional_context already carries.
      if (type.startsWith("hook_")) return [];
      const text = renderedText(entry);
      if (text === null) return [];
      const description = type === "task_status" ? str(attachment.description) : null;
      const label = description
        ? clip(`Estado da tarefa: ${description}`, LABEL_LIMIT)
        : (SYSTEM_LABEL[type] ?? type);
      return [{ origin: "sistema", event: type, label, text }];
    }
  }
}

/** The context blocks one transcript entry contributes (none for most). */
export function classifyEntry(entry: Entry): Draft[] {
  if (entry.type === "attachment") {
    return isRecord(entry.attachment) ? attachmentDrafts(entry, entry.attachment) : [];
  }
  if (entry.type === "user") {
    const { text } = userText(entry);
    if (text === null) return [];
    if (entry.isCompactSummary === true) {
      return [{ origin: "compactacao", event: null, label: "Resumo da compactação", text }];
    }
    const isNotification =
      (isRecord(entry.origin) && entry.origin.kind === "task-notification") ||
      isTaskNotificationText(text);
    return isNotification ? [notificationDraft(text)] : [];
  }
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    const meta = isRecord(entry.compactMetadata) ? entry.compactMetadata : {};
    const pre = typeof meta.preTokens === "number" ? meta.preTokens : null;
    const post = typeof meta.postTokens === "number" ? meta.postTokens : null;
    const trigger = str(meta.trigger);
    const text = [
      `Conversa compactada${trigger ? ` (${trigger})` : ""}.`,
      `preTokens: ${pre ?? "?"}`,
      `postTokens: ${post ?? "?"}`,
    ].join("\n");
    return [
      { origin: "compactacao", event: "compact_boundary", label: "Conversa compactada", text },
    ];
  }
  return [];
}

// ── Grouping ────────────────────────────────────────────────────────────────

interface GroupState extends MedulaContextGroup {
  readonly seen: Set<string>;
}

export interface ContextParseState {
  groups: GroupState[];
}

export const createContextParseState = (): ContextParseState => ({ groups: [] });

// Cheap pre-filter: only these entry kinds can matter. Nested JSON inside
// strings is escaped, so assistant text cannot fake these.
const RELEVANT = /"type":"(?:user|attachment)"|"subtype":"compact_boundary"/;

/**
 * Classifies and groups complete transcript lines into `state`. Each operator
 * message opens a group; everything after it, up to the next, joins it.
 */
export function parseContextLines(lines: Iterable<string>, state: ContextParseState): void {
  for (const line of lines) {
    if (!line.startsWith("{") || !RELEVANT.test(line)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.isSidechain === true) continue;
    const at = str(entry.timestamp) ?? "";
    const uuid = str(entry.uuid) ?? `${at}#${state.groups.length}`;
    const prompt = operatorPrompt(entry);
    if (prompt !== null) {
      state.groups.push({
        id: uuid,
        at,
        prompt: clip(prompt, PROMPT_LIMIT),
        blocks: [],
        seen: new Set(),
      });
      if (state.groups.length > MAX_GROUPS)
        state.groups.splice(0, state.groups.length - MAX_GROUPS);
      continue;
    }
    const drafts = classifyEntry(entry);
    if (drafts.length === 0) continue;
    let group = state.groups.at(-1);
    if (group === undefined) {
      group = { id: "inicio", at, prompt: null, blocks: [], seen: new Set() };
      state.groups.push(group);
    }
    drafts.forEach((draft, index) => {
      if (draft.dedupeKey !== undefined) {
        if (group.seen.has(draft.dedupeKey)) return;
        group.seen.add(draft.dedupeKey);
      }
      group.blocks.push({
        id: drafts.length > 1 ? `${uuid}:${index}` : uuid,
        at,
        origin: draft.origin,
        event: draft.event,
        label: draft.label,
        chars: draft.text.length,
        text: draft.text.length > TEXT_LIMIT ? draft.text.slice(0, TEXT_LIMIT) : draft.text,
        truncated: draft.text.length > TEXT_LIMIT,
      });
    });
  }
}

export const contextGroups = (state: ContextParseState): MedulaContextGroup[] =>
  state.groups.map(({ id, at, prompt, blocks }) => ({ id, at, prompt, blocks: [...blocks] }));

// ── Transcript files ────────────────────────────────────────────────────────

export const claudeConfigDir = (): string =>
  process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(NodeOS.homedir(), ".claude");

const isFile = (file: string) =>
  NodeFSP.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );

const pathCache = new Map<string, string>();

/**
 * `<claudeDir>/projects/<encoded cwd>/<sessionId>.jsonl`; when it is not
 * there (the cwd moved, or is unknown), the first project folder holding the
 * session. Hits are cached.
 */
export async function transcriptPathFor(
  claudeDir: string,
  cwd: string | null,
  sessionId: string,
): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const projects = NodePath.join(claudeDir, "projects");
  const cacheKey = `${projects}\0${sessionId}`;
  const cached = pathCache.get(cacheKey);
  if (cached !== undefined && (await isFile(cached))) return cached;
  pathCache.delete(cacheKey);

  const remember = (file: string) => {
    pathCache.set(cacheKey, file);
    if (pathCache.size > MAX_CACHED_PATHS) {
      pathCache.delete(pathCache.keys().next().value as string);
    }
    return file;
  };
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = NodePath.join(projects, claudeProjectFolder(cwd), name);
    if (await isFile(direct)) return remember(direct);
  }
  let folders: string[];
  try {
    folders = await NodeFSP.readdir(projects);
  } catch {
    return null;
  }
  for (let start = 0; start < folders.length; start += 64) {
    const batch = folders
      .slice(start, start + 64)
      .map((folder) => NodePath.join(projects, folder, name));
    const found = (await Promise.all(batch.map(isFile))).findIndex(Boolean);
    if (found !== -1) return remember(batch[found]!);
  }
  return null;
}

interface FileState {
  ino: number;
  offset: number;
  pending: Buffer;
  mtimeMs: number;
  parse: ContextParseState;
}

const fileStates = new Map<string, FileState>();
const fileLocks = new Map<string, Promise<unknown>>();

/** Drops every cached file and path (tests). */
export function resetContextCache(): void {
  fileStates.clear();
  fileLocks.clear();
  pathCache.clear();
}

async function readRange(handle: NodeFSP.FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === buffer.length ? buffer : buffer.subarray(0, filled);
}

/** Complete lines of `chunk`; the trailing partial line goes back as `rest`. */
function splitLines(chunk: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let start = 0;
  for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
    if (index > start) lines.push(chunk.toString("utf8", start, index));
    start = index + 1;
  }
  return { lines, rest: Buffer.from(chunk.subarray(start)) };
}

async function updateFileState(
  file: string,
  tailBytes: number,
): Promise<{ state: FileState } | null> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(file, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    let state = fileStates.get(file);
    const stale =
      state === undefined ||
      state.ino !== stat.ino ||
      stat.size < state.offset ||
      stat.size - state.offset > tailBytes;
    if (state === undefined || stale) {
      const start = Math.max(0, stat.size - tailBytes);
      const read = await readRange(handle, start, stat.size);
      let chunk = read;
      if (start > 0) {
        const newline = chunk.indexOf(10);
        chunk = newline === -1 ? Buffer.alloc(0) : chunk.subarray(newline + 1);
      }
      const { lines, rest } = splitLines(chunk);
      state = {
        ino: stat.ino,
        offset: start + read.length,
        pending: rest,
        mtimeMs: stat.mtimeMs,
        parse: createContextParseState(),
      };
      parseContextLines(lines, state.parse);
    } else if (stat.size > state.offset) {
      const appended = await readRange(handle, state.offset, stat.size);
      const { lines, rest } = splitLines(Buffer.concat([state.pending, appended]));
      parseContextLines(lines, state.parse);
      state.pending = rest;
      state.offset = state.offset + appended.length;
      state.mtimeMs = stat.mtimeMs;
    } else {
      state.mtimeMs = stat.mtimeMs;
    }
    fileStates.delete(file);
    fileStates.set(file, state);
    while (fileStates.size > MAX_CACHED_FILES) {
      fileStates.delete(fileStates.keys().next().value as string);
    }
    return { state };
  } finally {
    await handle.close();
  }
}

/**
 * Groups of injected context in a transcript, reading only its tail the first
 * time and only appended bytes afterwards. Null when the file cannot be read.
 */
export function readTranscriptContext(
  file: string,
  options: { readonly tailBytes?: number } = {},
): Promise<{ groups: MedulaContextGroup[]; mtimeMs: number } | null> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => updateFileState(file, options.tailBytes ?? CONTEXT_TAIL_BYTES))
    .then((result) =>
      result === null
        ? null
        : { groups: contextGroups(result.state.parse), mtimeMs: result.state.mtimeMs },
    );
  fileLocks.set(file, run);
  void run.finally(() => {
    if (fileLocks.get(file) === run) fileLocks.delete(file);
  });
  return run;
}

export interface ContextProviderThread {
  readonly id: string;
  readonly driver: string;
  readonly providerSessionId: string | null;
  readonly ownerNodeId: string | null;
  readonly nativeThreadRef: { readonly nativeId: string | null } | null;
  readonly lastRunOrdinal: number | null;
}

/**
 * The thread's root Claude session: a Claude provider thread with no owner
 * node and a native session id, the active one if it qualifies, else the one
 * that ran last. Its cwd comes from the provider session, else the worktree.
 */
export function pickClaudeSession(input: {
  readonly activeProviderThreadId: string | null;
  readonly worktreePath: string | null;
  readonly providerThreads: ReadonlyArray<ContextProviderThread>;
  readonly providerSessions: ReadonlyArray<{ readonly id: string; readonly cwd: string }>;
}): { sessionId: string; cwd: string | null } | null {
  const candidates = input.providerThreads.filter(
    (thread) =>
      /claude/i.test(thread.driver) &&
      thread.ownerNodeId === null &&
      typeof thread.nativeThreadRef?.nativeId === "string",
  );
  const chosen =
    candidates.find((thread) => thread.id === input.activeProviderThreadId) ??
    candidates.toSorted((a, b) => (b.lastRunOrdinal ?? 0) - (a.lastRunOrdinal ?? 0))[0];
  const sessionId = chosen?.nativeThreadRef?.nativeId;
  if (!chosen || !sessionId) return null;
  const session = input.providerSessions.find((s) => s.id === chosen.providerSessionId);
  return { sessionId, cwd: session?.cwd ?? input.worktreePath };
}

export async function readThreadContext(input: {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly summary?: boolean;
  readonly claudeDir?: string;
  readonly tailBytes?: number;
}): Promise<MedulaContextResponse> {
  const file = await transcriptPathFor(
    input.claudeDir ?? claudeConfigDir(),
    input.cwd,
    input.sessionId,
  );
  const read =
    file === null
      ? null
      : await readTranscriptContext(
          file,
          input.tailBytes === undefined ? {} : { tailBytes: input.tailBytes },
        );
  if (read === null) return { available: false, reason: "transcript-missing" };
  const last = read.groups.at(-1);
  const latestBlockAt =
    read.groups.findLast((group) => group.blocks.length > 0)?.blocks.at(-1)?.at ?? null;
  return {
    available: true,
    sessionId: input.sessionId,
    updatedAt: new Date(read.mtimeMs).toISOString(),
    latestBlockAt,
    sinceLastPrompt: {
      blocks: last?.blocks.length ?? 0,
      chars: last?.blocks.reduce((sum, block) => sum + block.chars, 0) ?? 0,
    },
    ...(input.summary ? {} : { groups: read.groups }),
  };
}
