import { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { limitRecoveryCommand } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import type { ProjectionLimitRecoveryCandidate } from "../orchestration-v2/ProjectionStore.ts";
import {
  DEFAULT_RESUME_TEXT,
  makeQuotaReturnReader,
  parseQuotaReturn,
  readMedulaResumeConfig,
  resumeDueMs,
  ResumePacer,
} from "./autoResume.ts";

const RESET = "2026-10-23T05:00:00.000Z";
const RESET_MS = Date.parse(RESET);

function candidate(
  overrides: Partial<ProjectionLimitRecoveryCandidate> = {},
): ProjectionLimitRecoveryCandidate {
  return {
    id: ThreadId.make("thread-1"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: RESET,
    latestRunId: RunId.make("run-1"),
    latestRunCompletedAt: DateTime.makeUnsafe("2026-10-23T03:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-23T03:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: { runId: RunId.make("run-1"), resetAt: RESET, autoResume: true, snooze: false },
    snoozedUntil: null,
    ...overrides,
  } as ProjectionLimitRecoveryCandidate;
}

describe("readMedulaResumeConfig", () => {
  it("is off without the switch and never paces faster than a minute", () => {
    expect(readMedulaResumeConfig({}).enabled).toBe(false);
    const config = readMedulaResumeConfig({
      T3CODE_MEDULA_AUTO_RETOMA: "1",
      T3CODE_MEDULA_RETOMA_INTERVALO_S: "5",
    });
    expect(config).toEqual({
      enabled: true,
      intervalMs: 60_000,
      command: null,
      text: DEFAULT_RESUME_TEXT,
    });
    expect(
      readMedulaResumeConfig({
        T3CODE_MEDULA_AUTO_RETOMA: "1",
        T3CODE_MEDULA_RETOMA_INTERVALO_S: "120",
        T3CODE_MEDULA_RETOMA_CMD: " medula-quota volta ",
        T3CODE_MEDULA_RETOMA_TEXTO: "Continue.",
      }),
    ).toEqual({
      enabled: true,
      intervalMs: 120_000,
      command: "medula-quota volta",
      text: "Continue.",
    });
  });
});

describe("parseQuotaReturn", () => {
  it("reads epoch seconds, epoch ms and ISO from the last line", () => {
    expect(parseQuotaReturn("1792726800\n")).toBe(1792726800_000);
    expect(parseQuotaReturn("warming up\n1792726800123")).toBe(1792726800123);
    expect(parseQuotaReturn(RESET)).toBe(RESET_MS);
    expect(parseQuotaReturn("")).toBeNull();
    expect(parseQuotaReturn("soon")).toBeNull();
  });

  it("resumes at the earlier of the reset and the quota return", () => {
    expect(resumeDueMs(RESET_MS, null)).toBe(RESET_MS);
    expect(resumeDueMs(RESET_MS, RESET_MS - 1000)).toBe(RESET_MS - 1000);
    expect(resumeDueMs(RESET_MS, RESET_MS + 1000)).toBe(RESET_MS);
  });

  it("caches the command for 30 s and treats failures as unknown", async () => {
    let calls = 0;
    const read = makeQuotaReturnReader("x", async () => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return "1792726800";
    });
    expect(await read(0)).toBe(1792726800_000);
    expect(await read(10_000)).toBe(1792726800_000);
    expect(calls).toBe(1);
    expect(await read(31_000)).toBeNull();
    expect(calls).toBe(2);
  });
});

describe("ResumePacer", () => {
  it("allows one resume per interval in total and one per 10 min per thread", () => {
    const pacer = new ResumePacer(60_000);
    expect(pacer.canDispatch("a", 0)).toBe(true);
    pacer.recordDispatch("a", 0);
    expect(pacer.canDispatch("b", 30_000)).toBe(false);
    expect(pacer.canDispatch("b", 60_000)).toBe(true);
    pacer.recordDispatch("b", 60_000);
    expect(pacer.canDispatch("a", 180_000)).toBe(false);
    expect(pacer.canDispatch("a", 600_000)).toBe(true);
  });

  it("tracks waiting threads and marks sent ones", () => {
    const pacer = new ResumePacer(60_000);
    pacer.setWaiting([
      { threadId: "b", dueMs: RESET_MS + 60_000 },
      { threadId: "a", dueMs: RESET_MS },
    ]);
    pacer.recordDispatch("a", RESET_MS);
    expect(pacer.snapshot()).toEqual([
      { threadId: "a", resumeAt: RESET, state: "sent" },
      { threadId: "b", resumeAt: "2026-10-23T05:01:00.000Z", state: "waiting" },
    ]);
    pacer.setWaiting([{ threadId: "b", dueMs: RESET_MS + 60_000 }]);
    expect(pacer.snapshot().map((status) => status.threadId)).toEqual(["b"]);
  });
});

describe("limitRecoveryCommand with the medula policy", () => {
  const before = RESET_MS - 60_000;

  it("resumes early when the quota comes back before the reset, with the medula text", () => {
    expect(limitRecoveryCommand(candidate(), true, before)).toBeNull();
    const command = limitRecoveryCommand(candidate(), true, before, false, {
      dueMs: before,
      text: DEFAULT_RESUME_TEXT,
    });
    expect(command).toMatchObject({
      type: "message.dispatch",
      text: DEFAULT_RESUME_TEXT,
      createdBy: "user",
      creationSource: "server",
    });
  });

  it("keeps the upstream text and timing without the policy", () => {
    expect(limitRecoveryCommand(candidate(), true, RESET_MS)).toMatchObject({
      type: "message.dispatch",
      text: "Continue where you left off.",
    });
  });

  it("arms an unarmed thread and respects a cancelled auto-resume", () => {
    expect(
      limitRecoveryCommand(candidate({ limitRecovery: null }), true, before, false, {
        dueMs: before,
      }),
    ).toMatchObject({ type: "thread.metadata.update", limitRecovery: { autoResume: true } });
    const cancelled = candidate({
      limitRecovery: {
        runId: RunId.make("run-1"),
        resetAt: RESET,
        autoResume: false,
        snooze: false,
      },
    });
    expect(limitRecoveryCommand(cancelled, true, RESET_MS, false, { dueMs: before })).toBeNull();
  });
});
