// @effect-diagnostics nodeBuiltinImport:off
/**
 * Medula operários as T3 delegated tasks: the `medula-operario` CLI asks the
 * server, over loopback HTTP with a token file, to delegate a task on behalf
 * of the thread that launched it. The child then shows in that thread's agent
 * panel, wakes it on completion and takes messages mid-run, exactly like a
 * `delegate_task` call.
 *
 * Plain Node helpers here; the routes live in operariosRoutes.ts.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const MEDULA_OPERARIOS_PATH = "/api/medula/operarios";
export const MEDULA_OPERARIOS_TOKEN_FILE = "medula-operarios.token";
/** Prefix of the idempotency namespace for every command these routes dispatch. */
export const MEDULA_OPERARIOS_NAMESPACE = "medula-operarios";

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/** `opus|sonnet|haiku` become the current catalog ids; anything else passes through. */
export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model.trim();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function isLoopbackAddress(address: string | null | undefined): boolean {
  return typeof address === "string" && LOOPBACK.has(address.trim().toLowerCase());
}

/** The socket address of a Node request, when the server runs on Node. */
export function remoteAddressOf(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const candidate = source as {
    readonly socket?: { readonly remoteAddress?: string | null };
    readonly remoteAddress?: string | null;
  };
  return candidate.socket?.remoteAddress ?? candidate.remoteAddress ?? null;
}

export function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

export function tokensMatch(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}

/**
 * Reads the token file, creating it (mode 0600) on first use. Only the
 * server's own user can read it, which is the whole authority of the routes.
 */
export async function ensureTokenFile(stateDir: string): Promise<string> {
  const file = NodePath.join(stateDir, MEDULA_OPERARIOS_TOKEN_FILE);
  try {
    const existing = (await NodeFSP.readFile(file, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // created below
  }
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  await NodeFSP.mkdir(stateDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await NodeFSP.rename(temporary, file);
  return token;
}

/** HTTP status for an orchestrator failure code. */
export function statusForFailureCode(code: string): number {
  switch (code) {
    case "thread_not_found":
    case "task_not_found":
    case "parent_not_found":
      return 404;
    case "parent_not_active":
      return 409;
    case "capability_denied":
    case "runtime_mode_escalation_denied":
    case "interaction_mode_escalation_denied":
      return 403;
    case "invalid_request":
    case "target_required":
    case "thread_credential_required":
      return 400;
    default:
      return 500;
  }
}

export interface LaunchRequest {
  readonly parentThreadId: string | null;
  readonly parentSessionId: string | null;
  readonly title: string | null;
  readonly task: string;
  readonly model: string | null;
  readonly providerInstanceId: string | null;
  readonly options: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | null;
  readonly clientRequestId: string;
}

export interface MessageRequest {
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly text: string;
  readonly mode: "auto" | "steer" | "queue";
}

export interface CancelRequest {
  readonly parentThreadId: string;
  readonly taskId: string;
  readonly reason: string | null;
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const record = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;

export function parseLaunchRequest(raw: unknown): Parsed<LaunchRequest> {
  const body = record(raw);
  if (body === null) return { ok: false, message: "Expected a JSON object." };
  const parentThreadId = text(body.parentThreadId);
  const parentSessionId = text(body.parentSessionId);
  if (parentThreadId === null && parentSessionId === null) {
    return { ok: false, message: "Pass parentThreadId or parentSessionId." };
  }
  const task = text(body.task);
  if (task === null) return { ok: false, message: "Pass task." };
  if (task.length > 120_000)
    return { ok: false, message: "task is longer than 120000 characters." };
  const clientRequestId = text(body.clientRequestId);
  if (clientRequestId === null || clientRequestId.length > 200) {
    return { ok: false, message: "Pass clientRequestId (at most 200 characters)." };
  }
  let options: LaunchRequest["options"] = null;
  if (body.options !== undefined && body.options !== null) {
    if (!Array.isArray(body.options)) return { ok: false, message: "options must be a list." };
    const parsed: Array<{ id: string; value: string | boolean }> = [];
    for (const entry of body.options) {
      const option = record(entry);
      const id = text(option?.id);
      const value = option?.value;
      if (id === null || (typeof value !== "string" && typeof value !== "boolean")) {
        return { ok: false, message: "Each option is {id, value}." };
      }
      parsed.push({ id, value });
    }
    options = parsed;
  }
  const title = text(body.title);
  const model = text(body.model);
  return {
    ok: true,
    value: {
      parentThreadId,
      parentSessionId,
      title: title === null ? null : title.slice(0, 200),
      task,
      model: model === null ? null : resolveModelAlias(model),
      providerInstanceId: text(body.providerInstanceId),
      options,
      clientRequestId,
    },
  };
}

export function parseMessageRequest(raw: unknown): Parsed<MessageRequest> {
  const body = record(raw);
  const parentThreadId = text(body?.parentThreadId);
  const childThreadId = text(body?.childThreadId);
  const message = text(body?.text);
  if (parentThreadId === null || childThreadId === null || message === null) {
    return { ok: false, message: "Pass parentThreadId, childThreadId and text." };
  }
  const mode = body?.mode ?? "auto";
  if (mode !== "auto" && mode !== "steer" && mode !== "queue") {
    return { ok: false, message: "mode is auto, steer or queue." };
  }
  return { ok: true, value: { parentThreadId, childThreadId, text: message, mode } };
}

export function parseCancelRequest(raw: unknown): Parsed<CancelRequest> {
  const body = record(raw);
  const parentThreadId = text(body?.parentThreadId);
  const taskId = text(body?.taskId);
  if (parentThreadId === null || taskId === null) {
    return { ok: false, message: "Pass parentThreadId and taskId." };
  }
  return { ok: true, value: { parentThreadId, taskId, reason: text(body?.reason) } };
}
