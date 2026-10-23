import { describe, expect, it } from "vite-plus/test";

import { resolveMedulaBaseUrl } from "./medulaStore";

describe("resolveMedulaBaseUrl", () => {
  it("defaults to the page's host on the painel port so remote browsers reach the server", () => {
    expect(resolveMedulaBaseUrl("", { protocol: "http:", hostname: "192.0.2.10" })).toBe(
      "http://192.0.2.10:8801/",
    );
    expect(resolveMedulaBaseUrl("  ", { protocol: "http:", hostname: "127.0.0.1" })).toBe(
      "http://127.0.0.1:8801/",
    );
  });

  it("falls back to loopback outside a web page", () => {
    expect(resolveMedulaBaseUrl("", { protocol: "t3:", hostname: "" })).toBe(
      "http://127.0.0.1:8801/",
    );
    expect(resolveMedulaBaseUrl("", null)).toBe("http://127.0.0.1:8801/");
  });

  it("keeps an explicit URL and adds the trailing slash relative paths need", () => {
    expect(resolveMedulaBaseUrl("http://painel.local:9000/painel", null)).toBe(
      "http://painel.local:9000/painel/",
    );
  });
});
