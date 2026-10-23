// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- the fake CLI, its FIFO and its process are real.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import {
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  ADOPTION_PROMPT,
  AdoptableSessions,
  adoptionPrompt,
  cliStatus,
  INPUT_STALLED_MESSAGE,
  inputStalledMessage,
  processAlive,
  releaseAll,
  resetReleaseForTests,
  setDeliveryStallForTests,
  UNADOPTED_IDLE_LIMIT_MS,
} from "./adoptableSessions.ts";

const SESSION_ID = "native-session-adopt";

/**
 * A stand-in for the Claude CLI's stream-json mode. It answers `initialize`,
 * and for each user message writes "step 1..3" and a result. It waits for the
 * files `go1` and `go2` before steps 2 and 3, so the test decides when the
 * server restarts. Other control requests get an empty success. Every launch
 * appends its pid to `launches`.
 */
function fakeClaudeCli(dir: string): string {
  const cli = NodePath.join(dir, "claude");
  const script = [
    "#!/bin/sh",
    'dir=$(dirname "$0")',
    'echo $$ >> "$dir/launches"',
    `sid=${SESSION_ID}`,
    "while IFS= read -r line; do",
    '  case "$line" in',
    `    *'"initialize"'*)`,
    `      id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')`,
    `      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"models":[]}}}\\n' "$id";;`,
    `    *'"control_request"'*)`,
    `      id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')`,
    `      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"added":[],"removed":[],"errors":{}}}}\\n' "$id";;`,
    `    *'"type":"user"'*)`,
    // The turn runs beside the input loop, so control requests are answered
    // mid-turn as the real CLI does.
    "      (",
    `      printf '{"type":"system","subtype":"init","session_id":"%s"}\\n' "$sid"`,
    "      for i in 1 2 3; do",
    `        printf '{"type":"stream_event","session_id":"%s","event":{"type":"content_block_delta"}}\\n' "$sid"`,
    `        printf '{"type":"assistant","session_id":"%s","message":{"role":"assistant","content":[{"type":"text","text":"step %s"}]}}\\n' "$sid" "$i"`,
    '        [ "$i" = 3 ] || while [ ! -e "$dir/go$i" ]; do sleep 0.05; done',
    "      done",
    `      printf '{"type":"result","subtype":"success","session_id":"%s","result":"done","is_error":false}\\n' "$sid"`,
    "      ) & ;;",
    "  esac",
    "done",
  ].join("\n");
  NodeFS.writeFileSync(cli, `${script}\n`, { mode: 0o755 });
  return cli;
}

/** A CLI that answers `initialize` and then never reads its input again. */
function deafClaudeCli(dir: string): string {
  const cli = NodePath.join(dir, "claude-deaf");
  const script = [
    "#!/bin/sh",
    'dir=$(dirname "$0")',
    'echo $$ >> "$dir/launches"',
    "IFS= read -r line",
    `id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')`,
    `printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"models":[]}}}\\n' "$id"`,
    "exec sleep 600",
  ].join("\n");
  NodeFS.writeFileSync(cli, `${script}\n`, { mode: 0o755 });
  return cli;
}

/** A user message with a pasted image of `bytes` bytes (300 kB: a screenshot, more than a FIFO holds). */
const imageMessage = (bytes = 300_000) =>
  ({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "what do I answer?" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "A".repeat(bytes) },
        },
      ],
    },
    parent_tool_use_id: null,
  }) as never;

const runnerLayer = (baseDir: string) =>
  layerQueryRunner.pipe(
    Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
    Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provide(NodeServices.layer),
  );

const threadId = ThreadId.make("thread-adopt");

