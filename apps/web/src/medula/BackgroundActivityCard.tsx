import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon, EyeIcon, SquareTerminalIcon, TimerIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useNowSecond } from "../hooks/useNowSecond";
import { useThreadProjection } from "../state/entities";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import {
  countLive,
  deriveBackgroundActivity,
  formatAge,
  recentChildEvents,
  type BackgroundActivityEvent,
  type BackgroundActivityItem,
  type BackgroundActivityKind,
  type BackgroundActivityState,
} from "./backgroundActivity";

const STATE_DOT: Record<BackgroundActivityState, string> = {
  running: "bg-emerald-500 animate-pulse",
  waiting: "bg-sky-500",
  pending: "bg-amber-400",
  done: "bg-muted-foreground/40",
  failed: "bg-red-500",
  stopped: "bg-zinc-400",
};

const STATE_LABEL: Record<BackgroundActivityState, string> = {
  running: "a correr",
  waiting: "à espera",
  pending: "na fila",
  done: "acabou",
  failed: "falhou",
  stopped: "parado",
};

const KIND_ICON: Record<BackgroundActivityKind, typeof BotIcon> = {
  subagent: BotIcon,
  command: SquareTerminalIcon,
  monitor: EyeIcon,
  task: TimerIcon,
};

const KIND_LABEL: Record<BackgroundActivityKind, string> = {
  subagent: "subagente",
  command: "comando",
  monitor: "monitor",
  task: "tarefa",
};

// Roster tasks launched outside the loaded projection get their age from when we first saw them.
const firstSeen = new Map<string, number>();
function firstSeenAt(taskId: string): number {
  const known = firstSeen.get(taskId);
  if (known !== undefined) return known;
  const now = Date.now();
  firstSeen.set(taskId, now);
  return now;
}

function shortModel(model: string | null): string | null {
  if (model === null) return null;
  return model.replace(/^claude-/u, "").replace(/-\d{8}$/u, "");
}

function EventList(props: {
  readonly events: ReadonlyArray<BackgroundActivityEvent>;
  readonly now: number;
}) {
  if (props.events.length === 0) {
    return <p className="m-0 py-1 text-xs text-muted-foreground/70">Sem eventos ainda.</p>;
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-0.5 p-0" data-background-activity-events>
      {props.events.map((event) => (
        <li key={`${event.at ?? "x"}:${event.text}`} className="flex min-w-0 gap-2 text-xs">
          <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground/70">
            {event.at === null ? "" : formatAge(props.now - event.at)}
          </span>
          <span className="min-w-0 truncate text-foreground/75">{event.text}</span>
        </li>
      ))}
    </ol>
  );
}

function ChildEvents(props: {
  readonly environmentId: EnvironmentId;
  readonly childThreadId: ThreadId;
  readonly fallback: ReadonlyArray<BackgroundActivityEvent>;
  readonly now: number;
}) {
  const projection =
    useThreadProjection(scopeThreadRef(props.environmentId, props.childThreadId))?.projection ??
    null;
  const events =
    projection === null ? props.fallback : recentChildEvents(projection.turnItems as never);
  return <EventList events={events.length > 0 ? events : props.fallback} now={props.now} />;
}

export function BackgroundActivityRow(props: {
  readonly item: BackgroundActivityItem;
  readonly now: number;
  readonly environmentId?: EnvironmentId | undefined;
  readonly defaultExpanded?: boolean;
}) {
  const { item, now } = props;
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false);
  const Icon = KIND_ICON[item.kind];
  const model = shortModel(item.model);
  const age = item.startedAt === null ? null : formatAge((item.finishedAt ?? now) - item.startedAt);
  return (
    <li data-background-activity-row data-state={item.state} data-kind={item.kind}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-black/[0.035] dark:hover:bg-white/[0.08]"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            aria-label={STATE_LABEL[item.state]}
            className={cn("size-2 shrink-0 rounded-full", STATE_DOT[item.state])}
          />
          <Icon
            aria-label={KIND_LABEL[item.kind]}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              item.state === "done" || item.state === "stopped"
                ? "text-muted-foreground"
                : "text-foreground/85",
            )}
          >
            {item.label}
          </span>
          {model === null ? null : (
            <span className="shrink-0 rounded bg-muted px-1 text-3xs text-muted-foreground">
              {model}
            </span>
          )}
          {age === null ? null : (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{age}</span>
          )}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </span>
        {item.lastStep === null ? null : (
          <span className="block w-full truncate ps-8 text-xs text-muted-foreground">
            {item.lastStep}
          </span>
        )}
      </button>
      {expanded ? (
        <div className="ps-10 pe-2.5 pb-1.5">
          {item.childThreadId !== null && props.environmentId !== undefined ? (
            <ChildEvents
              environmentId={props.environmentId}
              childThreadId={item.childThreadId}
              fallback={item.events}
              now={now}
            />
          ) : (
            <EventList events={item.events} now={now} />
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Pure view, so tests render it without the store. */
export function BackgroundActivityList(props: {
  readonly items: ReadonlyArray<BackgroundActivityItem>;
  readonly now: number;
  readonly environmentId?: EnvironmentId | undefined;
}) {
  if (props.items.length === 0) return null;
  const live = countLive(props.items);
  return (
    <ThreadDetailsSection
      headingId="thread-details-background-heading"
      title={`Em fundo (${live})`}
      data-background-activity-panel
    >
      <ul
        aria-label="Atividades em fundo"
        className="m-0 max-h-104 list-none overflow-y-auto overscroll-contain p-0"
      >
        {props.items.map((item) => (
          <BackgroundActivityRow
            key={item.id}
            item={item}
            now={props.now}
            environmentId={props.environmentId}
          />
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}

export function BackgroundActivityCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection =
    useThreadProjection(scopeThreadRef(props.environmentId, props.threadId))?.projection ?? null;
  const now = useNowSecond();
  if (projection === null) return null;
  const items = deriveBackgroundActivity(
    {
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      subagents: projection.subagents,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems as never,
      messages: projection.messages,
    },
    now,
    firstSeenAt,
  );
  return <BackgroundActivityList items={items} now={now} environmentId={props.environmentId} />;
}
