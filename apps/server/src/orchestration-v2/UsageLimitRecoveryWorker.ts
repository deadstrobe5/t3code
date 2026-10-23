import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MedulaAutoResume from "../medula/autoResume.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  /** Medula: resume at `dueMs` instead of the reset, with this text. */
  medula?: { readonly dueMs?: number; readonly text?: string },
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    (medula?.dueMs ?? resetMs) > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: medula?.text ?? "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const quotaReturnReaders = new Map<string, (nowMs: number) => Promise<number | null>>();
const readQuotaReturn = (command: string) => {
  let reader = quotaReturnReaders.get(command);
  if (reader === undefined) {
    reader = MedulaAutoResume.makeQuotaReturnReader(command);
    quotaReturnReaders.set(command, reader);
  }
  return reader;
};

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const medula = MedulaAutoResume.readMedulaResumeConfig(process.env);
    const autoResume = preferences.autoResumeLimitedThreads || medula.enabled;
    const pacer = medula.enabled ? MedulaAutoResume.sharedResumePacer(medula.intervalMs) : null;
    const quotaReturnMs =
      medula.enabled && medula.command !== null
        ? yield* Effect.promise(() => readQuotaReturn(medula.command!)(nowMs))
        : null;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      // Medula lists every armed thread (for the "resumes at" banner, and a
      // quota return may come before the reset) and lets the due time decide.
      now: medula.enabled ? DateTime.add(now, { days: 365 }) : now,
      autoResume,
      snooze: preferences.snoozeLimitedThreads,
    });
    const dueMs = (thread: ProjectionStore.ProjectionLimitRecoveryCandidate) =>
      MedulaAutoResume.resumeDueMs(Date.parse(thread.usageLimitResetAt ?? ""), quotaReturnMs);
    pacer?.setWaiting(
      candidates
        .map((thread) => ({ threadId: thread.id, dueMs: dueMs(thread) }))
        .filter((entry) => Number.isFinite(entry.dueMs)),
    );
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        autoResume,
        nowMs,
        preferences.snoozeLimitedThreads,
        medula.enabled ? { dueMs: dueMs(thread), text: medula.text } : undefined,
      );
      if (command === null) continue;
      if (command.type === "message.dispatch" && pacer !== null) {
        if (!pacer.canDispatch(thread.id, nowMs)) continue;
        pacer.recordDispatch(thread.id, nowMs);
      }
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
