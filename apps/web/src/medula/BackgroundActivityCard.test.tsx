import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BackgroundActivityList, BackgroundActivityRow } from "./BackgroundActivityCard";
import type { BackgroundActivityItem } from "./backgroundActivity";

const NOW = Date.parse("2026-10-26T21:30:00.000Z");

const item = (overrides: Partial<BackgroundActivityItem>): BackgroundActivityItem => ({
  id: "subagent:a",
  kind: "subagent",
  label: "Explora o servidor",
  model: "claude-sonnet-5",
  startedAt: NOW - 125_000,
  finishedAt: null,
  state: "running",
  lastStep: "Running rg -n task_notification",
  events: [
    { at: NOW - 10_000, text: "Running rg -n task_notification" },
    { at: NOW - 60_000, text: "Read ThreadDetailsPanel.tsx" },
  ],
  childThreadId: null,
  ...overrides,
});

describe("BackgroundActivityList", () => {
  it("renders nothing without background work", () => {
    expect(renderToStaticMarkup(<BackgroundActivityList items={[]} now={NOW} />)).toBe("");
  });

  it("counts live work in the heading and shows each row", () => {
    const html = renderToStaticMarkup(
      <BackgroundActivityList
        now={NOW}
        items={[
          item({}),
          item({ id: "task:b1", kind: "command", label: "pnpm install", model: null }),
          item({ id: "task:b2", kind: "monitor", label: "Vigia", state: "done", finishedAt: NOW }),
        ]}
      />,
    );
    expect(html).toContain("Em fundo (2)");
    expect(html).toContain("Explora o servidor");
    expect(html).toContain("sonnet-5");
    expect(html).toContain("2m");
    expect(html).toContain("Running rg -n task_notification");
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-kind="monitor"');
    expect(html).toContain("bg-emerald-500");
  });
});

describe("BackgroundActivityRow", () => {
  it("is collapsed by default and shows the last events when expanded", () => {
    const collapsed = renderToStaticMarkup(
      <ul>
        <BackgroundActivityRow item={item({})} now={NOW} />
      </ul>,
    );
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain("data-background-activity-events");

    const expanded = renderToStaticMarkup(
      <ul>
        <BackgroundActivityRow item={item({})} now={NOW} defaultExpanded />
      </ul>,
    );
    expect(expanded).toContain("data-background-activity-events");
    expect(expanded).toContain("Read ThreadDetailsPanel.tsx");
    expect(expanded).toContain("1m");
  });

  it("colours a failed task red", () => {
    const html = renderToStaticMarkup(
      <ul>
        <BackgroundActivityRow item={item({ state: "failed" })} now={NOW} />
      </ul>,
    );
    expect(html).toContain("bg-red-500");
    expect(html).toContain("falhou");
  });
});
