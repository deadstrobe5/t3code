import { useEffect, useState } from "react";

import { getPrimaryJson } from "./medulaWorkers";

/** Mirrors `apps/server/src/medula/autoResume.ts`. */
export interface MedulaResumeStatus {
  readonly threadId: string;
  readonly resumeAt: string;
  readonly state: "waiting" | "sent";
}

export interface MedulaResumeList {
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly threads: ReadonlyArray<MedulaResumeStatus>;
}

export const MEDULA_RESUME_POLL_MS = 30_000;

export function fetchMedulaResume(): Promise<MedulaResumeList> {
  return getPrimaryJson<MedulaResumeList>("/api/medula/resume");
}

/** Keeps only well-formed entries, so an older server can't break the banner. */
export function parseMedulaResume(raw: unknown): MedulaResumeList | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || !Array.isArray(record.threads)) return null;
  const threads = record.threads.flatMap((entry): MedulaResumeStatus[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { threadId, resumeAt, state } = entry as Record<string, unknown>;
    if (typeof threadId !== "string" || typeof resumeAt !== "string") return [];
    if (!Number.isFinite(Date.parse(resumeAt))) return [];
    return [{ threadId, resumeAt, state: state === "sent" ? "sent" : "waiting" }];
  });
  return {
    enabled: record.enabled,
    intervalSeconds: typeof record.intervalSeconds === "number" ? record.intervalSeconds : 60,
    threads,
  };
}

/** `05:00`, or `sex 05:00` when it isn't today. */
export function formatResumeClock(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  const day = at.toLocaleDateString("pt-PT", { weekday: "short" }).replace(/\.$/, "");
  return `${day} ${time}`;
}

/** «Quota gasta · retoma às 05:00» for the thread, or null when it isn't waiting. */
export function medulaResumeTitle(
  list: MedulaResumeList | null,
  threadId: string,
  now = new Date(),
): string | null {
  if (!list?.enabled) return null;
  const status = list.threads.find((entry) => entry.threadId === threadId);
  if (!status) return null;
  const clock = formatResumeClock(status.resumeAt, now);
  return status.state === "sent"
    ? `Quota gasta · retoma enviada às ${clock}`
    : `Quota gasta · retoma às ${clock}`;
}

/** Summary for the Medula panel: how many threads wait and the next resume. */
export function medulaResumeSummary(
  list: MedulaResumeList | null,
  now = new Date(),
): string | null {
  if (!list?.enabled) return null;
  const waiting = list.threads.filter((entry) => entry.state === "waiting");
  if (waiting.length === 0) return null;
  const next = waiting.reduce((a, b) => (a.resumeAt <= b.resumeAt ? a : b));
  const count = waiting.length === 1 ? "1 conversa" : `${waiting.length} conversas`;
  return `Quota gasta · ${count} à espera · próxima retoma às ${formatResumeClock(next.resumeAt, now)}`;
}

/** Polls the resume list every 30 s while `enabled`. */
export function useMedulaResume(enabled: boolean): MedulaResumeList | null {
  const [list, setList] = useState<MedulaResumeList | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => {
      fetchMedulaResume().then(
        (raw) => {
          if (!cancelled) setList(parseMedulaResume(raw));
        },
        () => undefined,
      );
    };
    tick();
    const id = setInterval(tick, MEDULA_RESUME_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);
  return enabled ? list : null;
}
