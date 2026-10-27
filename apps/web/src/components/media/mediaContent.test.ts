import { afterEach, expect, it, vi } from "vite-plus/test";

import { readMediaPng } from "./mediaContent";

afterEach(() => vi.unstubAllGlobals());

it("falls back to the next source when a fetch gets no response", async () => {
  const png = new Blob(["png"], { type: "image/png" });
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(new Response(png));
  vi.stubGlobal("fetch", fetch);

  const blob = await readMediaPng(["http://unreachable.test/a.png", "http://shown.test/a.png"]);

  expect(blob.type).toBe("image/png");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "http://unreachable.test/a.png",
    "http://shown.test/a.png",
  ]);
});

it("does not retry past an HTTP error", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("gone", { status: 404 }));
  vi.stubGlobal("fetch", fetch);

  await expect(readMediaPng(["http://a.test/x.png", "http://b.test/x.png"])).rejects.toThrow(
    "HTTP 404",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reports the network failure when no source answers", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

  await expect(readMediaPng(["http://a.test/x.png", "http://a.test/x.png"])).rejects.toThrow(
    "could not be fetched",
  );
});
