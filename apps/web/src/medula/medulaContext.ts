/**
 * What entered the current Claude session besides the operator's own messages (hooks, the
 * butler, notifications, system reminders), read from `GET /api/medula/context`.
 *
 * Pure logic only: response validation, filtering, labels and the per-thread "seen" mark.
 */

export const MEDULA_CONTEXT_ORIGINS = [
  "mordomo",
  "canalizador",
  "correcao",
  "ideias",
  "notificacao",
  "stop",
  "hook",
  "compactacao",
  "hora",
  "sistema",
] as const;
export type MedulaContextOrigin = (typeof MEDULA_CONTEXT_ORIGINS)[number];

/** Boilerplate (system reminders) stays hidden until asked for. */
export const MEDULA_CONTEXT_DEFAULT_ORIGINS: MedulaContextOrigin[] = MEDULA_CONTEXT_ORIGINS.filter(
  (origin) => origin !== "sistema",
);

export const MEDULA_CONTEXT_ORIGIN_LABELS: Record<MedulaContextOrigin, string> = {
  hora: "Hora",
  mordomo: "Mordomo",
  canalizador: "Canalizador",
  correcao: "Correção",
  ideias: "Ideias",
  hook: "Hook",
  stop: "Stop",
  notificacao: "Notificação",
  compactacao: "Compactação",
  sistema: "Sistema",
};

export const MEDULA_CONTEXT_POLL_MS = 10_000;
export const MEDULA_CONTEXT_SUMMARY_POLL_MS = 20_000;
export const MEDULA_CONTEXT_START_GROUP_ID = "inicio";

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
  readonly blocks: ReadonlyArray<MedulaContextBlock>;
}

export type MedulaContextUnavailableReason =
  | "no-claude-session"
  | "transcript-missing"
  | "thread-not-found";

export type MedulaContextResponse =
  | { readonly available: false; readonly reason: MedulaContextUnavailableReason }
  | {
      readonly available: true;
      readonly sessionId: string;
      readonly updatedAt: string;
      readonly latestBlockAt: string | null;
      readonly sinceLastPrompt: { readonly blocks: number; readonly chars: number };
      /** Oldest first, as sent; absent in summary responses. */
      readonly groups: ReadonlyArray<MedulaContextGroup> | null;
    };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseOrigin(value: unknown): MedulaContextOrigin {
  // An origin this client does not know yet still shows, as a generic hook.
  return (MEDULA_CONTEXT_ORIGINS as readonly unknown[]).includes(value)
    ? (value as MedulaContextOrigin)
    : "hook";
}

function parseBlock(value: unknown, index: number): MedulaContextBlock | null {
  if (!isRecord(value)) return null;
  const text = str(value.text);
  const at = str(value.at);
  return {
    id: str(value.id) || `${at}#${index}`,
    at,
    origin: parseOrigin(value.origin),
    event: strOrNull(value.event),
    label: str(value.label).trim() || strOrNull(value.event) || "Sem título",
    chars: count(value.chars) || text.length,
    text,
    truncated: value.truncated === true,
  };
}

function parseGroup(value: unknown, index: number): MedulaContextGroup | null {
  if (!isRecord(value)) return null;
  const blocks = Array.isArray(value.blocks)
    ? value.blocks
        .map((block, blockIndex) => parseBlock(block, blockIndex))
        .filter((block): block is MedulaContextBlock => block !== null)
    : [];
  return {
    id: str(value.id) || `grupo-${index}`,
    at: str(value.at),
    prompt: strOrNull(value.prompt),
    blocks,
  };
}

const UNAVAILABLE_REASONS: readonly MedulaContextUnavailableReason[] = [
  "no-claude-session",
  "transcript-missing",
  "thread-not-found",
];

/** Validates the server's answer; null when it is not a context response at all. */
export function parseMedulaContextResponse(value: unknown): MedulaContextResponse | null {
  if (!isRecord(value)) return null;
  if (value.available === false) {
    const reason = (UNAVAILABLE_REASONS as readonly unknown[]).includes(value.reason)
      ? (value.reason as MedulaContextUnavailableReason)
      : "transcript-missing";
    return { available: false, reason };
  }
  if (value.available !== true) return null;
  const since = isRecord(value.sinceLastPrompt) ? value.sinceLastPrompt : {};
  return {
    available: true,
    sessionId: str(value.sessionId),
    updatedAt: str(value.updatedAt),
    latestBlockAt: strOrNull(value.latestBlockAt),
    sinceLastPrompt: { blocks: count(since.blocks), chars: count(since.chars) },
    groups: Array.isArray(value.groups)
      ? value.groups
          .map((group, index) => parseGroup(group, index))
          .filter((group): group is MedulaContextGroup => group !== null)
      : null,
  };
}

