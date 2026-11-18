// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node policy, called from the worker with epoch ms.
/**
 * Medula auto-resume: the operator's policy on top of the usage-limit recovery
 * worker. With `T3CODE_MEDULA_AUTO_RETOMA=1` every thread stopped by a usage
 * limit is armed for auto-resume, resumes are spaced out across threads, and
 * an optional command (`T3CODE_MEDULA_RETOMA_CMD`, printing an epoch in
 * seconds or an ISO time) says when quota is back, which matters when a proxy
 * rotates between several accounts and one frees up before the failing one.
 *
 * Plain Node so the policy can be unit-tested without the server.
 */
import * as NodeChildProcess from "node:child_process";

export const MEDULA_AUTO_RESUME_ENV = "T3CODE_MEDULA_AUTO_RETOMA";
export const MEDULA_RESUME_INTERVAL_ENV = "T3CODE_MEDULA_RETOMA_INTERVALO_S";
export const MEDULA_RESUME_COMMAND_ENV = "T3CODE_MEDULA_RETOMA_CMD";
export const MEDULA_RESUME_TEXT_ENV = "T3CODE_MEDULA_RETOMA_TEXTO";
export const MEDULA_RESUME_PATH = "/api/medula/resume";

export const DEFAULT_RESUME_TEXT =
  "A quota voltou. Continua de onde ficaste; não repitas trabalho já feito.";
/** Never more than one resume per minute in total, whatever the env says. */
const MIN_INTERVAL_MS = 60_000;
/** A thread that failed again right after a resume waits this long before the next one. */
const PER_THREAD_MIN_MS = 10 * 60_000;
const COMMAND_CACHE_MS = 30_000;
const COMMAND_TIMEOUT_MS = 5_000;

export interface MedulaResumeConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly command: string | null;
  readonly text: string;
}

export function readMedulaResumeConfig(env: NodeJS.ProcessEnv): MedulaResumeConfig {
  const seconds = Number(env[MEDULA_RESUME_INTERVAL_ENV]);
  return {
    enabled: env[MEDULA_AUTO_RESUME_ENV]?.trim() === "1",
    intervalMs: Math.max(
      MIN_INTERVAL_MS,
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
    ),
    command: env[MEDULA_RESUME_COMMAND_ENV]?.trim() || null,
    text: env[MEDULA_RESUME_TEXT_ENV]?.trim() || DEFAULT_RESUME_TEXT,
  };
}

/** Epoch milliseconds from the command's output: epoch seconds, epoch ms or ISO. */
export function parseQuotaReturn(output: string): number | null {
  const text = output.trim().split("\n").at(-1)?.trim() ?? "";
  if (text === "") return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const value = Number(text);
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * When the thread should resume: the provider's reset, or earlier when the
 * quota command says some account is back sooner.
 */
export function resumeDueMs(resetMs: number, quotaReturnMs: number | null): number {
  return quotaReturnMs === null ? resetMs : Math.min(resetMs, quotaReturnMs);
}

export interface ResumeStatus {
  readonly threadId: string;
  readonly resumeAt: string;
  readonly state: "waiting" | "sent";
}

/** Spaces resumes out and remembers what each thread is waiting for. */
export class ResumePacer {
  private lastDispatchMs = Number.NEGATIVE_INFINITY;
  private readonly lastByThread = new Map<string, number>();
  private readonly statuses = new Map<string, ResumeStatus>();

  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  canDispatch(threadId: string, nowMs: number): boolean {
    const last = this.lastByThread.get(threadId) ?? Number.NEGATIVE_INFINITY;
    return nowMs - this.lastDispatchMs >= this.intervalMs && nowMs - last >= PER_THREAD_MIN_MS;
  }

  recordDispatch(threadId: string, nowMs: number): void {
    this.lastDispatchMs = nowMs;
    this.lastByThread.set(threadId, nowMs);
    const status = this.statuses.get(threadId);
    if (status) this.statuses.set(threadId, { ...status, state: "sent" });
  }

  /** Replaces the waiting set with this sweep's candidates. */
  setWaiting(entries: ReadonlyArray<{ threadId: string; dueMs: number }>): void {
    const keep = new Set(entries.map((entry) => entry.threadId));
    for (const id of this.statuses.keys()) if (!keep.has(id)) this.statuses.delete(id);
    for (const entry of entries) {
      const previous = this.statuses.get(entry.threadId);
      const resumeAt = new Date(entry.dueMs).toISOString();
      this.statuses.set(entry.threadId, {
        threadId: entry.threadId,
        resumeAt,
        state: previous?.resumeAt === resumeAt ? previous.state : "waiting",
      });
    }
  }

  snapshot(): ReadonlyArray<ResumeStatus> {
    return [...this.statuses.values()].toSorted((a, b) => a.resumeAt.localeCompare(b.resumeAt));
  }
}

/** Runs the quota command at most every 30 s; failures read as "unknown". */
export function makeQuotaReturnReader(
  command: string,
  run: (command: string) => Promise<string> = runShell,
) {
  let cached: { atMs: number; value: number | null } | null = null;
  return async (nowMs: number): Promise<number | null> => {
    if (cached && nowMs - cached.atMs < COMMAND_CACHE_MS) return cached.value;
    let value: number | null = null;
    try {
      value = parseQuotaReturn(await run(command));
    } catch {
      value = null;
    }
    cached = { atMs: nowMs, value };
    return value;
  };
}

function runShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "/bin/sh",
      ["-c", command],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

let sharedPacer: { intervalMs: number; pacer: ResumePacer } | null = null;

/** One pacer per server process, shared by the worker and the HTTP route. */
export function sharedResumePacer(intervalMs: number): ResumePacer {
  if (sharedPacer?.intervalMs !== intervalMs) {
    sharedPacer = { intervalMs, pacer: new ResumePacer(intervalMs) };
  }
  return sharedPacer.pacer;
}

export function resumeSnapshot(): ReadonlyArray<ResumeStatus> {
  return sharedPacer?.pacer.snapshot() ?? [];
}
