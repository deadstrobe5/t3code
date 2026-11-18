import { msg } from "gt-react";

import { m } from "~/i18n/messages";

/** Resolves web references without inheriting the desktop renderer's custom app scheme. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

// Data URL escapes are raw bytes, not UTF-8, so `%89` must stay one byte.
function decodePercentBytes(payload: string) {
  const encoder = new TextEncoder();
  return Uint8Array.from(
    payload
      .split(/(%[0-9a-f]{2})/i)
      .flatMap((part) =>
        /^%[0-9a-f]{2}$/i.test(part)
          ? [Number.parseInt(part.slice(1), 16)]
          : [...encoder.encode(part)],
      ),
  );
}

/** Decodes inline media locally; desktop connect-src omits `data:`, so fetch() cannot read it. */
function readDataUrlBlob(src: string): Blob {
  // A fragment is never part of the payload; a literal `#` in data must be escaped as `%23`.
  const url = src.split("#", 1)[0] ?? src;
  const comma = url.indexOf(",");
  const [mimeType = "", ...parameters] = url.slice("data:".length, comma).split(";");
  const payload = url.slice(comma + 1);
  try {
    if (comma < 0) throw new Error(m(msg("Missing data URL payload.")));
    const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === "base64");
    // Base64 text is ASCII, so any escape that is not valid UTF-8 is malformed anyway.
    const bytes = isBase64
      ? Uint8Array.from(atob(decodeURIComponent(payload)), (char) => char.charCodeAt(0))
      : decodePercentBytes(payload);
    return new Blob([bytes], { type: mimeType || "text/plain" });
  } catch (cause) {
    throw new Error(m(msg("This inline media could not be decoded.")), { cause });
  }
}

/**
 * Tries each source in order. Only a fetch that never got a response moves on: a freshly minted
 * asset URL can point at a route the browser cannot reach while the URL already on screen still
 * loads.
 */
async function fetchMediaBlob(sources: ReadonlyArray<string>): Promise<Blob> {
  let response: Response | null = null;
  for (const src of sources) {
    response = await fetch(src).catch(() => null);
    if (response) break;
  }
  if (response?.ok) return response.blob();
  // An <img> can show media that fetch() may not read (CORS, CSP, cookies); desktop reads it natively.
  const desktop = typeof window === "undefined" ? undefined : window.desktopBridge;
  let native: Awaited<ReturnType<NonNullable<typeof desktop>["readMedia"]>> | null = null;
  if (desktop) {
    for (const src of sources) {
      if (!/^https?:/i.test(src)) continue;
      native = await desktop.readMedia(src).catch(() => null);
      if (native) break;
    }
  }
  if (native && native.status >= 200 && native.status < 300) {
    return new Blob([new Uint8Array(native.data)], { type: native.mimeType });
  }
  const status = native?.status ?? response?.status;
  if (status !== undefined)
    throw new Error(m(msg("The file could not be fetched (HTTP {status}).", { status })));
  throw new Error(
    desktop
      ? m(msg("The file could not be fetched. Check the connection and try again."))
      : m(
          msg(
            "The file could not be fetched. The host may block browser access (CORS), or the connection may be unavailable.",
          ),
        ),
  );
}

/** Accepts one URL or several to try in order (the fresh asset URL, then the one on screen). */
type MediaSources = string | ReadonlyArray<string>;

async function readMediaBlob(input: MediaSources): Promise<Blob> {
  const sources = [...new Set(typeof input === "string" ? [input] : input)];
  // Inline media decodes locally and never needs the network.
  const inline = sources.find((src) => /^data:/i.test(src));
  if (inline) return readDataUrlBlob(inline);
  const blob = await fetchMediaBlob(sources);
  if (blob.type.split(";", 1)[0] === "text/html") {
    throw new Error(
      m(msg("This link returned a web page instead of media. Open the original URL.")),
    );
  }
  return blob;
}

export async function downloadMedia(sources: MediaSources, name: string): Promise<void> {
  const url = URL.createObjectURL(await readMediaBlob(sources));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function readMediaPng(sources: MediaSources): Promise<Blob> {
  const blob = await readMediaBlob(sources);
  if (blob.type.split(";", 1)[0] === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    try {
      await image.decode();
    } catch (cause) {
      throw new Error(
        m(msg("The browser could not decode this image for copying. Try saving it instead.")),
        {
          cause,
        },
      );
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width <= 0 || height <= 0 || width * height > 64_000_000) {
      throw new Error(
        m(msg("This image is too large or has no usable dimensions. Try saving it instead.")),
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(m(msg("Image copying is unavailable in this browser.")));
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png
            ? resolve(png)
            : reject(new Error(m(msg("The image could not be converted to PNG.")))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
