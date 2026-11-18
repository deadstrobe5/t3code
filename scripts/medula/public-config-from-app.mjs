#!/usr/bin/env node
// Print the public T3 Connect build config (Clerk publishable key, JWT
// template, CLI OAuth client id, relay URL) baked into an installed official
// desktop app, as KEY=VALUE lines for scripts/medula/build-desktop-mac.sh.
// These values ship in every official client bundle; release CI takes them
// from repository variables that a fork does not have. Relay tracing is left
// out on purpose.
//
//   node scripts/medula/public-config-from-app.mjs "/Applications/T3 Code (Beta).app" > env
import { createRequire } from "node:module";
import * as path from "node:path";

const appPath = process.argv[2];
if (!appPath) {
  console.error("usage: public-config-from-app.mjs <path to T3 Code .app>");
  process.exit(2);
}
// @electron/asar comes in through electron-builder -> app-builder-lib.
const requireFrom = (from, id) => createRequire(from).resolve(id);
const desktopManifest = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../../apps/desktop/package.json",
);
const builderManifest = requireFrom(desktopManifest, "electron-builder/package.json");
const libManifest = requireFrom(builderManifest, "app-builder-lib/package.json");
const asar = createRequire(libManifest)("@electron/asar");
const archive = path.join(appPath, "Contents/Resources/app.asar");
const files = asar.listPackage(archive, { isPack: false }).map((f) => f.replace(/^[/\\]/, ""));
const read = (f) => asar.extractFile(archive, f).toString("utf8");

const found = {};
const pick = (key, text, pattern) => {
  if (found[key]) return;
  const match = pattern.exec(text);
  if (match && match[1].trim()) found[key] = match[1].trim();
};
for (const f of files.filter((f) => /^apps\/server\/dist\/[^/]+\.mjs$/.test(f))) {
  const text = read(f);
  pick("T3CODE_RELAY_URL", text, /buildTimeRelayUrl = \w+\("([^"]*)"\)/);
  pick("T3CODE_CLERK_PUBLISHABLE_KEY", text, /buildTimeClerkPublishableKey = \w+\("([^"]*)"\)/);
  pick(
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    text,
    /buildTimeClerkCliOAuthClientId = \w+\("([^"]*)"\)/,
  );
}
for (const f of files.filter((f) => /^apps\/server\/dist\/client\/assets\/[^/]+\.js$/.test(f))) {
  pick("T3CODE_CLERK_JWT_TEMPLATE", read(f), /clerkJwtTemplate:[\w$]+\(`([^`]*)`\)/);
}
const keys = [
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_URL",
];
const missing = keys.filter((k) => !found[k]);
if (missing.length > 0) {
  console.error(`not found in ${archive}: ${missing.join(", ")}`);
  process.exit(1);
}
for (const k of keys) process.stdout.write(`${k}=${found[k]}\n`);
