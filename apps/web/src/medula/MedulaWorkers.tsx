import { useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Cpu, MessagesSquare } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import {
  fetchMedulaWorkerLog,
  fetchMedulaWorkers,
  formatMedulaElapsed,
  isMedulaWorkerRunning,
  MEDULA_WORKERS_POLL_MS,
  medulaWorkerElapsedMs,
  medulaWorkerTone,
  type MedulaWorker,
  type MedulaWorkerList,
  type MedulaWorkerLog,
  type MedulaWorkerTone,
} from "./medulaWorkerModel";
import { MedulaResumeStrip } from "./MedulaResumeStrip";

export const OperariosIcon = Cpu;

const FINISHED_SHOWN = 5;

const fetchMedulaWorkersForKey = () => fetchMedulaWorkers();

const TONE_DOT: Record<MedulaWorkerTone, string> = {
  running: "bg-success animate-pulse",
  done: "bg-muted-foreground/50",
  failed: "bg-destructive",
  rejected: "bg-warning",
  unknown: "bg-muted-foreground/30",
};

const LOG_SOURCE_LABEL: Record<MedulaWorkerLog["source"], string> = {
  out: "relatório",
  transcript: "transcrição",
  err: "erros",
  none: "sem saída",
};

/** Polls `fn` every 5 s while `enabled`; keeps the last good value. */
function usePolled<T>(enabled: boolean, key: string, fn: (key: string) => Promise<T>) {
  const [value, setValue] = useState<{ key: string; data: T } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => {
      fn(key).then(
        (data) => {
          if (cancelled) return;
          setValue({ key, data });
          setNow(Date.now());
        },
        () => {
          if (!cancelled) setNow(Date.now());
        },
      );
    };
    tick();
    const id = setInterval(tick, MEDULA_WORKERS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, key, fn]);
  return { data: value?.key === key ? value.data : null, now };
}

function WorkerLog({ id, visible }: { id: string; visible: boolean }) {
  const { data } = usePolled(visible, id, fetchMedulaWorkerLog);
  if (data === null) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">A ler…</p>;
  }
  return (
    <div className="mx-2 mb-1.5 rounded-md border border-border/60 bg-muted/40">
      <p className="border-b border-border/60 px-2 py-0.5 text-2xs text-muted-foreground">
        {LOG_SOURCE_LABEL[data.source]}
      </p>
      <ScrollArea className="max-h-64">
        <pre className="px-2 py-1.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-foreground">
          {data.text || "(vazio)"}
        </pre>
      </ScrollArea>
    </div>
  );
}

function WorkerRow({
  worker,
  now,
  open,
  visible,
  onToggle,
}: {
  worker: MedulaWorker;
  now: number;
  open: boolean;
  visible: boolean;
  onToggle: () => void;
}) {
  const elapsed = medulaWorkerElapsedMs(worker, now);
  const tone = medulaWorkerTone(worker.state);
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  return (
    <li className="group relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent/60"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span
          role="img"
          aria-label={worker.state}
          className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])}
        />
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium">{worker.id}</span>
          <span className="text-muted-foreground"> · </span>
          {worker.title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {[
            worker.model,
            elapsed === null ? null : formatMedulaElapsed(elapsed),
            tone === "running" ? null : worker.state,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {worker.t3ThreadId ? <span className="w-5 shrink-0" aria-hidden /> : null}
      </button>
      {worker.t3ThreadId && environmentId ? (
        // A delegated operário: its own T3 thread, also listed among this thread's agents.
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: worker.t3ThreadId as ThreadId }}
          title="T3 · abrir o thread do operário"
          aria-label={`Abrir o thread de ${worker.id} no T3`}
          className="absolute top-1 right-2 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <MessagesSquare aria-hidden className="size-3.5" />
        </Link>
      ) : null}
      {open ? <WorkerLog id={worker.id} visible={visible} /> : null}
    </li>
  );
}

function pickShown(list: MedulaWorkerList | null): MedulaWorker[] {
  if (list === null) return [];
  const running = list.workers.filter(isMedulaWorkerRunning);
  const finished = list.workers.filter((worker) => !isMedulaWorkerRunning(worker));
  return [...running, ...finished.slice(0, FINISHED_SHOWN)];
}

/**
 * Whether the server has a workers directory (T3CODE_MEDULA_WORKERS_DIR), asked once per app load
 * so the "Operários" tab is only offered where it has something to show. Null until known.
 */
let workersConfigured: boolean | null = null;
let workersConfiguredRequest: Promise<void> | null = null;
const configuredListeners = new Set<() => void>();

function subscribeWorkersConfigured(listener: () => void) {
  configuredListeners.add(listener);
  if (workersConfigured === null && workersConfiguredRequest === null) {
    workersConfiguredRequest = fetchMedulaWorkers().then(
      (list) => {
        workersConfigured = list.configured;
        for (const notify of configuredListeners) notify();
      },
      () => {
        // Retry on the next subscriber.
        workersConfiguredRequest = null;
      },
    );
  }
  return () => {
    configuredListeners.delete(listener);
  };
}

export function useMedulaWorkersConfigured(): boolean {
  return useSyncExternalStore(subscribeWorkersConfigured, () => workersConfigured === true);
}

/**
 * The "Operários" right-panel surface: background agents launched outside the conversation (one
 * state file each on the server), as visible as the conversation's own subagents. Polls only
 * while on screen.
 */
export function MedulaWorkers({ visible }: { visible: boolean }) {
  const { data, now } = usePolled(visible, "workers", fetchMedulaWorkersForKey);
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = pickShown(data);
  const running = data?.workers.filter(isMedulaWorkerRunning).length ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col" data-medula-workers>
      <MedulaResumeStrip visible={visible} />
      <p className="flex shrink-0 items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
        <OperariosIcon aria-hidden className="size-3.5" />
        Operários
        {data?.configured ? <span className="tabular-nums">· {running} a correr</span> : null}
      </p>
      <ScrollArea className="min-h-0 flex-1">
        {data === null ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">A ler…</p>
        ) : !data.configured ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            O servidor não tem pasta de operários.
          </p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Nenhum operário.</p>
        ) : (
          <ul className="flex flex-col p-1">
            {shown.map((worker) => (
              <WorkerRow
                key={worker.id}
                worker={worker}
                now={now}
                open={openId === worker.id}
                visible={visible}
                onToggle={() => setOpenId((current) => (current === worker.id ? null : worker.id))}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
