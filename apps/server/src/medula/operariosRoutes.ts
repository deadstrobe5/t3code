/**
 * HTTP routes for medula operários (see operarios.ts). Each one runs the
 * orchestrator's own delegate_task / task_status / t3_thread_send /
 * task_cancel code acting as the parent thread, so an operário is a delegated
 * task in every way the app knows: agent panel, completion wake, mid-run
 * messages, restart recovery.
 */
import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpThreadSendInput,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Operarios from "./operarios.ts";

const noStore = { "cache-control": "no-store" };

const jsonResponse = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });

const errorResponse = (code: string, message: string, status?: number) =>
  jsonResponse({ error: { code, message } }, status ?? Operarios.statusForFailureCode(code));

class OperariosRequestError extends Data.TaggedError("OperariosRequestError")<{
  readonly code: string;
  readonly message: string;
  readonly status: number;
}> {}

const requestError = (code: string, message: string, status?: number) =>
  new OperariosRequestError({
    code,
    message,
    status: status ?? Operarios.statusForFailureCode(code),
  });

let tokenPromise: Promise<string> | null = null;
const serverToken = (stateDir: string) => (tokenPromise ??= Operarios.ensureTokenFile(stateDir));

/** Loopback plus the token file: the authority of a process of this user. */
const authorize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!Operarios.isLoopbackAddress(Operarios.remoteAddressOf(request.source))) {
    return yield* requestError("forbidden", "Loopback only.", 403);
  }
  const config = yield* ServerConfig.ServerConfig;
  const token = yield* Effect.promise(() => serverToken(config.stateDir));
  if (!Operarios.tokensMatch(token, Operarios.bearerToken(request.headers.authorization))) {
    return yield* requestError("unauthorized", "Missing or wrong token.", 401);
  }
});

const readBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(
    Effect.mapError(() => requestError("invalid_request", "Expected a JSON body.", 400)),
  );
});

const queryParam = Effect.fn("medula.operarios.queryParam")(function* (name: string) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const value = Option.isSome(url) ? url.value.searchParams.get(name)?.trim() : undefined;
  if (!value) return yield* requestError("invalid_request", `Pass ${name}.`, 400);
  return value;
});

