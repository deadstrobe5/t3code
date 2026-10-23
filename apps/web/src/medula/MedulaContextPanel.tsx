import {
  Archive,
  BellRing,
  BellDot,
  ChevronRight,
  Clock,
  Inbox,
  Lightbulb,
  MessageSquare,
  OctagonX,
  PenLine,
  Search,
  Settings2,
  Webhook,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  countMedulaContextOrigins,
  filterMedulaContextGroups,
  formatMedulaChars,
  formatMedulaContextSummary,
  isMedulaContextBlockNew,
  MEDULA_CONTEXT_ORIGIN_LABELS,
  MEDULA_CONTEXT_ORIGINS,
  MEDULA_CONTEXT_POLL_MS,
  MEDULA_CONTEXT_START_GROUP_ID,
  MEDULA_CONTEXT_UNAVAILABLE_LABELS,
  type MedulaContextBlock,
  type MedulaContextGroupView,
  type MedulaContextOrigin,
  type MedulaContextResponse,
} from "./medulaContext";
import {
  fetchMedulaContext,
  markMedulaContextSeen,
  noteMedulaContextLatest,
  readContextSeenAt,
  useMedulaContextStore,
  usePolling,
} from "./medulaContextStore";
import { useMedulaStore } from "./medulaStore";

const ORIGIN_ICONS: Record<MedulaContextOrigin, typeof Clock> = {
  hora: Clock,
  mordomo: BellRing,
  canalizador: Wrench,
  correcao: PenLine,
  ideias: Lightbulb,
  hook: Webhook,
  stop: OctagonX,
  notificacao: BellDot,
  compactacao: Archive,
  sistema: Settings2,
};

/** Chip colours from the app's status tokens; the icon tells apart origins sharing a tone. */
const ORIGIN_CHIP: Record<MedulaContextOrigin, string> = {
  hora: "bg-muted text-muted-foreground",
  mordomo: "bg-success/12 text-success-foreground",
  canalizador: "bg-info/12 text-info-foreground",
  correcao: "bg-warning/14 text-warning-foreground",
  ideias: "bg-warning/14 text-warning-foreground",
  hook: "bg-primary/10 text-primary",
  stop: "bg-destructive/12 text-destructive-foreground",
  notificacao: "bg-info/12 text-info-foreground",
  compactacao: "bg-muted text-foreground/70",
  sistema: "bg-muted text-muted-foreground",
};

const clockFormatter = new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit" });
const fullFormatter = new Intl.DateTimeFormat("pt-PT", {
  dateStyle: "short",
  timeStyle: "medium",
});

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : clockFormatter.format(date);
}

function formatFull(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : fullFormatter.format(date);
}

function Timestamp({ at, children }: { at: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={at} />}>{children}</TooltipTrigger>
      <TooltipPopup>{formatFull(at)}</TooltipPopup>
    </Tooltip>
  );
}

function OriginChip({ origin }: { origin: MedulaContextOrigin }) {
  const Icon = ORIGIN_ICONS[origin];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-px text-2xs font-medium",
        ORIGIN_CHIP[origin],
      )}
    >
      <Icon aria-hidden className="size-3" />
      {MEDULA_CONTEXT_ORIGIN_LABELS[origin]}
    </span>
  );
}

