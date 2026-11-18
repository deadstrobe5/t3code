// Background work of a thread, live during runs too: subagents from `projection.subagents`, shells
// and monitors from the active provider thread's SDK roster (`pendingBackgroundTasks`), timed and
// narrated by the tool calls naming the task id and by `messages[].notification`.

import type { ThreadId } from "@t3tools/contracts";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import * as DateTime from "effect/DateTime";

export type BackgroundActivityKind = "subagent" | "command" | "monitor" | "task";
export type BackgroundActivityState =
  | "pending"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "stopped";

export interface BackgroundActivityEvent {
  readonly at: number | null;
  readonly text: string;
}

export interface BackgroundActivityItem {
  readonly id: string;
  readonly kind: BackgroundActivityKind;
  readonly label: string;
  readonly model: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly state: BackgroundActivityState;
  /** One line: the subagent's current step or the task's latest event. */
  readonly lastStep: string | null;
  /** Newest first, at most `MAX_EVENTS`. */
  readonly events: ReadonlyArray<BackgroundActivityEvent>;
  readonly childThreadId: ThreadId | null;
}

/** Finished work stays listed this long, so its outcome can be read. */
export const RECENTLY_FINISHED_MS = 10 * 60_000;
export const MAX_EVENTS = 5;

type Instant = DateTime.Utc | string | number | null | undefined;

interface SubagentLike {
  readonly id: string;
  readonly title: string | null;
  readonly prompt: string;
  readonly model: string | null;
  readonly modelSelection?: { readonly model?: string } | undefined;
  readonly status: string;
  readonly progress?: string | undefined;
  readonly result?: string | null;
  readonly startedAt: Instant;
  readonly completedAt: Instant;
  readonly updatedAt?: Instant;
  readonly childThreadId: ThreadId | null;
  readonly nativeTaskRef?: { readonly nativeId: string | null } | null;
}

interface RosterTaskLike {
  readonly taskId: string;
  readonly kind: string;
  readonly description?: string | undefined;
  readonly awaited?: true | undefined;
}

interface ProviderThreadLike {
  readonly id: string;
  readonly pendingBackgroundTasks?: ReadonlyArray<RosterTaskLike> | undefined;
}

interface TurnItemLike {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly title: string | null;
  readonly startedAt: Instant;
  readonly completedAt?: Instant;
  readonly updatedAt?: Instant;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly toolName?: string | null;
  readonly monitor?: boolean | undefined;
}

interface MessageLike {
  readonly text: string;
  readonly createdAt: Instant;
  readonly notification?:
    | {
        readonly source: { readonly kind: string };
        readonly outcome: string;
        readonly summary: string;
        readonly detail?: string | undefined;
      }
    | undefined;
}

export interface BackgroundActivityInput {
  readonly activeProviderThreadId?: string | null;
  readonly subagents: ReadonlyArray<SubagentLike>;
  readonly providerThreads: ReadonlyArray<ProviderThreadLike>;
  readonly turnItems: ReadonlyArray<TurnItemLike>;
  readonly messages: ReadonlyArray<MessageLike>;
}

export function toMillis(value: Instant): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return DateTime.toEpochMillis(value);
}

