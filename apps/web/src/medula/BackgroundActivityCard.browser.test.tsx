import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { BackgroundActivityList } from "./BackgroundActivityCard";
import type { BackgroundActivityItem } from "./backgroundActivity";

const NOW = Date.parse("2026-10-26T21:30:00.000Z");
const min = (m: number) => NOW - m * 60_000;

const ITEMS: ReadonlyArray<BackgroundActivityItem> = [
  {
    id: "subagent:a9b5",
    kind: "subagent",
    label: "T3: cartão «Em fundo» no painel lateral",
    model: "claude-opus-5-5",
    startedAt: min(12.5),
    finishedAt: null,
    state: "running",
    lastStep: "Running npx vp test run --project unit src/medula/",
    events: [
      { at: min(0.2), text: "Running npx vp test run --project unit src/medula/" },
      { at: min(1), text: "$ npx vp lint apps/web/src/medula/BackgroundActivityCard.tsx" },
      { at: min(2), text: "Edit BackgroundActivityCard.tsx" },
      { at: min(4), text: "Write backgroundActivity.test.ts" },
      { at: min(6), text: "$ sqlite3 -readonly statev2.sqlite …" },
    ],
    childThreadId: null,
  },
  {
    id: "subagent:a7d6",
    kind: "subagent",
    label: "Cartão Velocidade: carga da fila em tempo real",
    model: "claude-sonnet-5",
    startedAt: min(11),
    finishedAt: null,
    state: "running",
    lastStep: "Running cd /data/code/fabrica; F=problemas/nist-assembly/…",
    events: [],
    childThreadId: null,
  },
  {
    id: "task:b0682tzqk",
    kind: "monitor",
    label: "Vast utilisation watcher: low-utilisation or failure events",
    model: null,
    startedAt: min(20),
    finishedAt: null,
    state: "waiting",
    lastStep: "Começou (Monitor)",
    events: [{ at: min(20), text: "Começou (Monitor)" }],
    childThreadId: null,
  },
  {
    id: "task:b33wj2sgb",
    kind: "command",
    label: "timeout 3000 bin/fab-candidata --recompoe > recompoe-2115.log",
    model: null,
    startedAt: min(15),
    finishedAt: null,
    state: "running",
    lastStep: "Começou (Bash)",
    events: [{ at: min(15), text: "Começou (Bash)" }],
    childThreadId: null,
  },
  {
    id: "subagent:aefd",
    kind: "subagent",
    label: "NIST: juntar as peças pequenas na candidata",
    model: "claude-opus-5-5",
    startedAt: min(13),
    finishedAt: min(11.5),
    state: "stopped",
    lastStep: "Parado pelo líder",
    events: [],
    childThreadId: null,
  },
  {
    id: "task:bfail",
    kind: "command",
    label: "make test",
    model: null,
    startedAt: min(9),
    finishedAt: min(3),
    state: "failed",
    lastStep: 'Background command "make test" failed (exit code 2)',
    events: [],
    childThreadId: null,
  },
];

describe("BackgroundActivityList (visual)", () => {
  it("renders the card and expands a row", async () => {
    await page.viewport(380, 720);
    document.documentElement.classList.add("dark");
    await using screen = await render(
      <div className="w-[340px] bg-background p-2 text-foreground">
        <BackgroundActivityList items={ITEMS} now={NOW} />
      </div>,
    );
    await userEvent.click(page.getByText("T3: cartão «Em fundo» no painel lateral"));
    await expect.element(page.getByText("Edit BackgroundActivityCard.tsx")).toBeVisible();
    expect(screen.container.textContent).toContain("Em fundo (4)");
    const path = import.meta.env.VITE_EM_FUNDO_SHOT;
    if (typeof path === "string" && path.length > 0) {
      await page.screenshot({ path, element: screen.container.firstElementChild as HTMLElement });
    }
  });
});