function BlockCard({
  block,
  isNew,
  open,
  onToggle,
}: {
  block: MedulaContextBlock;
  isNew: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="rounded-md border border-border/60 bg-card/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <OriginChip origin={block.origin} />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{block.label}</span>
        {isNew ? (
          <span aria-label="Novo" className="size-1.5 shrink-0 rounded-full bg-primary" />
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          <Timestamp at={block.at}>{formatRelativeTimeLabel(block.at)}</Timestamp>
          {" · "}
          {formatMedulaChars(block.chars)}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 pt-2 pb-2.5">
          {block.event ? (
            <p className="mb-1.5 font-mono text-2xs text-muted-foreground">{block.event}</p>
          ) : null}
          {block.text.trim() === "" ? (
            <p className="text-xs text-muted-foreground">Bloco vazio.</p>
          ) : (
            <ChatMarkdown text={block.text} cwd={undefined} lineBreaks parseRawHtml={false} />
          )}
          {block.truncated ? (
            <p className="mt-2 text-xs text-muted-foreground italic">
              Texto cortado: o bloco tinha {formatMedulaChars(block.chars)}.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function GroupSection({
  view,
  open,
  onToggle,
  seenAt,
  openBlocks,
  onToggleBlock,
}: {
  view: MedulaContextGroupView;
  open: boolean;
  onToggle: () => void;
  seenAt: number | null;
  openBlocks: ReadonlySet<string>;
  onToggleBlock: (id: string) => void;
}) {
  const { group, blocks, hidden } = view;
  const isStart = group.id === MEDULA_CONTEXT_START_GROUP_ID || group.prompt === null;
  const chars = blocks.reduce((total, block) => total + block.chars, 0);
  const newCount = blocks.filter((block) => isMedulaContextBlockNew(block, seenAt)).length;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {isStart ? (
          <Inbox aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <MessageSquare aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "line-clamp-2 text-sm wrap-anywhere",
              isStart ? "text-muted-foreground italic" : "font-medium text-foreground",
            )}
          >
            {isStart ? "Início da sessão" : group.prompt}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            {group.at ? <Timestamp at={group.at}>{formatClock(group.at)}</Timestamp> : null}
            <span>
              · {blocks.length} {blocks.length === 1 ? "bloco" : "blocos"} ·{" "}
              {formatMedulaChars(chars)}
            </span>
            {newCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-primary">
                <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                {newCount} {newCount === 1 ? "novo" : "novos"}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1 pt-0.5 pb-2 pl-6">
          {blocks.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {blocks.map((block) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  isNew={isMedulaContextBlockNew(block, seenAt)}
                  open={openBlocks.has(block.id)}
                  onToggle={() => onToggleBlock(block.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="px-2 text-xs text-muted-foreground">Nada entrou com estes filtros.</p>
          )}
          {hidden > 0 ? (
            <p className="px-2 text-2xs text-muted-foreground">
              {hidden} {hidden === 1 ? "bloco oculto" : "blocos ocultos"} pelos filtros
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

type Loaded =
  | { threadId: string; response: MedulaContextResponse; error: null }
  | { threadId: string; response: MedulaContextResponse | null; error: string };

function Notice({ children }: { children: string }) {
  return <p className="px-3 py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

/**
 * Everything that entered the active chat's Claude session besides the operator's messages,
 * grouped under the message it followed, newest first.
 */
export function MedulaContext({ visible }: { visible: boolean }) {
  const threadId = useMedulaContextStore((state) => state.threadId);
  const origins = useMedulaStore((state) => state.contextOrigins);
  const update = useMedulaStore((state) => state.update);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [query, setQuery] = useState("");
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [openBlocks, setOpenBlocks] = useState<ReadonlySet<string>>(() => new Set());
  const pollKey = visible ? threadId : null;

  // The mark as it was when the view came up, so the "new" dots survive the mark moving.
  const [opened, setOpened] = useState<{ key: string | null; seenAt: number | null }>({
    key: null,
    seenAt: null,
  });
  if (opened.key !== pollKey) {
    setOpened({ key: pollKey, seenAt: pollKey === null ? null : readContextSeenAt(pollKey) });
  }

  usePolling(pollKey, MEDULA_CONTEXT_POLL_MS, () => {
    if (threadId === null) return;
    fetchMedulaContext(threadId, false).then(
      (response) => {
        noteMedulaContextLatest(threadId, response);
        if (response.available) markMedulaContextSeen(threadId, response.latestBlockAt);
        setLoaded({ threadId, response, error: null });
      },
      (error: unknown) => {
        setLoaded((current) => ({
          threadId,
          response: current?.threadId === threadId ? current.response : null,
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    );
  });

  const current = loaded?.threadId === threadId ? loaded : null;
  const response = current?.response ?? null;
  const groups = response?.available ? (response.groups ?? []) : [];
  const views = useMemo(
    () => filterMedulaContextGroups(groups, { origins, query }),
    [groups, origins, query],
  );
  const originCounts = useMemo(() => countMedulaContextOrigins(groups), [groups]);
  // Only origins present in this conversation: a wall of zero chips reads as noise.
  const shownOrigins = MEDULA_CONTEXT_ORIGINS.filter((origin) => originCounts[origin] > 0);

  if (threadId === null) {
    return <Notice>Abre uma conversa deste servidor para ver o contexto que lhe entra.</Notice>;
  }
  if (current === null) {
    return <Notice>A ler o contexto…</Notice>;
  }
  if (response === null) {
    return <Notice>{`Não consegui ler o contexto (${current.error ?? "erro"}).`}</Notice>;
  }
  if (!response.available) {
    return <Notice>{MEDULA_CONTEXT_UNAVAILABLE_LABELS[response.reason]}</Notice>;
  }

  const newestId = views[0]?.group.id;
  const isGroupOpen = (id: string) => groupOpen[id] ?? id === newestId;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-medula-context>
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-1.5">
        <p className="flex items-center gap-1.5 text-xs text-foreground/80">
          <Inbox aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {formatMedulaContextSummary(response.sinceLastPrompt)}
          </span>
          {current.error !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="ml-auto shrink-0 text-destructive-foreground" />}
              >
                desatualizado
              </TooltipTrigger>
              <TooltipPopup>{`Última leitura falhou: ${current.error}`}</TooltipPopup>
            </Tooltip>
          ) : null}
        </p>
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            type="search"
            aria-label="Procurar nos blocos"
            placeholder="Procurar nos blocos…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </InputGroup>
        <ToggleGroup
          multiple
          variant="pill"
          size="segmented"
          aria-label="Filtrar por origem"
          className="flex-wrap"
          value={origins}
          onValueChange={(value) =>
            update({
              contextOrigins: MEDULA_CONTEXT_ORIGINS.filter((origin) =>
                (value as string[]).includes(origin),
              ),
            })
          }
        >
          {shownOrigins.map((origin) => {
            const Icon = ORIGIN_ICONS[origin];
            return (
              <Toggle key={origin} value={origin}>
                <Icon aria-hidden className="size-3" />
                {MEDULA_CONTEXT_ORIGIN_LABELS[origin]}
                <span className="tabular-nums opacity-70">{originCounts[origin]}</span>
              </Toggle>
            );
          })}
        </ToggleGroup>
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-border/60">
        <ScrollArea className="min-h-0 flex-1">
          {views.length === 0 ? (
            <Notice>
              {query.trim() ? "Nenhum bloco corresponde à procura." : "Ainda não entrou nada."}
            </Notice>
          ) : (
            <ul className="flex flex-col gap-0.5 p-1">
              {views.map((view) => (
                <GroupSection
                  key={view.group.id}
                  view={view}
                  open={isGroupOpen(view.group.id)}
                  onToggle={() =>
                    setGroupOpen((state) => ({
                      ...state,
                      [view.group.id]: !isGroupOpen(view.group.id),
                    }))
                  }
                  seenAt={opened.seenAt}
                  openBlocks={openBlocks}
                  onToggleBlock={(id) =>
                    setOpenBlocks((state) => {
                      const next = new Set(state);
                      if (!next.delete(id)) next.add(id);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
