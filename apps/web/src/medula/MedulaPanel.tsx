import { BellRing, Brain, ExternalLink, Lightbulb, RefreshCw, Send, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { ConnectionStatusDot } from "~/components/ConnectionStatusDot";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  countUnseenMedulaItems,
  MEDULA_BLOCKS,
  type MedulaBlock,
  type MedulaItem,
} from "./medulaFeed";
import {
  postMedulaIdea,
  readMedulaLastSeenAt,
  reconnectMedulaFeed,
  retainMedulaFeed,
  useMedulaBaseUrl,
  useMedulaStore,
} from "./medulaStore";

export const MEDULA_BLOCK_LABELS: Record<MedulaBlock, string> = {
  ideias: "Ideias",
  pensamentos: "O que o líder pensa",
  mordomo: "Mordomo",
};

const BLOCK_ICONS: Record<MedulaBlock, typeof Lightbulb> = {
  ideias: Lightbulb,
  pensamentos: Brain,
  mordomo: BellRing,
};

const BLOCK_TONES: Record<MedulaBlock, string> = {
  ideias: "text-warning",
  pensamentos: "text-info",
  mordomo: "text-success",
};

export const MedulaIcon = Waypoints;

/** Keeps relative timestamps fresh without repainting faster than they change. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(id);
  }, []);
}

function FeedRow({ item, unseen }: { item: MedulaItem; unseen: boolean }) {
  const Icon = BLOCK_ICONS[item.block];
  const at = new Date(item.at).toISOString();
  return (
    <li className="flex gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <Tooltip>
        <TooltipTrigger render={<span className="mt-0.5 inline-flex shrink-0" />}>
          <Icon
            role="img"
            aria-label={MEDULA_BLOCK_LABELS[item.block]}
            className={cn("size-3.5", BLOCK_TONES[item.block])}
          />
        </TooltipTrigger>
        <TooltipPopup>{MEDULA_BLOCK_LABELS[item.block]}</TooltipPopup>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-4 text-sm wrap-anywhere text-foreground">{item.text}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {unseen ? (
            <span aria-label="Novo" className="size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
          <time dateTime={at} className="shrink-0">
            {formatRelativeTimeLabel(at)}
          </time>
          {item.detail ? <span className="min-w-0 truncate">· {item.detail}</span> : null}
        </p>
      </div>
    </li>
  );
}

function ThinkAloud({ baseUrl }: { baseUrl: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "ok"; message: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const texto = text.trim();
    if (texto.length === 0 || sending) return;
    setSending(true);
    setStatus(null);
    const result = await postMedulaIdea(baseUrl, texto);
    setSending(false);
    if (result.ok) {
      setText("");
      setStatus({ tone: "ok", message: "Ideia registada." });
    } else {
      setStatus({ tone: "error", message: result.error });
    }
    // Ideas come in bursts: stay in the field for the next one.
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5 border-t border-border/60 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-1.5">
        <Textarea
          size="sm"
          className="min-w-0 flex-1"
          aria-label="Pensar em voz alta"
          placeholder="Pensar em voz alta… (Enter regista, Shift+Enter muda de linha)"
          ref={textareaRef}
          value={text}
          readOnly={sending}
          onChange={(event) => {
            setText(event.currentTarget.value);
            if (status?.tone === "ok") setStatus(null);
          }}
          onKeyDown={onKeyDown}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="submit"
                size="icon-sm"
                aria-label="Registar ideia"
                disabled={sending || text.trim().length === 0}
              />
            }
          >
            <Send />
          </TooltipTrigger>
          <TooltipPopup>Registar na caixa de ideias</TooltipPopup>
        </Tooltip>
      </div>
      {status ? (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          className={cn(
            "text-xs wrap-anywhere",
            status.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {status.message}
        </p>
      ) : null}
    </form>
  );
}

function HubFrame({
  baseUrl,
  title,
  reloadKey,
}: {
  baseUrl: string;
  title: string;
  reloadKey: number;
}) {
  return (
    // No sandbox: the hub is a trusted page on another origin (its own port), so it already
    // cannot reach into this one, and it needs its own storage and API calls.
    // oxlint-disable-next-line react/iframe-missing-sandbox
    <iframe
      key={`${baseUrl}#${reloadKey}`}
      src={baseUrl}
      title={title}
      className="size-full border-0 bg-background"
      referrerPolicy="no-referrer"
    />
  );
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-0 flex-col", className)}>{children}</div>;
}

/**
 * The hub between the person and the agents: the medula dashboard, its live feed, and a box to
 * think out loud straight into the idea queue.
 */