export function oneLine(text: string | null | undefined, max = 140): string | null {
  if (text === null || text === undefined) return null;
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length === 0) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function subagentState(status: string): BackgroundActivityState {
  switch (status) {
    case "pending":
    case "idle":
      return "pending";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

export function isLiveState(state: BackgroundActivityState): boolean {
  return state === "pending" || state === "running" || state === "waiting";
}

function rosterKind(kind: string): BackgroundActivityKind {
  if (kind === "command" || kind === "monitor" || kind === "subagent") return kind;
  return "task";
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

const BACKGROUND_ID_PATTERN = /running in background with ID: ([A-Za-z0-9_-]+)/u;

/** The task id a tool call launched, when its output says so. */
export function launchedTaskId(item: TurnItemLike): string | null {
  if (item.type === "command_execution") {
    const match = BACKGROUND_ID_PATTERN.exec(stringify(item.output));
    return match?.[1] ?? null;
  }
  if (item.type === "dynamic_tool") {
    const output = item.output;
    if (output !== null && typeof output === "object" && !Array.isArray(output)) {
      const taskId = Reflect.get(output, "taskId");
      if (typeof taskId === "string" && taskId.length > 0) return taskId;
    }
    const match = BACKGROUND_ID_PATTERN.exec(stringify(output));
    return match?.[1] ?? null;
  }
  return null;
}

function itemEventText(item: TurnItemLike, launched: boolean): string {
  const tool = item.type === "dynamic_tool" ? (item.toolName ?? "tool") : "Bash";
  if (launched) return `Começou (${tool})`;
  const output = oneLine(stringify(item.output), 120);
  const head =
    item.title ?? (item.type === "dynamic_tool" ? tool : oneLine(stringify(item.input), 60));
  return output === null ? (head ?? tool) : `${head ?? tool}: ${output}`;
}

function outcomeState(outcome: string): BackgroundActivityState | null {
  switch (outcome) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return null;
  }
}

function notificationText(message: MessageLike): string {
  const notification = message.notification;
  const detail = oneLine(notification?.detail, 120);
  const text = oneLine(message.text, 140);
  const summary = notification?.summary ?? "";
  // The message text often names the command where the summary only counts them.
  const base = text !== null && text !== "Background task completed." ? text : summary;
  return detail === null ? base : `${base}: ${detail}`;
}

function needleFor(label: string): string {
  return label.slice(0, 48);
}

interface TaskTrace {
  startedAt: number | null;
  launchedBy: TurnItemLike | null;
  events: Array<BackgroundActivityEvent>;
  finishedAt: number | null;
  finalState: BackgroundActivityState | null;
}

function traceTask(
  taskId: string,
  label: string | null,
  input: BackgroundActivityInput,
): TaskTrace {
  const trace: TaskTrace = {
    startedAt: null,
    launchedBy: null,
    events: [],
    finishedAt: null,
    finalState: null,
  };
  for (const item of input.turnItems) {
    if (item.type !== "command_execution" && item.type !== "dynamic_tool") continue;
    const launched = launchedTaskId(item) === taskId;
    if (
      !launched &&
      !stringify(item.input).includes(taskId) &&
      !stringify(item.output).includes(taskId)
    ) {
      continue;
    }
    const at = toMillis(item.startedAt) ?? toMillis(item.updatedAt);
    if (launched && (trace.startedAt === null || (at !== null && at < trace.startedAt))) {
      trace.startedAt = at;
      trace.launchedBy = item;
    }
    trace.events.push({ at, text: itemEventText(item, launched) });
  }
  const needles = [taskId, ...(label === null ? [] : [needleFor(label)])];
  for (const message of input.messages) {
    if (message.notification === undefined) continue;
    const haystack = `${message.text}\n${message.notification.summary}\n${message.notification.detail ?? ""}`;
    if (!needles.some((needle) => needle.length > 0 && haystack.includes(needle))) continue;
    const at = toMillis(message.createdAt);
    if (trace.startedAt !== null && at !== null && at < trace.startedAt) continue;
    trace.events.push({ at, text: notificationText(message) });
    const state = outcomeState(message.notification.outcome);
    if (state !== null && (trace.finishedAt === null || (at ?? 0) >= trace.finishedAt)) {
      trace.finalState = state;
      trace.finishedAt = at;
    }
  }
  return trace;
}

function newestFirst(
  events: ReadonlyArray<BackgroundActivityEvent>,
): Array<BackgroundActivityEvent> {
  return [...events].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_EVENTS);
}

function activeRoster(input: BackgroundActivityInput): ReadonlyArray<RosterTaskLike> {
  const threads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);
  const seen = new Set<string>();
  const tasks: Array<RosterTaskLike> = [];
  for (const thread of threads) {
    for (const task of thread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      tasks.push(task);
    }
  }
  return tasks;
}

const STATE_ORDER: Record<BackgroundActivityState, number> = {
  running: 0,
  waiting: 1,
  pending: 2,
  failed: 3,
  stopped: 4,
  done: 5,
};
const KIND_ORDER: Record<BackgroundActivityKind, number> = {
  subagent: 0,
  monitor: 1,
  command: 2,
  task: 3,
};

/**
 * The thread's background work, live first. `firstSeenAt` gives a start time to roster tasks
 * whose launching tool call is outside the loaded projection (e.g. a child subagent's shell).
 */
