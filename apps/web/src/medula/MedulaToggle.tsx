import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useMedulaContextUnseen } from "./medulaContextStore";
import { MedulaIcon, MedulaUnreadBadge, useMedulaUnreadCount } from "./MedulaPanel";
import { MEDULA_DEFAULT_TITLE, useMedulaStore } from "./medulaStore";

interface MedulaToggleProps {
  open: boolean;
  onToggle: () => void;
}

function MedulaToggleButton({ open, onToggle }: MedulaToggleProps) {
  const unread = useMedulaUnreadCount();
  const title = useMedulaStore((state) => state.title.trim() || MEDULA_DEFAULT_TITLE);
  const contextUnseen = useMedulaContextUnseen();
  const notes = [
    unread > 0 ? `${unread} novos` : null,
    contextUnseen ? "contexto novo nesta conversa" : null,
  ].filter(Boolean);
  const label = notes.length > 0 ? `${title} (${notes.join(", ")})` : title;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="relative flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={open}
          onPressedChange={onToggle}
          aria-label={label}
          variant="ghost"
          size="sm"
        >
          <MedulaIcon className="size-4" />
        </Toggle>
        <MedulaUnreadBadge count={unread} />
        {contextUnseen ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-warning ring-2 ring-background"
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Header control that opens the Medula panel, with the count of feed items not seen yet and a dot
 * when context entered this conversation since the Contexto view was last on screen.
 */
export function MedulaToggle(props: MedulaToggleProps) {
  const enabled = useMedulaStore((state) => state.enabled);
  return enabled ? <MedulaToggleButton {...props} /> : null;
}
