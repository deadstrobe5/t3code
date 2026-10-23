/**
 * The thread whose Claude context the Medula panel reads, the newest block the server reported
 * for it, and the per-thread "seen" mark that lights the dot on the header toggle.
 *
 * ChatView names the active thread with `useMedulaContextThread`; the toggle polls the summary
 * while a thread is active and the panel's Contexto view polls the full context while shown.
 */
import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import { resolveStorage } from "~/lib/storage";

import {
  isMedulaContextUnseen,
  MEDULA_CONTEXT_SUMMARY_POLL_MS,
  medulaContextSeenMark,
  parseMedulaContextResponse,
  readMedulaContextSeenAt,
  writeMedulaContextSeenAt,
  type MedulaContextResponse,
} from "./medulaContext";
import { getPrimaryJson } from "./medulaWorkers";

interface MedulaContextState {
  /** Server thread of the primary environment shown in the chat; null otherwise. */
  threadId: string | null;
  latest: { threadId: string; at: string | null } | null;
  /** Bumped whenever a seen mark moves, so readers re-check localStorage. */
  seenVersion: number;
}

export const useMedulaContextStore = create<MedulaContextState>()(() => ({
  threadId: null,
  latest: null,
  seenVersion: 0,
}));

function seenStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined) as {
    getItem: (name: string) => string | null;
    setItem: (name: string, value: string) => void;
  };
}

export function readContextSeenAt(threadId: string): number | null {
  return readMedulaContextSeenAt(seenStorage(), threadId);
}

function writeContextSeenAt(threadId: string, seenAt: number) {
  if (writeMedulaContextSeenAt(seenStorage(), threadId, seenAt)) {
    useMedulaContextStore.setState((state) => ({ seenVersion: state.seenVersion + 1 }));
  }
}

/** Called by ChatView with the active thread, or null when it is not a primary server thread. */
export function useMedulaContextThread(threadId: string | null) {
  useEffect(() => {
    useMedulaContextStore.setState({ threadId });
    return () => {
      if (useMedulaContextStore.getState().threadId === threadId) {
        useMedulaContextStore.setState({ threadId: null });
      }
    };
  }, [threadId]);
}

export async function fetchMedulaContext(
  threadId: string,
  summary: boolean,
): Promise<MedulaContextResponse> {
  const raw = await getPrimaryJson<unknown>("/api/medula/context", {
    threadId,
    ...(summary ? { summary: "1" } : {}),
  });
  const parsed = parseMedulaContextResponse(raw);
  if (parsed === null) throw new Error("Resposta inesperada do servidor");
  return parsed;
}

/** Records the newest block the server reported; the first report for a thread is the baseline. */
export function noteMedulaContextLatest(threadId: string, response: MedulaContextResponse) {
  if (!response.available) return;
  const at = response.latestBlockAt;
  const current = useMedulaContextStore.getState().latest;
  if (current?.threadId !== threadId || current.at !== at) {
    useMedulaContextStore.setState({ latest: { threadId, at } });
  }
  // A thread never opened before starts with nothing unseen instead of its whole backlog.
  if (readContextSeenAt(threadId) === null) {
    writeContextSeenAt(threadId, medulaContextSeenMark(at, Date.now()));
  }
}

export function markMedulaContextSeen(threadId: string, latestBlockAt: string | null) {
  writeContextSeenAt(threadId, medulaContextSeenMark(latestBlockAt, Date.now()));
}

function isPageHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Runs `tick` now and every `intervalMs` while `key` is set (restarting when it changes),
 * skipping while the tab is hidden and catching up as soon as it shows again.
 */
export function usePolling(key: string | null, intervalMs: number, tick: () => void) {
  const onTick = useEffectEvent(tick);
  useEffect(() => {
    if (key === null) return;
    const run = () => {
      if (!isPageHidden()) onTick();
    };
    run();
    const id = setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", run);
    };
  }, [key, intervalMs]);
}

/** Polls the summary for the active thread and says whether new context arrived unseen. */
export function useMedulaContextUnseen(): boolean {
  const threadId = useMedulaContextStore((state) => state.threadId);
  const latest = useMedulaContextStore((state) => state.latest);
  useMedulaContextStore((state) => state.seenVersion);
  usePolling(threadId, MEDULA_CONTEXT_SUMMARY_POLL_MS, () => {
    if (threadId === null) return;
    fetchMedulaContext(threadId, true).then(
      (response) => noteMedulaContextLatest(threadId, response),
      () => undefined,
    );
  });
  if (threadId === null || latest?.threadId !== threadId) return false;
  return isMedulaContextUnseen(latest.at, readContextSeenAt(threadId));
}
