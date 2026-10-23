/**
 * Pure helpers for the Medula panel: where the hub lives and how its live feed reads.
 *
 * The hub is an external dashboard (default port 8800 on the host serving this page). Its
 * `/api/eventos` stream carries three blocks: ideias (work requests), pensamentos (what the lead
 * agent is thinking) and mordomo (follow-up digests). The stream format is deliberately read
 * loosely so the hub can evolve: a named SSE event per block, a `bloco` field on each item, or a
 * snapshot object keyed by block all work.
 */

export const MEDULA_BLOCKS = ["ideias", "pensamentos", "mordomo"] as const;
export type MedulaBlock = (typeof MEDULA_BLOCKS)[number];

export const MEDULA_DEFAULT_PORT = 8800;
export const MEDULA_MAX_ITEMS = 300;

export interface MedulaItem {
  /** Stable identity, so a snapshot replayed after a reconnect does not duplicate rows. */
  key: string;
  block: MedulaBlock;
  /** Epoch milliseconds. */
  at: number;
  text: string;
  detail: string | null;
}

const BLOCK_ALIASES: Record<string, MedulaBlock> = {
  ideias: "ideias",
  ideia: "ideias",
  pensamentos: "pensamentos",
  pensamento: "pensamentos",
  lider: "pensamentos",
  líder: "pensamentos",
  mordomo: "mordomo",
};

function asBlock(value: unknown): MedulaBlock | null {
  return typeof value === "string" ? (BLOCK_ALIASES[value.toLowerCase()] ?? null) : null;
}

/**
 * The hub base URL with a trailing slash. An empty setting means "this page's host on the default
 * port", so a browser on another machine reaches the hub on the server, not on itself.
 */
export function resolveMedulaBaseUrl(
  setting: string,
  location: Pick<Location, "protocol" | "hostname"> | null,
): string {
  const trimmed = setting.trim();
  if (trimmed.length > 0) {
    try {
      const url = new URL(trimmed);
      if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
      return url.toString();
    } catch {
      return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    }
  }
  const webPage =
    location !== null &&
    (location.protocol === "http:" || location.protocol === "https:") &&
    location.hostname.length > 0;
  const host = webPage ? location.hostname : "127.0.0.1";
  const protocol = webPage ? location.protocol : "http:";
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}//${hostPart}:${MEDULA_DEFAULT_PORT}/`;
}

export function medulaApiUrl(baseUrl: string, path: "eventos" | "ideia"): string {
  try {
    return new URL(`api/${path}`, baseUrl).toString();
  } catch {
    return `${baseUrl}api/${path}`;
  }
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds (Python's time.time()) or milliseconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return parseTime(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

const TEXT_KEYS = [
  "texto",
  "resumo",
  "text",
  "mensagem",
  "message",
  "descricao",
  "titulo",
  "title",
];
const TIME_KEYS = ["t", "ts", "quando", "time", "at", "timestamp", "criado"];
const BLOCK_KEYS = ["bloco", "block", "tipo", "kind", "fonte", "type"];

function normalizeItem(raw: unknown, block: MedulaBlock, now: number): MedulaItem | null {
  if (typeof raw === "string") {
    const text = raw.trim();
    return text.length === 0
      ? null
      : { key: `${block}:${text}`, block, at: now, text, detail: null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const text = firstString(record, TEXT_KEYS);
  if (text === null) return null;
  let at: number | null = null;
  for (const key of TIME_KEYS) {
    at = parseTime(record[key]);
    if (at !== null) break;
  }
  const id = firstString(record, ["id", "taskId"]);
  const state = firstString(record, ["estado", "state", "status"]);
  const description = firstString(record, ["descricao", "titulo"]);
  const note = firstString(record, ["nota", "note"]);
  const detailParts = [id, state, description !== text ? description : null, note].filter(
    (part): part is string => part !== null,
  );
  const changedAt = firstString(record, ["t_estado"]) ?? "";
  const resolvedAt = at ?? now;
  const identity =
    id !== null ? `${id}:${state ?? ""}:${changedAt}:${at ?? text}` : `${at ?? ""}:${text}`;
  return {
    key: `${block}:${identity}`,
    block,
    at: resolvedAt,
    text,
    detail: detailParts.length > 0 ? detailParts.join(" · ") : null,
  };
}

function itemsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["itens", "items", "linhas", "lista", "dados", "data", "item"]) {
      const value = record[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") return [value];
    }
    // Columns keyed by state: {colunas: {espera: [...], fazer: [...]}}; the column names the state.
    const columns = record.colunas ?? record.columns;
    if (columns && typeof columns === "object" && !Array.isArray(columns)) {
      return Object.entries(columns as Record<string, unknown>).flatMap(([column, value]) =>
        Array.isArray(value)
          ? value.map((entry: unknown) =>
              entry && typeof entry === "object" && !Array.isArray(entry)
                ? { estado: column, ...(entry as Record<string, unknown>) }
                : entry,
            )
          : [],
      );
    }
  }
  return [payload];
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

/** Every feed item one SSE message carries; unknown shapes yield nothing. */
export function parseMedulaMessage(
  eventName: string,
  data: string,
  now: number = Date.now(),
): MedulaItem[] {
  const payload = parseData(data);
  const named = asBlock(eventName);
  if (named !== null) {
    return itemsOf(payload).flatMap((entry) => normalizeItem(entry, named, now) ?? []);
  }
  if (!payload || typeof payload !== "object") return [];
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    // A snapshot keyed by block: {ideias: [...], pensamentos: [...], mordomo: [...]}.
    const snapshotBlocks = Object.keys(record).filter((key) => asBlock(key) !== null);
    if (snapshotBlocks.some((key) => record[key] !== null && typeof record[key] === "object")) {
      return snapshotBlocks.flatMap((key) => {
        const block = asBlock(key)!;
        return itemsOf(record[key]).flatMap((item) => normalizeItem(item, block, now) ?? []);
      });
    }
    let block: MedulaBlock | null = null;
    for (const key of BLOCK_KEYS) {
      block = asBlock(record[key]);
      if (block !== null) break;
    }
    if (block === null) return [];
    const nested = record.item ?? record.dados ?? record.data;
    const source = nested && typeof nested === "object" ? nested : record;
    return itemsOf(source).flatMap((item) => normalizeItem(item, block, now) ?? []);
  });
}

/** Newest first, deduplicated by key, capped. Returns `current` when nothing new arrived. */
export function mergeMedulaItems(
  current: readonly MedulaItem[],
  incoming: readonly MedulaItem[],
  max: number = MEDULA_MAX_ITEMS,
): readonly MedulaItem[] {
  if (incoming.length === 0) return current;
  const known = new Set(current.map((item) => item.key));
  const fresh = incoming.filter((item) => {
    if (known.has(item.key)) return false;
    known.add(item.key);
    return true;
  });
  if (fresh.length === 0) return current;
  return [...fresh, ...current].toSorted((left, right) => right.at - left.at).slice(0, max);
}

export function countUnseenMedulaItems(items: readonly MedulaItem[], lastSeenAt: number): number {
  let count = 0;
  for (const item of items) if (item.at > lastSeenAt) count += 1;
  return count;
}