export const MEDULA_CONTEXT_UNAVAILABLE_LABELS: Record<MedulaContextUnavailableReason, string> = {
  "no-claude-session": "Esta conversa não tem sessão Claude.",
  "transcript-missing": "Transcrição não encontrada.",
  "thread-not-found": "Conversa não encontrada no servidor.",
};

const decimal = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });

/** `850 chars`, `1,2 k chars`, `123 k chars`. */
export function formatMedulaChars(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  const thousands = chars / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : decimal.format(thousands)} k chars`;
}

export function formatMedulaContextSummary(since: { blocks: number; chars: number }): string {
  if (since.blocks === 0) return "Desde a última mensagem não entrou nada.";
  const verb = since.blocks === 1 ? "entrou 1 bloco" : `entraram ${since.blocks} blocos`;
  return `Desde a última mensagem ${verb} · ${formatMedulaChars(since.chars)}`;
}

export interface MedulaContextFilter {
  readonly origins: ReadonlyArray<MedulaContextOrigin>;
  readonly query: string;
}

export interface MedulaContextGroupView {
  readonly group: MedulaContextGroup;
  readonly blocks: ReadonlyArray<MedulaContextBlock>;
  /** Blocks of this group the filter left out. */
  readonly hidden: number;
}

function matchesQuery(block: MedulaContextBlock, needle: string): boolean {
  return (
    block.label.toLowerCase().includes(needle) ||
    block.text.toLowerCase().includes(needle) ||
    (block.event?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Newest group first, each with the blocks that pass the filter. While searching, groups
 * without a match disappear; otherwise every group stays so the conversation reads in full.
 */
export function filterMedulaContextGroups(
  groups: ReadonlyArray<MedulaContextGroup>,
  filter: MedulaContextFilter,
): MedulaContextGroupView[] {
  const needle = filter.query.trim().toLowerCase();
  const origins = new Set(filter.origins);
  const views: MedulaContextGroupView[] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined) continue;
    const blocks = group.blocks.filter(
      (block) => origins.has(block.origin) && (needle === "" || matchesQuery(block, needle)),
    );
    if (needle !== "" && blocks.length === 0) continue;
    views.push({ group, blocks, hidden: group.blocks.length - blocks.length });
  }
  return views;
}

/** Origins present in the response, for showing counts next to each filter chip. */
export function countMedulaContextOrigins(
  groups: ReadonlyArray<MedulaContextGroup>,
): Record<MedulaContextOrigin, number> {
  const counts = Object.fromEntries(MEDULA_CONTEXT_ORIGINS.map((origin) => [origin, 0])) as Record<
    MedulaContextOrigin,
    number
  >;
  for (const group of groups) for (const block of group.blocks) counts[block.origin] += 1;
  return counts;
}

function parseTime(iso: string | null): number {
  if (iso === null) return Number.NaN;
  return Date.parse(iso);
}

/** Something entered after the last time the Contexto view was on screen for this thread. */
export function isMedulaContextUnseen(latestBlockAt: string | null, lastSeenAt: number | null) {
  if (lastSeenAt === null) return false;
  const latest = parseTime(latestBlockAt);
  return !Number.isNaN(latest) && latest > lastSeenAt;
}

export function isMedulaContextBlockNew(block: MedulaContextBlock, seenAt: number | null) {
  if (seenAt === null) return false;
  const at = parseTime(block.at);
  return !Number.isNaN(at) && at > seenAt;
}

// Per-thread "seen" marks, in one localStorage entry.

export const MEDULA_CONTEXT_SEEN_KEY = "t3code:medula:context-seen:v1";
const MAX_SEEN_THREADS = 200;

export interface MedulaKeyValueStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => void;
}

function readSeenMap(storage: MedulaKeyValueStorage): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(MEDULA_CONTEXT_SEEN_KEY) ?? "{}");
    if (!isRecord(parsed)) return {};
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

export function readMedulaContextSeenAt(
  storage: MedulaKeyValueStorage,
  threadId: string,
): number | null {
  return readSeenMap(storage)[threadId] ?? null;
}

/** Moves the mark forward only; keeps the most recent threads when the map grows. */
export function writeMedulaContextSeenAt(
  storage: MedulaKeyValueStorage,
  threadId: string,
  seenAt: number,
): boolean {
  const map = readSeenMap(storage);
  if ((map[threadId] ?? Number.NEGATIVE_INFINITY) >= seenAt) return false;
  map[threadId] = seenAt;
  const entries = Object.entries(map)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, MAX_SEEN_THREADS);
  try {
    storage.setItem(MEDULA_CONTEXT_SEEN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    return false;
  }
  return true;
}

/** The mark to store once the view showed a response: now, or the newest block if later. */
export function medulaContextSeenMark(latestBlockAt: string | null, now: number): number {
  const latest = parseTime(latestBlockAt);
  return Number.isNaN(latest) ? now : Math.max(now, latest);
}
