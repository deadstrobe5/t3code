// @effect-diagnostics nodeBuiltinImport:off - fire-and-forget push from the SDK permission callback.
/**
 * Medula: Claude prompts that win over bypass mode (settings `ask` rules, `rm -rf`) are declined after
 * `T3CODE_MEDULA_APROVACAO_TETO_S` seconds (default 180, `0` = off) so an unwatched turn cannot hang;
 * the operator is pushed through `T3CODE_MEDULA_APROVACAO_AVISO` (default `~/.local/bin/ws-push`).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const MEDULA_APPROVAL_TIMEOUT_ENV = "T3CODE_MEDULA_APROVACAO_TETO_S";
export const MEDULA_APPROVAL_NOTIFY_ENV = "T3CODE_MEDULA_APROVACAO_AVISO";
export const DEFAULT_APPROVAL_TIMEOUT_MS = 3 * 60_000;

/** Milliseconds before an unanswered approval is declined; `null` = no ceiling. */
export function readApprovalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[MEDULA_APPROVAL_TIMEOUT_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_APPROVAL_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  return seconds === 0 ? null : Math.round(seconds * 1000);
}

function formatMinutes(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

export function approvalExpiredMessage(timeoutMs: number): string {
  return (
    `aprovação expirou sem resposta ao fim de ${formatMinutes(timeoutMs)} min: ` +
    "reescreve o comando sem o padrão que pede aprovação " +
    "(ex.: git -C, git restore --staged, caminhos absolutos)"
  );
}

/** One line naming what was waiting: the Bash command, a path, or the prompt. */
export function describeApprovalRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
  prompt: string | undefined,
): string {
  const field = ["command", "file_path", "path", "url", "pattern"]
    .map((key) => toolInput[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  const text = field ?? prompt ?? "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > 300 ? `${oneLine.slice(0, 299)}…` : oneLine;
  return clipped === "" ? toolName : `${toolName}: ${clipped}`;
}

export function resolveApprovalNotifier(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[MEDULA_APPROVAL_NOTIFY_ENV]?.trim();
  if (configured === "") return null;
  const path = configured ?? NodePath.join(NodeOS.homedir(), ".local", "bin", "ws-push");
  return NodeFS.existsSync(path) ? path : null;
}

/** Fire-and-forget push; never throws and never blocks the turn. */
export function notifyApprovalExpired(
  input: { readonly thread: string; readonly request: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const notifier = resolveApprovalNotifier(env);
  if (notifier === null) return;
  try {
    const child = NodeChildProcess.spawn(
      notifier,
      ["T3: aprovação expirou", `${input.thread} ${input.request}`],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The push is a courtesy; the decline already freed the agent.
  }
}
