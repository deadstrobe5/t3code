import { Waypoints } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { readLocalApi } from "~/localApi";

import { readMedulaBaseUrl, useMedulaStore } from "./medulaStore";

function openMedulaPainel() {
  const url = readMedulaBaseUrl();
  const api = readLocalApi();
  if (api) {
    // Desktop: shell.openExternal through the bridge; web: a new tab.
    void api.shell.openExternal(url).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** Header button that opens the Medula painel outside T3. */
export function MedulaLinkButton() {
  // Subscribed so the tooltip follows the address set in Settings.
  useMedulaStore((state) => state.url);
  const url = readMedulaBaseUrl();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="shrink-0 [-webkit-app-region:no-drag]"
            variant="ghost"
            size="sm"
            aria-label="Medula"
            onClick={openMedulaPainel}
          />
        }
      >
        <Waypoints className="size-4" />
        Medula
      </TooltipTrigger>
      <TooltipPopup side="bottom">Abrir {url}</TooltipPopup>
    </Tooltip>
  );
}