export function MedulaPanel({ visible }: { visible: boolean }) {
  useEffect(() => retainMedulaFeed(), []);
  useMinuteTick();
  const baseUrl = useMedulaBaseUrl();
  const title = useMedulaStore((state) => state.title.trim() || "Medula");
  const items = useMedulaStore((state) => state.items);
  const connection = useMedulaStore((state) => state.connection);
  const filters = useMedulaStore((state) => state.filters);
  const showHub = useMedulaStore((state) => state.showHub);
  const update = useMedulaStore((state) => state.update);
  // Read once per opening so the "new" dots survive the mark that clears the badge.
  const [seenAtOpen, setSeenAtOpen] = useState(readMedulaLastSeenAt);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setSeenAtOpen(readMedulaLastSeenAt());
  }
  const [reloadKey, setReloadKey] = useState(0);

  // While the panel is on screen everything that arrives counts as seen.
  useEffect(() => {
    if (!visible) return;
    useMedulaStore.getState().markSeen();
    return useMedulaStore.subscribe((next, previous) => {
      if (next.items !== previous.items) next.markSeen();
    });
  }, [visible]);

  const visibleItems = useMemo(
    () => items.filter((item) => filters.includes(item.block)),
    [items, filters],
  );
  const connected = connection === "open";
  const statusLabel = connected
    ? `Ligado a ${baseUrl}`
    : connection === "connecting"
      ? `A ligar a ${baseUrl}…`
      : `Sem ligação a ${baseUrl}`;

  return (
    <div className="flex h-full min-h-0 flex-col" data-medula-panel>
      <div className="flex min-h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1">
        <ConnectionStatusDot
          tooltipText={statusLabel}
          dotClassName={connected ? "bg-success" : "bg-destructive"}
        />
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        {!connected ? (
          <span className="shrink-0 text-xs text-muted-foreground">sem ligação</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Recarregar"
                  onClick={() => {
                    setReloadKey((value) => value + 1);
                    reconnectMedulaFeed();
                  }}
                />
              }
            >
              <RefreshCw />
            </TooltipTrigger>
            <TooltipPopup>Recarregar o painel e a ligação</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Abrir num separador"
                  render={<a href={baseUrl} target="_blank" rel="noreferrer" />}
                />
              }
            >
              <ExternalLink />
            </TooltipTrigger>
            <TooltipPopup>Abrir {baseUrl} num separador</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {showHub ? (
        <Section className="min-h-40 flex-[3] border-b border-border/60">
          <HubFrame baseUrl={baseUrl} title={title} reloadKey={reloadKey} />
        </Section>
      ) : null}

      <Section className="flex-[2]">
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 py-1.5">
          <ToggleGroup
            multiple
            aria-label="Filtros do feed"
            value={filters}
            onValueChange={(value) =>
              update({
                filters: MEDULA_BLOCKS.filter((block) => (value as string[]).includes(block)),
              })
            }
          >
            {MEDULA_BLOCKS.map((block) => (
              <Toggle key={block} value={block}>
                {MEDULA_BLOCK_LABELS[block]}
              </Toggle>
            ))}
          </ToggleGroup>
          <ToggleGroup
            aria-label="Painel"
            className="ml-auto"
            value={showHub ? ["hub"] : []}
            onValueChange={(value) => update({ showHub: (value as string[]).includes("hub") })}
          >
            <Toggle value="hub">Painel</Toggle>
          </ToggleGroup>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {visibleItems.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {connected ? "Nada por agora." : `Sem ligação a ${baseUrl}api/eventos`}
            </p>
          ) : (
            <ul className="flex flex-col p-1">
              {visibleItems.map((item) => (
                <FeedRow key={item.key} item={item} unseen={item.at > seenAtOpen} />
              ))}
            </ul>
          )}
        </ScrollArea>
      </Section>

      <ThinkAloud baseUrl={baseUrl} />
    </div>
  );
}

/** Unread count for the header toggle; retains the feed so the count moves while closed. */
export function useMedulaUnreadCount(): number {
  useEffect(() => retainMedulaFeed(), []);
  const items = useMedulaStore((state) => state.items);
  const lastSeenAt = useMedulaStore((state) => state.lastSeenAt ?? Number.POSITIVE_INFINITY);
  return useMemo(() => countUnseenMedulaItems(items, lastSeenAt), [items, lastSeenAt]);
}

export function MedulaUnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    // Same count-over-icon mark as the pull request composer.
    <span
      aria-hidden
      className="pointer-events-none absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
