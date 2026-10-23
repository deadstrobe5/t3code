/**
 * Medula panel state: client-local settings (hub URL, title, visibility), the "last seen" mark
 * behind the unread badge, and the shared live feed.
 *
 * One EventSource serves every mounted consumer (the header toggle and the panel), so the badge
 * keeps counting while the panel is closed. Consumers call `retainMedulaFeed` on mount and the
 * returned release on unmount; the stream closes when nobody is left.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

import {
  MEDULA_BLOCKS,
  type MedulaBlock,
  type MedulaItem,
  medulaApiUrl,
  mergeMedulaItems,
  parseMedulaMessage,
  resolveMedulaBaseUrl,
} from "./medulaFeed";

export type MedulaConnection = "idle" | "connecting" | "open" | "closed";

interface MedulaSettings {
  enabled: boolean;
  /** Empty means this page's host on the default hub port. */
  url: string;
  title: string;
  filters: MedulaBlock[];
  showHub: boolean;
  /** Epoch ms of the newest item the user has seen; null until the first load. */
  lastSeenAt: number | null;
}

interface MedulaState extends MedulaSettings {
  items: readonly MedulaItem[];
  connection: MedulaConnection;
  update: (patch: Partial<MedulaSettings>) => void;
  markSeen: () => void;
}

export const MEDULA_DEFAULT_TITLE = "Medula";

const DEFAULT_SETTINGS: MedulaSettings = {
  enabled: true,
  url: "",
  title: MEDULA_DEFAULT_TITLE,
  filters: [...MEDULA_BLOCKS],
  showHub: true,
  lastSeenAt: null,
};

export const useMedulaStore = create<MedulaState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      items: [],
      connection: "idle",
      update: (patch) => set(patch),
      markSeen: () => {
        const newest = get().items[0]?.at ?? 0;
        const seen = Math.max(Date.now(), newest);
        if ((get().lastSeenAt ?? 0) < seen) set({ lastSeenAt: seen });
      },
    }),
    {
      name: "t3code:medula:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): MedulaSettings => ({
        enabled: state.enabled,
        url: state.url,
        title: state.title,
        filters: state.filters,
        showHub: state.showHub,
        lastSeenAt: state.lastSeenAt,
      }),
      onRehydrateStorage: () => (state) => {
        // A first install starts with nothing unread instead of the hub's whole backlog.
        if (state && state.lastSeenAt === null) state.update({ lastSeenAt: Date.now() });
      },
    },
  ),
);

export function readMedulaLastSeenAt(): number {
  return useMedulaStore.getState().lastSeenAt ?? 0;
}

export function useMedulaBaseUrl(): string {
  const url = useMedulaStore((state) => state.url);
  return resolveMedulaBaseUrl(url, typeof window !== "undefined" ? window.location : null);
}

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

let consumers = 0;
let source: EventSource | null = null;
let sourceUrl: string | null = null;
/** The feed the current items came from; a different hub starts from an empty list. */
let itemsUrl: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;
let unsubscribeSettings: (() => void) | null = null;

function currentFeedUrl(): string | null {
  const state = useMedulaStore.getState();
  if (!state.enabled || typeof window === "undefined") return null;
  return medulaApiUrl(resolveMedulaBaseUrl(state.url, window.location), "eventos");
}

function closeSource() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  source?.close();
  source = null;
  sourceUrl = null;
}

function ingest(eventName: string, data: string) {
  const incoming = parseMedulaMessage(eventName, data);
  if (incoming.length === 0) return;
  const { items } = useMedulaStore.getState();
  const next = mergeMedulaItems(items, incoming);
  if (next !== items) useMedulaStore.setState({ items: next });
}

function openSource() {
  const url = currentFeedUrl();
  if (url === null || typeof EventSource === "undefined") {
    closeSource();
    useMedulaStore.setState({ connection: "idle" });
    return;
  }
  if (source !== null && sourceUrl === url) return;
  closeSource();
  if (itemsUrl !== url) useMedulaStore.setState({ items: [] });
  itemsUrl = url;
  sourceUrl = url;
  useMedulaStore.setState({ connection: "connecting" });
  const next = new EventSource(url);
  source = next;
  next.addEventListener("open", () => {
    if (source !== next) return;
    retryDelay = RETRY_MIN_MS;
    useMedulaStore.setState({ connection: "open" });
  });
  next.addEventListener("error", () => {
    if (source !== next) return;
    if (next.readyState === EventSource.CONNECTING) {
      // The browser reconnects on its own after a dropped stream.
      useMedulaStore.setState({ connection: "connecting" });
      return;
    }
    // A refused connection or a non-stream response closes for good: retry with backoff.
    useMedulaStore.setState({ connection: "closed" });
    next.close();
    source = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      sourceUrl = null;
      if (consumers > 0) openSource();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  });
  next.addEventListener("message", (event) => ingest("message", event.data));
  for (const name of [...MEDULA_BLOCKS, "snapshot", "estado"]) {
    next.addEventListener(name, (event) => ingest(name, (event as MessageEvent<string>).data));
  }
}

/** Keep the shared feed open while the caller is mounted. */
export function retainMedulaFeed(): () => void {
  consumers += 1;
  if (consumers === 1) {
    unsubscribeSettings = useMedulaStore.subscribe((next, previous) => {
      if (next.url !== previous.url || next.enabled !== previous.enabled) {
        retryDelay = RETRY_MIN_MS;
        openSource();
      }
    });
  }
  openSource();
  return () => {
    consumers -= 1;
    if (consumers > 0) return;
    unsubscribeSettings?.();
    unsubscribeSettings = null;
    closeSource();
    useMedulaStore.setState({ connection: "idle" });
  };
}

/** Reconnect now instead of waiting for the backoff. */
export function reconnectMedulaFeed() {
  retryDelay = RETRY_MIN_MS;
  closeSource();
  if (consumers > 0) openSource();
}

export type MedulaPostResult = { ok: true } | { ok: false; error: string };

/** Records a thought in the hub's idea box without going through a conversation. */
export async function postMedulaIdea(baseUrl: string, texto: string): Promise<MedulaPostResult> {
  let response: Response;
  try {
    response = await fetch(medulaApiUrl(baseUrl, "ideia"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto }),
    });
  } catch (error) {
    return {
      ok: false,
      error: `Sem ligação a ${baseUrl}${error instanceof Error && error.message ? ` (${error.message})` : ""}`,
    };
  }
  if (response.ok) return { ok: true };
  const body = (await response.text().catch(() => "")).trim().slice(0, 300);
  return {
    ok: false,
    error: `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`.trim(),
  };
}
