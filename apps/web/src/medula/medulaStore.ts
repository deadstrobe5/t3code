/**
 * Where the Medula painel lives. The painel is an external dashboard; T3 only keeps its address
 * (client-local) and a header button that opens it.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

export const MEDULA_DEFAULT_PORT = 8801;

/**
 * Painel address baked in at build time (T3CODE_MEDULA_DEFAULT_URL), for clients such as the
 * desktop app whose page host is not the machine running the painel. Empty in ordinary builds.
 */
const MEDULA_BUILD_DEFAULT_URL: string =
  (import.meta.env.VITE_MEDULA_DEFAULT_URL as string | undefined)?.trim() ?? "";

/**
 * The painel URL with a trailing slash. An empty setting means the build's default, or else
 * "this page's host on the default port", so a browser on another machine reaches the painel on
 * the server, not on itself.
 */
export function resolveMedulaBaseUrl(
  setting: string,
  location: Pick<Location, "protocol" | "hostname"> | null,
): string {
  const trimmed = setting.trim() || MEDULA_BUILD_DEFAULT_URL;
  if (trimmed.length > 0) {
    try {
      const url = new URL(trimmed);
      if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
      return url.toString();
    } catch {
      return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    }
  }
  const webPage =
    location !== null &&
    (location.protocol === "http:" || location.protocol === "https:") &&
    location.hostname.length > 0;
  const host = webPage ? location.hostname : "127.0.0.1";
  const protocol = webPage ? location.protocol : "http:";
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}//${hostPart}:${MEDULA_DEFAULT_PORT}/`;
}

interface MedulaState {
  /** Empty means this page's host on the default painel port. */
  url: string;
  setUrl: (url: string) => void;
}

export const useMedulaStore = create<MedulaState>()(
  persist(
    (set) => ({
      url: "",
      setUrl: (url) => set({ url }),
    }),
    {
      name: "t3code:medula:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ url: state.url }),
      // Older versions also kept panel and feed settings; only the address survives.
      migrate: (persisted) => ({
        url:
          persisted !== null &&
          typeof persisted === "object" &&
          "url" in persisted &&
          typeof persisted.url === "string"
            ? persisted.url
            : "",
      }),
    },
  ),
);

export function readMedulaBaseUrl(): string {
  return resolveMedulaBaseUrl(
    useMedulaStore.getState().url,
    typeof window !== "undefined" ? window.location : null,
  );
}
