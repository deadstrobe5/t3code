import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Input } from "~/components/ui/input";

import { resolveMedulaBaseUrl, useMedulaStore } from "./medulaStore";

/**
 * URL field that commits on blur or Enter. Keyed by the stored value so an outside change resets
 * the draft.
 */
function UrlInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      size="sm"
      className="w-full sm:w-72"
      aria-label="Endereço do painel Medula"
      placeholder={placeholder}
      autoCapitalize="off"
      autoComplete="off"
      spellCheck={false}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => onCommit(draft.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(draft.trim());
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

export function MedulaSettingsSection() {
  const url = useMedulaStore((state) => state.url);
  const setUrl = useMedulaStore((state) => state.setUrl);
  const automaticUrl = resolveMedulaBaseUrl("", window.location);

  return (
    <SettingsSection id="medula" title="Medula">
      <SettingsRow
        id="medula-url"
        title="Endereço do painel"
        description={`O botão Medula no cabeçalho abre este endereço. Vazio usa ${automaticUrl} (o anfitrião desta página).`}
        control={<UrlInput key={url} value={url} placeholder={automaticUrl} onCommit={setUrl} />}
      />
    </SettingsSection>
  );
}
