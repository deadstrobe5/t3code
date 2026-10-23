import { describe, expect, it } from "vite-plus/test";

import {
  formatMedulaElapsed,
  medulaWorkerElapsedMs,
  medulaWorkerTone,
  type MedulaWorker,
} from "./medulaWorkers";

const worker = (overrides: Partial<MedulaWorker>): MedulaWorker => ({
  id: "O-1",
  title: "t",
  model: "opus",
  state: "a-correr",
  idea: null,
  startedAt: "2026-10-23T03:00:00+01:00",
  endedAt: null,
  summary: null,
  ...overrides,
});

describe("medula workers", () => {
  it("maps states to tones", () => {
    expect(medulaWorkerTone("a-correr")).toBe("running");
    expect(medulaWorkerTone("acabou")).toBe("done");
    expect(medulaWorkerTone("falhou")).toBe("failed");
    expect(medulaWorkerTone("rejeitado")).toBe("rejected");
    expect(medulaWorkerTone("outra")).toBe("unknown");
  });

  it("formats elapsed time", () => {
    expect(formatMedulaElapsed(4_200)).toBe("4 s");
    expect(formatMedulaElapsed(12 * 60_000)).toBe("12 min");
    expect(formatMedulaElapsed(65 * 60_000)).toBe("1 h 05 min");
    expect(formatMedulaElapsed(-5)).toBe("0 s");
  });

  it("measures up to now while running and up to the end once finished", () => {
    const start = Date.parse("2026-10-23T03:00:00+01:00");
    expect(medulaWorkerElapsedMs(worker({}), start + 90_000)).toBe(90_000);
    expect(
      medulaWorkerElapsedMs(worker({ endedAt: "2026-10-23T03:10:00+01:00" }), start + 999_999),
    ).toBe(600_000);
    expect(medulaWorkerElapsedMs(worker({ startedAt: null }), start)).toBeNull();
  });
});
