import { describe, expect, it } from "vite-plus/test";

import {
  countLive,
  deriveBackgroundActivity,
  formatAge,
  launchedTaskId,
  recentChildEvents,
  RECENTLY_FINISHED_MS,
  type BackgroundActivityInput,
} from "./backgroundActivity";

const NOW = Date.parse("2026-10-26T21:30:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function subagent(overrides: Record<string, unknown>) {
  return {
    id: "node:a1",
    title: "Explora o servidor",
    prompt: "Explora o servidor do T3",
    model: null,
    modelSelection: { model: "claude-sonnet-5" },
    status: "running",
    progress: "Running rg -n task_notification",
    result: null,
    startedAt: ago(4),
    completedAt: null,
    updatedAt: ago(0),
    childThreadId: null,
    nativeTaskRef: { nativeId: "a1" },
    ...overrides,
  } as never;
}

function input(overrides: Partial<BackgroundActivityInput>): BackgroundActivityInput {
  return {
    activeProviderThreadId: "pt-1",
    subagents: [],
    providerThreads: [],
    turnItems: [],
    messages: [],
    ...overrides,
  };
}

describe("deriveBackgroundActivity", () => {
  it("lists a running subagent with model, age and last step", () => {
    const [item] = deriveBackgroundActivity(input({ subagents: [subagent({})] }), NOW);
    expect(item).toMatchObject({
      kind: "subagent",
      label: "Explora o servidor",
      model: "claude-sonnet-5",
      state: "running",
      lastStep: "Running rg -n task_notification",
    });
    expect(NOW - item!.startedAt!).toBe(4 * 60_000);
  });

  it("keeps finished subagents only while recent", () => {
    const recent = subagent({
      id: "r",
      status: "completed",
      completedAt: ago(2),
      result: "Feito.",
    });
    const old = subagent({
      id: "o",
      status: "failed",
      completedAt: new Date(NOW - RECENTLY_FINISHED_MS - 1).toISOString(),
    });
    const items = deriveBackgroundActivity(input({ subagents: [recent, old] }), NOW);
    expect(items.map((item) => item.id)).toEqual(["subagent:r"]);
    expect(items[0]).toMatchObject({ state: "done", lastStep: "Feito." });
  });

  it("reads background shells and monitors from the active provider thread's roster", () => {
    const items = deriveBackgroundActivity(
      input({
        providerThreads: [
          {
            id: "pt-1",
            pendingBackgroundTasks: [
              { taskId: "b1", kind: "command", description: "pnpm install" },
              { taskId: "m1", kind: "monitor", description: "Vigia a fila", awaited: true },
            ],
          },
          { id: "pt-old", pendingBackgroundTasks: [{ taskId: "stale", kind: "command" }] },
        ],
        turnItems: [
          {
            id: "t1",
            type: "command_execution",
            status: "completed",
            title: null,
            input: "pnpm install",
            output:
              "Command running in background with ID: b1. Output is being written to: /tmp/b1",
            startedAt: ago(3),
          },
          {
            id: "t2",
            type: "dynamic_tool",
            toolName: "Monitor",
            status: "completed",
            title: null,
            input: { description: "Vigia a fila" },
            output: { taskId: "m1", persistent: false },
            startedAt: ago(9),
          },
        ],
      }),
      NOW,
    );
    expect(items.map((item) => [item.id, item.kind, item.state])).toEqual([
      ["task:b1", "command", "running"],
      ["task:m1", "monitor", "waiting"],
    ]);
    expect(NOW - items[0]!.startedAt!).toBe(3 * 60_000);
    expect(items[0]!.events[0]!.text).toBe("Começou (Bash)");
  });

  it("falls back to first-seen time when the launching call is not loaded", () => {
    const [item] = deriveBackgroundActivity(
      input({
        providerThreads: [
          { id: "pt-1", pendingBackgroundTasks: [{ taskId: "bx", kind: "command" }] },
        ],
      }),
      NOW,
      () => NOW - 5_000,
    );
    expect(item).toMatchObject({ label: "bx", startedAt: NOW - 5_000 });
  });

  it("keeps a finished shell with the outcome from its notification", () => {
    const items = deriveBackgroundActivity(
      input({
        turnItems: [
          {
            id: "t1",
            type: "command_execution",
            status: "completed",
            title: null,
            input: "make test",
            output: "Command running in background with ID: b9. Output…",
            startedAt: ago(6),
          },
        ],
        messages: [
          {
            text: 'Background command "make test" failed (exit code 2)',
            createdAt: ago(1),
            notification: {
              source: { kind: "command" },
              outcome: "failed",
              summary: 'Command "make test" failed',
            },
          },
        ],
      }),
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "task:b9",
      state: "failed",
      lastStep: 'Background command "make test" failed (exit code 2)',
    });
    expect(items[0]!.events).toHaveLength(2);
  });

  it("caps events at five, newest first", () => {
    const turnItems = Array.from({ length: 8 }, (_, index) => ({
      id: `r${index}`,
      type: "dynamic_tool",
      toolName: "TaskOutput",
      status: "completed",
      title: null,
      input: { task_id: "b1" },
      output: `linha ${index}`,
      startedAt: ago(8 - index),
    }));
    const [item] = deriveBackgroundActivity(
      input({
        providerThreads: [
          { id: "pt-1", pendingBackgroundTasks: [{ taskId: "b1", kind: "command" }] },
        ],
        turnItems,
      }),
      NOW,
    );
    expect(item!.events).toHaveLength(5);
    expect(item!.events[0]!.text).toContain("linha 7");
  });

  it("orders live work before finished work and counts only live", () => {
    const items = deriveBackgroundActivity(
      input({
        subagents: [
          subagent({ id: "done", status: "completed", completedAt: ago(1) }),
          subagent({ id: "live" }),
        ],
      }),
      NOW,
    );
    expect(items.map((item) => item.id)).toEqual(["subagent:live", "subagent:done"]);
    expect(countLive(items)).toBe(1);
  });
});

describe("helpers", () => {
  it("finds the launched task id", () => {
    expect(
      launchedTaskId({
        id: "x",
        type: "command_execution",
        status: "completed",
        title: null,
        startedAt: null,
        output: "Command running in background with ID: bq7. Output",
      }),
    ).toBe("bq7");
    expect(
      launchedTaskId({
        id: "x",
        type: "command_execution",
        status: "completed",
        title: null,
        startedAt: null,
        output: "ok",
      }),
    ).toBeNull();
  });

  it("summarises a child thread's last steps", () => {
    const events = recentChildEvents([
      { id: "1", type: "reasoning", status: "completed", title: null, startedAt: ago(5) },
      {
        id: "2",
        type: "command_execution",
        status: "completed",
        title: null,
        input: "rg foo",
        startedAt: ago(4),
      },
      {
        id: "3",
        type: "assistant_message",
        status: "completed",
        title: null,
        text: "Encontrei.",
        startedAt: ago(1),
      },
    ]);
    expect(events.map((event) => event.text)).toEqual(["Encontrei.", "$ rg foo"]);
  });

  it("formats ages", () => {
    expect(formatAge(42_000)).toBe("42s");
    expect(formatAge(5 * 60_000)).toBe("5m");
    expect(formatAge(83 * 60_000)).toBe("1h23");
  });
});
