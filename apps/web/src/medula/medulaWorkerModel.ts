import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

/** Mirrors `apps/server/src/medula/workers.ts`. */
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

export interface MedulaWorkerList {
  readonly configured: boolean;
  readonly workers: ReadonlyArray<MedulaWorker>;
}

export interface MedulaWorkerLog {
  readonly id: string;
  readonly source: "out" | "transcript" | "err" | "none";
  readonly text: string;
}

export const MEDULA_WORKERS_POLL_MS = 5_000;

export type MedulaWorkerTone = "running" | "done" | "failed" | "rejected" | "unknown";

export function medulaWorkerTone(state: string): MedulaWorkerTone {
  switch (state) {
    case "a-correr":
      return "running";
    case "acabou":
      return "done";
    case "falhou":
      return "failed";
    case "rejeitado":
      return "rejected";
    default:
      return "unknown";
  }
}

export function isMedulaWorkerRunning(worker: MedulaWorker): boolean {
  return medulaWorkerTone(worker.state) === "running";
}

/** `4 s`, `12 min`, `1 h 05 min`. */
export function formatMedulaElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Time the worker has run, up to now while running or up to its end time. */
export function medulaWorkerElapsedMs(worker: MedulaWorker, now: number): number | null {
  const start = worker.startedAt ? Date.parse(worker.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const end = worker.endedAt ? Date.parse(worker.endedAt) : Number.NaN;
  return (Number.isNaN(end) ? now : end) - start;
}

function isSameOrigin(url: string): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge === undefined &&
    new URL(url).origin === window.location.origin
  );
}

/** GET a JSON route of the primary environment with its session cookie or desktop token. */
export async function getPrimaryJson<T>(
  pathname: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = resolvePrimaryEnvironmentHttpUrl(pathname, params);
  const sameOrigin = isSameOrigin(url);
  const token = sameOrigin ? null : await readDesktopPrimaryBearerToken();
  const response = await fetch(url, {
    credentials: sameOrigin ? "include" : "omit",
    cache: "no-store",
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function fetchMedulaWorkers(): Promise<MedulaWorkerList> {
  return getPrimaryJson<MedulaWorkerList>("/api/medula/workers");
}

export function fetchMedulaWorkerLog(id: string): Promise<MedulaWorkerLog> {
  return getPrimaryJson<MedulaWorkerLog>("/api/medula/worker-log", { id });
}