export function deriveBackgroundActivity(
  input: BackgroundActivityInput,
  now: number,
  firstSeenAt: (taskId: string) => number | null = () => null,
): ReadonlyArray<BackgroundActivityItem> {
  const items: Array<BackgroundActivityItem> = [];
  const subagentTaskIds = new Set<string>();

  for (const agent of input.subagents) {
    const nativeId = agent.nativeTaskRef?.nativeId;
    if (typeof nativeId === "string") subagentTaskIds.add(nativeId);
    const state = subagentState(agent.status);
    const finishedAt = isLiveState(state)
      ? null
      : (toMillis(agent.completedAt) ?? toMillis(agent.updatedAt));
    if (!isLiveState(state) && (finishedAt === null || now - finishedAt > RECENTLY_FINISHED_MS)) {
      continue;
    }
    const title = oneLine(agent.title) ?? oneLine(agent.prompt, 80) ?? "Subagente";
    const lastStep = isLiveState(state)
      ? oneLine(agent.progress)
      : (oneLine(agent.result) ?? oneLine(agent.progress));
    items.push({
      id: `subagent:${agent.id}`,
      kind: "subagent",
      label: formatSubagentDisplayTitle(title),
      model: agent.modelSelection?.model ?? agent.model ?? null,
      startedAt: toMillis(agent.startedAt),
      finishedAt,
      state,
      lastStep,
      events: lastStep === null ? [] : [{ at: toMillis(agent.updatedAt), text: lastStep }],
      childThreadId: agent.childThreadId,
    });
  }

  const roster = activeRoster(input);
  const rosterIds = new Set(roster.map((task) => task.taskId));
  for (const task of roster) {
    if (task.kind === "subagent" && subagentTaskIds.has(task.taskId)) continue;
    const label = oneLine(task.description, 160);
    const trace = traceTask(task.taskId, label, input);
    const events = newestFirst(trace.events);
    const kind =
      task.kind === "command" && trace.launchedBy?.monitor === true
        ? "monitor"
        : rosterKind(task.kind);
    items.push({
      id: `task:${task.taskId}`,
      kind,
      label: label ?? task.taskId,
      model: null,
      startedAt: trace.startedAt ?? firstSeenAt(task.taskId),
      finishedAt: null,
      state: task.awaited === true ? "waiting" : "running",
      lastStep: events[0]?.text ?? null,
      events,
      childThreadId: null,
    });
  }

  // Tasks this thread launched that already left the roster: keep them while recent.
  for (const item of input.turnItems) {
    const taskId = launchedTaskId(item);
    if (taskId === null || rosterIds.has(taskId) || subagentTaskIds.has(taskId)) continue;
    const startedAt = toMillis(item.startedAt) ?? toMillis(item.updatedAt);
    if (startedAt === null || now - startedAt > 6 * 60 * 60_000) continue;
    const label =
      item.type === "command_execution"
        ? (oneLine(item.title) ?? oneLine(stringify(item.input), 160))
        : oneLine(stringify(Reflect.get(Object(item.input), "description")), 160);
    const trace = traceTask(taskId, label, input);
    const finishedAt = trace.finishedAt ?? toMillis(item.completedAt) ?? startedAt;
    if (now - finishedAt > RECENTLY_FINISHED_MS) continue;
    if (items.some((existing) => existing.id === `task:${taskId}`)) continue;
    const events = newestFirst(trace.events);
    items.push({
      id: `task:${taskId}`,
      kind: item.type === "dynamic_tool" || item.monitor === true ? "monitor" : "command",
      label: label ?? taskId,
      model: null,
      startedAt,
      finishedAt,
      state: trace.finalState ?? "done",
      lastStep: events[0]?.text ?? null,
      events,
      childThreadId: null,
    });
  }

  return items.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
}

/** The last steps of a subagent's own thread, newest first, one line each. */
export function recentChildEvents(
  turnItems: ReadonlyArray<TurnItemLike & { readonly text?: string }>,
  limit = MAX_EVENTS,
): ReadonlyArray<BackgroundActivityEvent> {
  const events: Array<BackgroundActivityEvent> = [];
  for (const item of turnItems) {
    let text: string | null = null;
    switch (item.type) {
      case "command_execution":
        text = oneLine(item.title) ?? oneLine(stringify(item.input), 120);
        text = text === null ? null : `$ ${text}`;
        break;
      case "dynamic_tool":
        text = oneLine(item.title) ?? item.toolName ?? null;
        break;
      case "file_change":
      case "file_search":
      case "web_search":
        text = oneLine(item.title) ?? item.type;
        break;
      case "assistant_message":
        text = oneLine(item.text);
        break;
      default:
        text = null;
    }
    if (text === null) continue;
    events.push({ at: toMillis(item.startedAt) ?? toMillis(item.updatedAt), text });
  }
  return events.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
}

export function countLive(items: ReadonlyArray<BackgroundActivityItem>): number {
  return items.filter((item) => isLiveState(item.state)).length;
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}`;
}