const openSession = (
  cli: string,
  identity: { sessionId: string } | { resume: string },
  extra: { mcpServers?: Record<string, { type: "http"; url: string }> } = {},
) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-adopt"),
      options: {
        ...identity,
        ...extra,
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

function texts(messages: ReadonlyArray<SDKMessage>): string[] {
  return messages.flatMap((message) =>
    message.type === "assistant"
      ? message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
      : message.type === "result" && message.subtype === "success"
        ? [`result:${message.result}`]
        : [],
  );
}

function launches(dir: string): number[] {
  try {
    return NodeFS.readFileSync(NodePath.join(dir, "launches"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "adoptable Claude sessions",
  () => {
    it.live(
      "a restarted server adopts the running CLI and gets the rest of the turn",
      () =>
        Effect.gen(function* () {
          const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-"));
          const cli = fakeClaudeCli(base);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const pid of launches(base)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {}
              }
              resetReleaseForTests();
              NodeFS.rmSync(base, { recursive: true, force: true });
            }),
          );

          // Server A: starts the turn and is shut down after the first step.
          const before = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* openSession(cli, { sessionId: SESSION_ID });
              yield* session.offer({
                type: "user",
                message: { role: "user", content: "go" },
                parent_tool_use_id: null,
              } as never);
              // What SIGTERM does to the server: it lets go of the CLI while the
              // turn streams, then its scopes close the session.
              const seen = yield* session.messages.pipe(
                Stream.takeUntil((message) => {
                  const done = texts([message]).includes("step 1");
                  if (done) releaseAll();
                  return done;
                }),
                Stream.runCollect,
              );
              return Array.from(seen);
            }).pipe(Effect.provide(runnerLayer(base))),
          );
          assert.deepEqual(texts(before), ["step 1"]);
          const [pid] = launches(base);
          assert.isTrue(pid !== undefined && processAlive(pid, null), "the CLI outlived server A");

          // Nobody is attached while step 2 is written.
          NodeFS.writeFileSync(NodePath.join(base, "go1"), "");
          yield* Effect.sleep("300 millis");
          resetReleaseForTests();

          // Server B: resumes the same Claude session and gets the CLI it left.
          const after = yield* Effect.scoped(
            Effect.gen(function* () {
              // MCP registration is a control request the adopted CLI answers
              // on the replayed stream, so the open only returns if it passes.
              const session = yield* openSession(
                cli,
                { resume: SESSION_ID },
                { mcpServers: { probe: { type: "http", url: "http://127.0.0.1:9/mcp" } } },
              );
              NodeFS.writeFileSync(NodePath.join(base, "go2"), "");
              const seen = yield* session.messages.pipe(
                Stream.takeUntil((message) => message.type === "result"),
                Stream.runCollect,
              );
              return Array.from(seen);
            }).pipe(Effect.provide(runnerLayer(base))),
          );
          assert.deepEqual(texts(after), ["step 2", "step 3", "result:done"]);
          assert.equal(launches(base).length, 1, "server B did not start a second CLI");
          // Server B closed the session normally, so the CLI is stopped now.
          yield* Effect.sleep("3 seconds");
          assert.isFalse(processAlive(pid!, null), "closing the adopted session stops the CLI");
        }),
      20_000,
    );

    it.live(
      "a pasted image, larger than the FIFO's buffer, reaches the CLI and gets its answer",
      () =>
        Effect.gen(function* () {
          const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-image-"));
          const cli = fakeClaudeCli(base);
          NodeFS.writeFileSync(NodePath.join(base, "go1"), "");
          NodeFS.writeFileSync(NodePath.join(base, "go2"), "");
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const pid of launches(base)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {}
              }
              NodeFS.rmSync(base, { recursive: true, force: true });
            }),
          );
          const seen = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* openSession(cli, { sessionId: SESSION_ID });
              yield* session.offer(imageMessage());
              return Array.from(
                yield* session.messages.pipe(
                  Stream.takeUntil((message) => message.type === "result"),
                  Stream.runCollect,
                ),
              );
            }).pipe(Effect.provide(runnerLayer(base))),
          );
          assert.deepEqual(texts(seen), ["step 1", "step 2", "step 3", "result:done"]);
        }),
      20_000,
    );

    it.live(
      "a CLI that stops reading its input fails the turn with an error instead of working forever",
      () =>
        Effect.gen(function* () {
          const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-deaf-"));
          const cli = deafClaudeCli(base);
          setDeliveryStallForTests(500);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              setDeliveryStallForTests();
              for (const pid of launches(base)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {}
              }
              NodeFS.rmSync(base, { recursive: true, force: true });
            }),
          );
          const failure = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* openSession(cli, { sessionId: SESSION_ID });
              // More than the FIFO, `cat` and the pipe behind it hold together.
              yield* session.offer(imageMessage(3_000_000));
              return yield* session.messages.pipe(Stream.runDrain, Effect.flip);
            }).pipe(Effect.provide(runnerLayer(base))),
          );
          // What the adapter turns into the failed turn's message in the chat.
          assert.equal(inputStalledMessage(failure), INPUT_STALLED_MESSAGE);
          const [pid] = launches(base);
          assert.isFalse(processAlive(pid!, null), "the CLI that stopped reading was stopped");
        }),
      20_000,
    );

    it("sweep removes launches whose CLI is gone and stops ones silent too long", () => {
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-sweep-"));
      try {
        const sessions = new AdoptableSessions(stateDir);
        const gone = sessions.prepare("thread-gone", "s1");
        NodeFS.writeFileSync(
          NodePath.join(gone.dir, "state.json"),
          JSON.stringify({
            version: 1,
            threadId: "thread-gone",
            sessionId: "s1",
            pid: 0,
            startTime: null,
            createdAt: "",
            offset: 0,
          }),
        );
        const live = sessions.prepare("thread-live", "s2");
        // A turn in progress, so the sweep keeps it.
        NodeFS.writeFileSync(
          NodePath.join(live.dir, "out"),
          '{"type":"system","subtype":"init"}\n',
        );
        NodeFS.writeFileSync(
          NodePath.join(live.dir, "state.json"),
          JSON.stringify({
            version: 1,
            threadId: "thread-live",
            sessionId: "s2",
            pid: process.pid,
            startTime: null,
            createdAt: "",
            offset: 0,
          }),
        );
        assert.deepEqual(sessions.sweep(), { removed: 1, stopped: 0, live: 1 });
        assert.isFalse(NodeFS.existsSync(gone.dir));
        assert.isDefined(sessions.findAdoptable("thread-live", "s2"));
        assert.isUndefined(sessions.findAdoptable("thread-live", "other-session"));
        NodeFS.writeFileSync(NodePath.join(live.dir, "closed"), "");
        assert.isUndefined(
          sessions.findAdoptable("thread-live", "s2"),
          "a closed session is not adopted",
        );
        NodeFS.rmSync(NodePath.join(live.dir, "closed"));
        // Pretend it has been silent too long, with a pid that ignores the TERM (the test runner).
        const signals: string[] = [];
        const kill = process.kill;
        process.kill = ((target: number, signal?: string | number) => {
          if (signal === "SIGTERM") {
            signals.push(`${target}`);
            return true;
          }
          return kill.call(process, target, signal);
        }) as typeof process.kill;
        try {
          const swept = sessions.sweep(Date.now() + UNADOPTED_IDLE_LIMIT_MS + 1000);
          assert.deepEqual(swept, { removed: 0, stopped: 1, live: 0 });
          assert.deepEqual(signals, [`${process.pid}`]);
        } finally {
          process.kill = kill;
        }
      } finally {
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("an idle adopted CLI gets no prompt; one mid-turn gets a note that does not repeat", () => {
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-prompt-"));
      try {
        const sessions = new AdoptableSessions(stateDir);
        const launch = sessions.prepare("thread-prompt", "s3");
        NodeFS.writeFileSync(
          NodePath.join(launch.dir, "state.json"),
          JSON.stringify({
            version: 1,
            threadId: "thread-prompt",
            sessionId: "s3",
            pid: process.pid,
            startTime: null,
            createdAt: "",
            offset: 0,
          }),
        );
        const out = NodePath.join(launch.dir, "out");
        const line = (message: object) => `${JSON.stringify(message)}\n`;
        NodeFS.writeFileSync(
          out,
          line({ type: "system", subtype: "init" }) +
            line({ type: "assistant", message: { content: [] } }) +
            line({ type: "result", subtype: "success", result: "done" }) +
            line({ type: "system", subtype: "background_tasks_changed", tasks: [{ id: "t" }] }),
        );
        const idle = cliStatus(launch.dir, 0);
        assert.isFalse(idle.busy);
        assert.isUndefined(adoptionPrompt(idle), "an idle CLI gets no prompt");
        assert.isTrue(sessions.hasIdleLive("thread-prompt"));
        assert.isFalse(sessions.hasIdleLive("other-thread"));

        NodeFS.appendFileSync(out, line({ type: "assistant", message: { content: [] } }));
        const busy = cliStatus(launch.dir, 0);
        assert.isTrue(busy.busy);
        const note = adoptionPrompt(busy);
        assert.equal(note, ADOPTION_PROMPT);
        assert.include(note!, "continue the current turn");
        assert.notInclude(note!.toLowerCase(), "repeat");
        assert.isFalse(sessions.hasIdleLive("thread-prompt"), "a CLI mid-turn is not idle");
      } finally {
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  },
);
