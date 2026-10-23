import { ChevronRight, Cpu } from "lucide-react";
import { useEffect, useState } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

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

function WorkerLog({ id }: { id: string }) {
  const { data } = usePolled(true, id, fetchMedulaWorkerLog);
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
          {data.text || "—"}
        </pre>
      </ScrollArea>
    </div>
  );
}

function WorkerRow({
  worker,
  now,
  open,
  onToggle,
}: {
  worker: MedulaWorker;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const elapsed = medulaWorkerElapsedMs(worker, now);
  const tone = medulaWorkerTone(worker.state);
  return (
    <li>
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
      </button>
      {open ? <WorkerLog id={worker.id} /> : null}
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
 * Background agents launched outside the conversation (one state file each on the server),
 * listed next to the feed so they are as visible as the conversation's own subagents.
 */
export function MedulaWorkers({ visible }: { visible: boolean }) {
  const { data, now } = usePolled(visible, "workers", fetchMedulaWorkersForKey);
  const [openId, setOpenId] = useState<string | null>(null);
  if (data === null || !data.configured) return null;
  const shown = pickShown(data);
  const running = data.workers.filter(isMedulaWorkerRunning).length;
  return (
    <div
      className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-border/60"
      data-medula-workers
    >
      <p className="flex shrink-0 items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
        <Cpu aria-hidden className="size-3.5" />
        Operários
        <span className="tabular-nums">· {running} a correr</span>
      </p>
      <ScrollArea className="min-h-0 flex-1">
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Nenhum operário.</p>
        ) : (
          <ul className="flex flex-col p-1">
            {shown.map((worker) => (
              <WorkerRow
                key={worker.id}
                worker={worker}
                now={now}
                open={openId === worker.id}
                onToggle={() => setOpenId((current) => (current === worker.id ? null : worker.id))}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