const threadIdForSession = Effect.fn("medula.operarios.threadIdForSession")(function* (
  sessionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_provider_threads
    WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${sessionId}
    ORDER BY updated_at DESC
    LIMIT 1
  `.pipe(Effect.mapError(() => requestError("orchestration_error", "Session lookup failed.")));
  const threadId = rows[0]?.thread_id;
  if (threadId === undefined) {
    return yield* requestError("thread_not_found", `No T3 thread runs session ${sessionId}.`);
  }
  return ThreadId.make(threadId);
});

/** The parent thread's caller scope, as its own MCP credential would carry. */
const parentScope = Effect.fn("medula.operarios.parentScope")(function* (rawThreadId: string) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const threadId = ThreadId.make(rawThreadId);
  const shell = yield* threads
    .getThreadShell(threadId)
    .pipe(Effect.mapError(() => requestError("orchestration_error", "Thread lookup failed.")));
  if (shell === null || shell.deletedAt !== null) {
    return yield* requestError("parent_not_found", `Thread ${rawThreadId} was not found.`);
  }
  const namespace = `${Operarios.MEDULA_OPERARIOS_NAMESPACE}:${threadId}`;
  return {
    environmentId: yield* environment.getEnvironmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: yield* Clock.currentTimeMillis,
    requestNamespace: namespace,
    thread: {
      threadId,
      providerSessionId: namespace,
      providerInstanceId: shell.providerInstanceId,
    },
    client: undefined,
  } satisfies McpThreadInvocationScope;
});

/** For messages when the parent has no live run: a full-access local client. */
const clientScope = (scope: McpThreadInvocationScope): McpInvocationScope => ({
  ...scope,
  thread: undefined,
  client: { sessionId: scope.requestNamespace, label: "medula-operario", access: "full-access" },
});

const invalidInput = (error: unknown) => requestError("invalid_request", String(error), 400);
const decodeDelegate = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskInput);
const decodeDelegateInput = (input: unknown) =>
  decodeDelegate(input).pipe(Effect.mapError(invalidInput));
const decodeSend = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendInput);
const decodeSendInput = (input: unknown) => decodeSend(input).pipe(Effect.mapError(invalidInput));
const decodeCancel = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelInput);
const decodeCancelInput = (input: unknown) =>
  decodeCancel(input).pipe(Effect.mapError(invalidInput));

const respond = <A, R>(
  effect: Effect.Effect<A, OperariosRequestError | OrchestratorMcpFailure, R>,
) =>
  effect.pipe(
    Effect.map((body) => jsonResponse(body)),
    Effect.catchTags({
      OperariosRequestError: (error) =>
        Effect.succeed(errorResponse(error.code, error.message, error.status)),
      OrchestratorMcpFailure: (error) => Effect.succeed(errorResponse(error.code, error.message)),
    }),
    Effect.catchDefect((defect) =>
      Effect.logWarning("medula.operarios.defect", { defect }).pipe(
        Effect.as(errorResponse("orchestration_error", "Internal error.", 500)),
      ),
    ),
    Effect.withTracerEnabled(false),
  );

const PATH = Operarios.MEDULA_OPERARIOS_PATH;

type Service = OrchestratorMcpService.OrchestratorMcpServiceShape;

const launchRoute = (service: Service) =>
  HttpRouter.add(
    "POST",
    PATH,
    respond(
      Effect.gen(function* () {
        yield* authorize;
        const parsed = Operarios.parseLaunchRequest(yield* readBody);
        if (!parsed.ok) return yield* requestError("invalid_request", parsed.message, 400);
        const launch = parsed.value;
        const parentThreadId =
          launch.parentThreadId ?? (yield* threadIdForSession(launch.parentSessionId!));
        const scope = yield* parentScope(parentThreadId);
        const input = yield* decodeDelegateInput({
          task: launch.task,
          ...(launch.title === null ? {} : { title: launch.title }),
          target: {
            ...(launch.providerInstanceId === null
              ? {}
              : { providerInstanceId: launch.providerInstanceId }),
            ...(launch.model === null ? {} : { model: launch.model }),
            ...(launch.options === null ? {} : { options: launch.options }),
          },
          mode: "async",
          clientRequestId: launch.clientRequestId,
        });
        const result = yield* service.delegateTask(scope, input);
        return { ...result, parentThreadId: scope.thread.threadId };
      }),
    ),
  );

const threadRoute = () =>
  HttpRouter.add(
    "GET",
    `${PATH}/thread`,
    respond(
      Effect.gen(function* () {
        yield* authorize;
        return { threadId: yield* threadIdForSession(yield* queryParam("sessionId")) };
      }),
    ),
  );

const statusRoute = (service: Service) =>
  HttpRouter.add(
    "GET",
    `${PATH}/estado`,
    respond(
      Effect.gen(function* () {
        yield* authorize;
        const scope = yield* parentScope(yield* queryParam("parentThreadId"));
        const taskId = NodeId.make(yield* queryParam("taskId"));
        // Never acknowledges: the parent's completion wake stays the app's job.
        return yield* service.peekTask(scope, taskId);
      }),
    ),
  );

const messageRoute = (service: Service) =>
  HttpRouter.add(
    "POST",
    `${PATH}/diz`,
    respond(
      Effect.gen(function* () {
        yield* authorize;
        const parsed = Operarios.parseMessageRequest(yield* readBody);
        if (!parsed.ok) return yield* requestError("invalid_request", parsed.message, 400);
        const scope = yield* parentScope(parsed.value.parentThreadId);
        const input = yield* decodeSendInput({
          threadId: parsed.value.childThreadId,
          message: parsed.value.text,
          mode: parsed.value.mode,
        });
        // From the parent while it runs; otherwise from a local client, since
        // a message to another thread needs a live caller run.
        return yield* service.sendToThread(scope, input).pipe(
          Effect.catchIf(
            (error) => error.code === "parent_not_active",
            () => service.sendToThread(clientScope(scope), input),
          ),
        );
      }),
    ),
  );

const cancelRoute = (service: Service) =>
  HttpRouter.add(
    "POST",
    `${PATH}/cancela`,
    respond(
      Effect.gen(function* () {
        yield* authorize;
        const parsed = Operarios.parseCancelRequest(yield* readBody);
        if (!parsed.ok) return yield* requestError("invalid_request", parsed.message, 400);
        const scope = yield* parentScope(parsed.value.parentThreadId);
        const input = yield* decodeCancelInput({
          taskId: parsed.value.taskId,
          ...(parsed.value.reason === null ? {} : { reason: parsed.value.reason }),
        });
        return yield* service.cancelTask(scope, input);
      }),
    ),
  );

/** Writes the token file at startup, so the CLI can tell the routes exist. */
const tokenAtStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.promise(() => serverToken(config.stateDir)).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("medula.operarios.token-failed", { defect }),
      ),
    );
  }),
);

// The orchestrator service is built once here, as the MCP toolkit builds it,
// rather than asked of every request.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return Layer.mergeAll(
      launchRoute(service),
      threadRoute(),
      statusRoute(service),
      messageRoute(service),
      cancelRoute(service),
      tokenAtStartup,
    );
  }),
).pipe(Layer.provide(OrchestratorMcpService.layer));
