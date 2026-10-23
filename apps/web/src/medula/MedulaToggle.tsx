import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { MedulaIcon, MedulaUnreadBadge, useMedulaUnreadCount } from "./MedulaPanel";
import { MEDULA_DEFAULT_TITLE, useMedulaStore } from "./medulaStore";

interface MedulaToggleProps {
  open: boolean;
  onToggle: () => void;
}

function MedulaToggleButton({ open, onToggle }: MedulaToggleProps) {
  const unread = useMedulaUnreadCount();
  const title = useMedulaStore((state) => state.title.trim() || MEDULA_DEFAULT_TITLE);
  const label = unread > 0 ? `${title} (${unread} novos)` : title;
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
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Header control that opens the Medula panel, with the count of items not seen yet. */
export function MedulaToggle(props: MedulaToggleProps) {
  const enabled = useMedulaStore((state) => state.enabled);
  return enabled ? <MedulaToggleButton {...props} /> : null;
}
