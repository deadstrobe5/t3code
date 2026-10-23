import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";

import { resolveMedulaBaseUrl } from "./medulaFeed";
import { MEDULA_DEFAULT_TITLE, useMedulaStore } from "./medulaStore";

/**
 * Text field that commits on blur or Enter, so typing a URL does not reconnect per keystroke.
 * Callers key it by the stored value so an outside change resets the draft.
 */
function CommitInput({
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      size="sm"
      className="w-full sm:w-72"
      aria-label={ariaLabel}
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
  const enabled = useMedulaStore((state) => state.enabled);
  const url = useMedulaStore((state) => state.url);
  const title = useMedulaStore((state) => state.title);
  const update = useMedulaStore((state) => state.update);
  const automaticUrl = resolveMedulaBaseUrl("", window.location);

  return (
    <SettingsSection id="medula" title="Medula">
      <SettingsRow
        id="medula-enabled"
        title="Painel Medula"
        description="Botão no cabeçalho da conversa e separador no painel da direita."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label="Mostrar o painel Medula"
          />
        }
      />
      <SettingsRow
        id="medula-url"
        title="Endereço do painel"
        description={`Vazio usa ${automaticUrl} (o anfitrião desta página). Feed em /api/eventos, ideias em /api/ideia.`}
        control={
          <CommitInput
            key={url}
            value={url}
            placeholder={automaticUrl}
            ariaLabel="Endereço do painel Medula"
            onCommit={(next) => update({ url: next })}
          />
        }
      />
      <SettingsRow
        id="medula-title"
        title="Título"
        description="Nome do botão e do separador."
        control={
          <CommitInput
            key={title}
            value={title}
            placeholder={MEDULA_DEFAULT_TITLE}
            ariaLabel="Título do painel Medula"
            onCommit={(next) => update({ title: next || MEDULA_DEFAULT_TITLE })}
          />
        }
      />
    </SettingsSection>
  );
}
