/**
 * After a restart, reconnects threads to the Claude CLIs the previous server
 * left running (see adoptableSessions.ts).
 *
 * A thread whose turn was cut gets upstream's restart continuation, which
 * opens its session and so adopts the CLI. A thread whose turn had already
 * ended, but whose CLI still has background work or unread output, gets
 * nothing from upstream: this sends it a short system message instead. Its
 * session opens, adopts the CLI, and the CLI's own turns (a finished
 * background task, the end of the cut turn) reach the thread as they do on a
 * live server.
 */
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ADOPTION_PROMPT, AdoptableSessions } from "./adoptableSessions.ts";

/** Lets upstream's restart continuations start first, so they are not doubled. */
const SETTLE_DELAY = "5 seconds";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["preparing", "starting", "running"]);

export const reattachAdoptableSessions = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  if (!AdoptableSessions.enabled(process.env, yield* HostProcess.Platform)) return;
  const sessions = new AdoptableSessions(stateDir);
  if (sessions.listLive().length === 0) return;
  yield* Effect.sleep(SETTLE_DELAY);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const boot = (yield* Clock.currentTimeMillis).toString(36);
  for (const live of sessions.listLive()) {
    const threadId = ThreadId.make(live.state.threadId);
    yield* Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(threadId, ["runs"]);
      if (records.thread.archivedAt !== null || records.thread.deletedAt !== null) return;
      if (records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return;
      const latest = records.runs.reduce<(typeof records.runs)[number] | undefined>(
        (best, run) =>
          run.status !== "queued" && (best === undefined || runRanAfter(run, best)) ? run : best,
        undefined,
      );
      if (latest === undefined) return;
      // One reattach per launch per boot: a later restart may need another,
      // and a rejected command id stays rejected.
      const key = `${live.dir.slice(live.dir.lastIndexOf("/") + 1)}:${boot}`;
      yield* Effect.logInfo("medula.adoptable-session.reattach", {
        threadId,
        pid: live.state.pid,
        ...live.status,
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:adopt-session:${key}`),
        threadId,
        messageId: MessageId.make(`message:adopt-session:${key}`),
        text: ADOPTION_PROMPT,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "T3 Code restarted; the agent kept running",
          detail: ADOPTION_PROMPT,
        },
        attachments: [],
        modelSelection: latest.modelSelection,
        // Upstream takes notifications only as queued messages; with no active
        // run, a queued message starts at once.
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("medula.adoptable-session.reattach-failed", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  }
});
