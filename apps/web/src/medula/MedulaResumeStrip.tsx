import { GaugeIcon } from "lucide-react";

import { medulaResumeSummary, useMedulaResume } from "./medulaResume";

/** «Quota gasta · N conversas à espera · próxima retoma às HH:MM» while the panel is open. */
export function MedulaResumeStrip({ visible }: { visible: boolean }) {
  const summary = medulaResumeSummary(useMedulaResume(visible));
  if (summary === null) return null;
  return (
    <div
      role="status"
      className="mx-2 my-1.5 flex shrink-0 items-center gap-2 rounded-md border border-warning/30 bg-warning/8 px-2.5 py-1.5 text-xs text-warning-foreground"
    >
      <GaugeIcon aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 truncate">{summary}</span>
    </div>
  );
}
