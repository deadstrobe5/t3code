// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- the SDK calls this handle from plain Node callbacks; the FIFO, output file and process group are host objects.
/**
 * Adoptable Claude sessions: a server restart no longer stops the agents.
 *
 * Upstream talks to each Claude CLI over pipes, so the CLI loses its stdin and
 * stdout when the server exits, and the next server stops whatever is left
 * and resumes the session with "Continue where you left off". Here the CLI
 * reads a FIFO and appends to a file instead, both in
 * `<stateDir>/sessoes/<threadId>/<launch>/`, and runs in its own process
 * group (and, on Linux with systemd, in a scope the next server leaves alone).
 * A server that exits only lets go of its sessions. The next server, when it
 * opens the same Claude session for the same thread, attaches to the live CLI
 * instead of spawning a new one and reads its output from where the previous
 * server stopped. Subagents are children of the CLI, so they keep running too.
 *
 * Files in a launch directory:
 * - `in`: FIFO the CLI reads (it opens it read-write, so it never sees EOF).
 * - `out`: everything the CLI writes to stdout, one JSON message per line.
 * - `state.json`: pid, process start time, Claude session id, bytes read.
 * - `init.json`: the CLI's answer to the SDK's `initialize` request, replayed
 *   to the next server's SDK so the running CLI is not initialized twice.
 * - `exit`: the CLI's exit status, written by the launch shim.
 */
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

export const ADOPTABLE_SESSIONS_ENV = "T3_ADOPTABLE_SESSIONS";
export const SESSIONS_DIR_NAME = "sessoes";

/**
 * Runs the CLI with the output file as stdout and `cat` relaying the FIFO to
 * its stdin, then records its exit status and kills what it left in its
 * process group (`cat`, and MCP server children as upstream does on exit).
 * TERM and INT reach the CLI; the shim itself only waits.
 *
 * The CLI reads an ordinary pipe, as it does upstream: on macOS, a CLI reading
 * the FIFO itself stops reading when a line larger than the FIFO's buffer (a
 * pasted image) arrives while it is idle, and the turn never starts.
 */
export const ADOPTABLE_SHIM = [
  "d=$1; shift",
  "trap '' HUP",
  `trap 'kill -TERM "$c" 2>/dev/null' TERM INT`,
  'cat <>"$d/in" | "$@" >>"$d/out" 2>/dev/null &',
  "c=$!",
  'while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || break; done',
  `printf '%s\\n' "$s" >"$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"`,
  "kill -KILL 0",
].join("\n");

const READ_CHUNK = 256 * 1024;
const POLL_INTERVAL_MS = 200;
const EXIT_POLL_INTERVAL_MS = 500;
const STATE_WRITE_DELAY_MS = 300;
/** How long a full FIFO waits before the next write attempt. */
const WRITE_RETRY_MS = 20;
const KILL_GRACE_MS = 5_000;
/**
 * A message that makes no progress into the FIFO for this long is not going
 * to reach the CLI: the session is stopped and the turn fails.
 */
export const DELIVERY_STALL_MS = 60_000;
let deliveryStallMs = DELIVERY_STALL_MS;

/** Tests only: a shorter {@link DELIVERY_STALL_MS}. */
export function setDeliveryStallForTests(ms: number = DELIVERY_STALL_MS): void {
  deliveryStallMs = ms;
}

/** What the chat shows when a message never reached the CLI. */
export const INPUT_STALLED_MESSAGE =
  "Claude stopped reading its input, so your message never reached it. T3 Code stopped the session; send the message again.";

/**
 * {@link INPUT_STALLED_MESSAGE} when `cause` is that failure. The SDK rewraps
 * the process error, so only its text survives.
 */
export function inputStalledMessage(cause: unknown): string | undefined {
  for (let depth = 0; depth < 8 && cause !== null && typeof cause === "object"; depth++) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.includes(INPUT_STALLED_MESSAGE)) {
      return INPUT_STALLED_MESSAGE;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

/** How much of the end of `out` {@link cliStatus} reads. */
const STATUS_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * What the next server tells an agent whose CLI it adopted while a turn was
 * in progress. The CLI folds it into that turn, so it must not change the
 * turn's answer. An idle CLI (its last event was a result) gets no prompt at
 * all: anything sent there would start a new turn and a new answer. Upstream's
 * restart prompts ("Continue where you left off", "this background work was
 * cancelled") are false for an adopted CLI, so they are replaced with this.
 */
export const ADOPTION_PROMPT =
  "Note from T3 Code: the server restarted, but your process kept running and nothing was lost. Ignore this note and continue the current turn. Do not restate anything you already said.";

/** The prompt an adopted CLI gets: none when it is idle. */
export function adoptionPrompt(status: Pick<CliStatus, "busy">): string | undefined {
  return status.busy ? ADOPTION_PROMPT : undefined;
}
const RESTART_PROMPT_MARKERS = [
  "Continue where you left off.",
  "Note: the T3 server restarted, and this background work was cancelled",
];

/** A session nobody adopted and that wrote nothing for this long is stopped. */
export const UNADOPTED_IDLE_LIMIT_MS = 6 * 60 * 60 * 1000;

export interface AdoptableState {
  readonly version: 1;
  readonly threadId: string;
  sessionId: string | null;
  pid: number;
  /** Field 22 of /proc/<pid>/stat, so a reused pid is not taken for the CLI. */
  startTime: string | null;
  readonly createdAt: string;
  /** Bytes of `out` the last server handed to its SDK. */
  offset: number;
}

interface SpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: { readonly [name: string]: string | undefined };
  readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Process-wide shutdown: once the server is going away, sessions let go
// instead of killing their CLI. The SDK kills tracked children on
// process.exit, and session scopes close on SIGTERM; both must miss.

let releasing = false;
const owned = new Set<AdoptableProcess>();
let shutdownHooked = false;

function hookShutdown() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  // Registered before the SDK tracks its first child, so this runs first.
  process.on("exit", () => releaseAll());
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const onSignal = () => {
      releaseAll();
      // Alone, this listener would swallow the signal; keep its default.
      if (process.listenerCount(signal) === 1) {
        process.off(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

/** Lets go of every session this process owns. The CLIs keep running. */
export function releaseAll(): void {
  releasing = true;
  for (const session of owned) session.release();
}

/** Tests only: undo {@link releaseAll} so the same process can adopt. */
export function resetReleaseForTests(): void {
  releasing = false;
  owned.clear();
}

// ---------------------------------------------------------------------------
// Host helpers

function processStartTime(pid: number): string | null {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may contain spaces and parentheses; fields follow the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number, startTime: string | null): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (startTime === null) return true;
  const now = processStartTime(pid);
  return now === null || now === startTime;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonSync(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  NodeFS.renameSync(tmp, file);
}

function readExitStatus(dir: string): number | null {
  try {
    const value = Number.parseInt(NodeFS.readFileSync(NodePath.join(dir, "exit"), "utf8"), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

// ---------------------------------------------------------------------------
// The process handle the SDK talks to.

type Line = { readonly text: string; readonly bytes: number };

/**
 * A Claude CLI behind a FIFO and an output file, shaped like the SDK's
 * `SpawnedProcess`. One server owns it at a time.
 */
export class AdoptableProcess extends NodeEvents.EventEmitter {
  readonly stdin: NodeStream.Writable;
  readonly stdout: NodeStream.Readable;
  readonly dir: string;
  readonly adopted: boolean;

  #state: AdoptableState;
  #exitCode: number | null = null;
  #signalCode: NodeJS.Signals | null = null;
  #killed = false;
  #released = false;
  #finished = false;
  #closedByServer = false;
  #inFd: number | null = null;
  #outFd: number | null = null;
  #readPosition: number;
  #partial = Buffer.alloc(0);
  #pendingInput = "";
  #initRequestId: string | null = null;
  #skipPartials: boolean;
  #processGone = false;
  #reading = false;
  #watcher: NodeFS.FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  #exitTimer: NodeJS.Timeout | null = null;
  #stateTimer: NodeJS.Timeout | null = null;

  constructor(input: {
    readonly dir: string;
    readonly state: AdoptableState;
    readonly adopted: boolean;
    readonly child?: NodeChildProcess.ChildProcess;
  }) {
    super();
    this.dir = input.dir;
    this.adopted = input.adopted;
    this.#state = input.state;
    this.#readPosition = input.state.offset;
    // The previous server may have stopped in the middle of a streamed
    // message; its deltas mean nothing without their message_start.
    this.#skipPartials = input.adopted;
    owned.add(this);
    hookShutdown();

    this.stdin = new NodeStream.Writable({
      write: (chunk: Buffer | string, _encoding, callback) => this.#write(chunk, callback),
      final: (callback) => {
        // The SDK ends stdin when it closes the query: this server is done
        // with the CLI, so no later server may adopt it.
        if (!releasing && !this.#released) this.#markClosed();
        this.#closeInput();
        callback();
      },
    });
    this.stdin.on("error", () => {});
    this.stdout = new NodeStream.Readable({ read: () => {} });

    this.#outFd = NodeFS.openSync(NodePath.join(this.dir, "out"), "r");
    try {
      this.#watcher = NodeFS.watch(NodePath.join(this.dir, "out"), () => this.#pump());
      this.#watcher.on("error", () => {});
    } catch {
      this.#watcher = null;
    }
    this.#timer = setInterval(() => this.#pump(), POLL_INTERVAL_MS);
    this.#timer.unref();
    if (input.child !== undefined) {
      input.child.once("exit", (code, signal) => {
        this.#processGone = true;
        if (code !== null && readExitStatus(this.dir) === null) this.#exitCode = code;
        if (code === null && signal !== "SIGKILL") this.#signalCode = signal;
        this.#pump();
      });
      input.child.once("error", (error) => this.emit("error", error));
    } else {
      this.#exitTimer = setInterval(() => {
        if (
          readExitStatus(this.dir) !== null ||
          !processAlive(this.#state.pid, this.#state.startTime)
        ) {
          this.#processGone = true;
          this.#pump();
        }
      }, EXIT_POLL_INTERVAL_MS);
      this.#exitTimer.unref();
    }
    queueMicrotask(() => this.#pump());
  }

  get pid(): number {
    return this.#state.pid;
  }

  get killed(): boolean {
    return this.#killed;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (releasing || this.#released || this.#finished) return false;
    this.#markClosed();
    try {
      // SIGKILL would leave the CLI behind the shim, so it goes to the group.
      process.kill(signal === "SIGKILL" ? -this.#state.pid : this.#state.pid, signal);
      this.#killed = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Stops reading and writing and records the offset; the CLI keeps running. */
  release(): void {
    if (this.#released || this.#finished) return;
    this.#released = true;
    this.#stopWatching();
    this.#writeState();
    this.#closeInput();
    if (this.#outFd !== null) {
      NodeFS.closeSync(this.#outFd);
      this.#outFd = null;
    }
    owned.delete(this);
  }

  #markClosed() {
    if (this.#closedByServer) return;
    this.#closedByServer = true;
    try {
      NodeFS.writeFileSync(NodePath.join(this.dir, "closed"), "");
    } catch {}
  }

  #closeInput() {
    if (this.#inFd !== null) {
      try {
        NodeFS.closeSync(this.#inFd);
      } catch {}
      this.#inFd = null;
    }
  }

  #write(chunk: Buffer | string, callback: (error?: Error | null) => void) {
    if (releasing || this.#released) return callback();
    this.#pendingInput += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const forward: string[] = [];
    let newline = this.#pendingInput.indexOf("\n");
    while (newline !== -1) {
      const line = this.#pendingInput.slice(0, newline + 1);
      this.#pendingInput = this.#pendingInput.slice(newline + 1);
      const intercepted = this.#interceptInput(line);
      if (intercepted === false) forward.push(line);
      else if (typeof intercepted === "string") forward.push(intercepted);
      newline = this.#pendingInput.indexOf("\n");
    }
    if (forward.length === 0) return callback();
    try {
      // Read-write, so opening never waits for the CLI to open its end.
      // Non-blocking: a blocked write would hold a libuv thread until the CLI
      // reads, and on macOS closing the FIFO then blocks the whole server.
      this.#inFd ??= NodeFS.openSync(
        NodePath.join(this.dir, "in"),
        NodeFS.constants.O_RDWR | NodeFS.constants.O_NONBLOCK,
      );
    } catch (error) {
      return callback(error as Error);
    }
    const data = Buffer.from(forward.join(""), "utf8");
    let lastProgress = Date.now();
    const writeAll = (offset: number) => {
      if (this.#inFd === null) return callback();
      NodeFS.write(this.#inFd, data, offset, data.length - offset, null, (error, written) => {
        if (error && error.code !== "EAGAIN") return callback(error);
        const next = offset + (error ? 0 : written);
        if (next >= data.length) return callback();
        if (next > offset) {
          lastProgress = Date.now();
          return writeAll(next);
        }
        if (Date.now() - lastProgress >= deliveryStallMs) return this.#deliveryStalled(callback);
        setTimeout(() => writeAll(next), WRITE_RETRY_MS);
      });
    };
    writeAll(0);
  }

  /**
   * The CLI stopped reading its input. Waiting longer only leaves the turn
   * "working" forever, so the CLI is stopped and the turn fails with this
   * error instead.
   */
  #deliveryStalled(callback: (error?: Error | null) => void) {
    const error = new Error(INPUT_STALLED_MESSAGE);
    if (this.listenerCount("error") > 0) this.emit("error", error);
    const pid = this.#state.pid;
    this.kill("SIGTERM");
    // A CLI that ignores TERM goes with its whole process group.
    setTimeout(() => {
      if (this.#finished || this.#released) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, KILL_GRACE_MS).unref();
    callback(error);
  }

  /**
   * True when the line is answered here instead of reaching the CLI. On an
   * adopted CLI, a restart prompt is rewritten in place (same uuid, so the
   * CLI's echo still settles the turn that sent it).
   */
  #interceptInput(line: string): boolean | string {
    if (this.adopted && RESTART_PROMPT_MARKERS.some((marker) => line.includes(marker))) {
      return this.#rewriteRestartPrompt(line);
    }
    if (!line.includes('"initialize"')) return false;
    let message: { type?: string; request_id?: string; request?: { subtype?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return false;
    }
    if (message.type !== "control_request" || message.request?.subtype !== "initialize") {
      return false;
    }
    const requestId = message.request_id ?? null;
    if (!this.adopted) {
      this.#initRequestId = requestId;
      return false;
    }
    // The running CLI was initialized by the previous server; answer with
    // what it said then.
    const recorded = readJson<unknown>(NodePath.join(this.dir, "init.json"));
    if (recorded === undefined) return false;
    const reply = {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: recorded },
    };
    this.stdout.push(`${JSON.stringify(reply)}\n`);
    return true;
  }

  #rewriteRestartPrompt(line: string): string | false {
    let message: { type?: string; message?: { content?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return false;
    }
    if (message.type !== "user" || message.message === undefined) return false;
    const content = message.message.content;
    const rewrite = (text: string) =>
      RESTART_PROMPT_MARKERS.some((marker) => text.includes(marker)) ? ADOPTION_PROMPT : text;
    if (typeof content === "string") {
      message.message.content = rewrite(content);
    } else if (Array.isArray(content)) {
      message.message.content = content.map((block: { type?: string; text?: string }) =>
        block.type === "text" && typeof block.text === "string"
          ? { ...block, text: rewrite(block.text) }
          : block,
      );
    } else {
      return false;
    }
    return `${JSON.stringify(message)}\n`;
  }

  #pump() {
    if (this.#reading || this.#released || this.#finished || this.#outFd === null) return;
    this.#reading = true;
    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK);
      for (;;) {
        const read = NodeFS.readSync(this.#outFd, buffer, 0, READ_CHUNK, this.#readPosition);
        if (read === 0) break;
        this.#readPosition += read;
        this.#partial = Buffer.concat([this.#partial, buffer.subarray(0, read)]);
        this.#drainLines();
      }
    } finally {
      this.#reading = false;
    }
    if (this.#processGone) this.#finish();
  }

  #drainLines() {
    let newline = this.#partial.indexOf(0x0a);
    const lines: Line[] = [];
    while (newline !== -1) {
      const raw = this.#partial.subarray(0, newline);
      lines.push({ text: raw.toString("utf8"), bytes: newline + 1 });
      this.#partial = this.#partial.subarray(newline + 1);
      newline = this.#partial.indexOf(0x0a);
    }
    for (const line of lines) {
      this.#state.offset += line.bytes;
      if (this.#keepOutput(line.text)) this.stdout.push(`${line.text}\n`);
    }
    if (lines.length > 0) this.#scheduleState();
  }

  #keepOutput(text: string): boolean {
    if (text.trim().length === 0) return false;
    if (!this.#skipPartials && this.#initRequestId === null && this.#state.sessionId !== null) {
      return true;
    }
    let message: {
      type?: string;
      subtype?: string;
      session_id?: string;
      event?: { type?: string };
      response?: { subtype?: string; request_id?: string; response?: unknown };
    };
    try {
      message = JSON.parse(text);
    } catch {
      return true;
    }
    if (typeof message.session_id === "string" && message.session_id !== this.#state.sessionId) {
      this.#state.sessionId = message.session_id;
    }
    if (
      this.#initRequestId !== null &&
      message.type === "control_response" &&
      message.response?.request_id === this.#initRequestId
    ) {
      if (message.response.subtype === "success") {
        writeJsonSync(NodePath.join(this.dir, "init.json"), message.response.response ?? {});
      }
      this.#initRequestId = null;
    }
    // Control responses always pass: the new SDK's own requests (MCP
    // registration) are answered on this stream, and stale ones it ignores.
    if (this.#skipPartials) {
      if (message.type === "stream_event") {
        if (message.event?.type !== "message_start") return false;
        this.#skipPartials = false;
      }
    }
    return true;
  }

  #scheduleState() {
    if (this.#stateTimer !== null) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      if (!this.#released && !this.#finished) this.#writeState();
    }, STATE_WRITE_DELAY_MS);
    this.#stateTimer.unref();
  }

  #writeState() {
    if (this.#stateTimer !== null) {
      clearTimeout(this.#stateTimer);
      this.#stateTimer = null;
    }
    try {
      writeJsonSync(NodePath.join(this.dir, "state.json"), this.#state);
    } catch {}
  }

  #stopWatching() {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#timer !== null) clearInterval(this.#timer);
    if (this.#exitTimer !== null) clearInterval(this.#exitTimer);
    this.#timer = null;
    this.#exitTimer = null;
  }

  #finish() {
    if (this.#finished) return;
    this.#finished = true;
    this.#stopWatching();
    if (this.#partial.length > 0) {
      const text = this.#partial.toString("utf8");
      this.#partial = Buffer.alloc(0);
      if (this.#keepOutput(text)) this.stdout.push(`${text}\n`);
    }
    const status = readExitStatus(this.dir);
    if (status !== null) this.#exitCode = status;
    if (this.#exitCode === null && this.#signalCode === null) this.#exitCode = 1;
    this.#closeInput();
    if (this.#outFd !== null) {
      NodeFS.closeSync(this.#outFd);
      this.#outFd = null;
    }
    owned.delete(this);
    // The server saw the end, so the next one has nothing to adopt or replay.
    if (!releasing) NodeFS.rmSync(this.dir, { recursive: true, force: true });
    this.stdout.push(null);
    this.emit("exit", this.#exitCode, this.#signalCode);
  }
}

// ---------------------------------------------------------------------------
// What a CLI is doing, read from the end of its output.

export interface CliStatus {
  /** A turn started after the last result and has not ended. */
  readonly busy: boolean;
  /** The CLI's last list of background tasks is not empty. */
  readonly background: boolean;
  /** Output the previous server never read. */
  readonly unread: boolean;
}

export function cliStatus(dir: string, offset: number): CliStatus {
  let text = "";
  let size = 0;
  try {
    const fd = NodeFS.openSync(NodePath.join(dir, "out"), "r");
    try {
      size = NodeFS.fstatSync(fd).size;
      const start = Math.max(0, size - STATUS_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      NodeFS.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return { busy: false, background: false, unread: false };
  }
  let busy = false;
  let background = false;
  for (const line of text.split("\n")) {
    if (line.length === 0 || line[0] !== "{") continue;
    let message: { type?: string; subtype?: string; tasks?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    switch (message.type) {
      case "result":
        busy = false;
        break;
      case "assistant":
      case "user":
      case "stream_event":
        busy = true;
        break;
      case "system":
        if (message.subtype === "init") busy = true;
        if (message.subtype === "background_tasks_changed") {
          background = Array.isArray(message.tasks) && message.tasks.length > 0;
        }
        break;
    }
  }
  return { busy, background, unread: offset < size };
}

// ---------------------------------------------------------------------------
// The registry under <stateDir>/sessoes.

export interface AdoptableLaunch {
  readonly dir: string;
  /** The shim and its arguments; the CLI and its arguments follow. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Spawns the wrapped command (shim included) with the CLI's arguments. */
  readonly spawn: (input: SpawnInput) => AdoptableProcess;
}

export class AdoptableSessions {
  readonly root: string;

  constructor(stateDir: string) {
    this.root = NodePath.join(stateDir, SESSIONS_DIR_NAME);
  }

  static enabled(env: { readonly [name: string]: string | undefined }, platform: string): boolean {
    if (platform === "win32") return false;
    return env[ADOPTABLE_SESSIONS_ENV] !== "0";
  }

  #threadDir(threadId: string) {
    return NodePath.join(this.root, safeSegment(threadId));
  }

  /** Creates a launch directory and the FIFO the CLI will read. */
  prepare(threadId: string, sessionId: string | null): AdoptableLaunch {
    const dir = NodePath.join(
      this.#threadDir(threadId),
      `${Date.now().toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}`,
    );
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    NodeChildProcess.execFileSync("mkfifo", ["-m", "600", NodePath.join(dir, "in")]);
    NodeFS.writeFileSync(NodePath.join(dir, "out"), "", { mode: 0o600 });
    const base: AdoptableState = {
      version: 1,
      threadId,
      sessionId,
      pid: 0,
      startTime: null,
      createdAt: new Date().toISOString(),
      offset: 0,
    };
    return {
      dir,
      command: "/bin/sh",
      args: ["-c", ADOPTABLE_SHIM, "t3-session", dir],
      spawn: (input) => {
        const child = NodeChildProcess.spawn(input.command, [...input.args], {
          cwd: input.cwd,
          env: input.env as NodeJS.ProcessEnv,
          stdio: ["ignore", "ignore", "ignore"],
          detached: true,
        });
        // Not unref'd as a child: its exit event is how this server sees the end.
        const state: AdoptableState = {
          ...base,
          pid: child.pid ?? 0,
          startTime: child.pid === undefined ? null : processStartTime(child.pid),
        };
        writeJsonSync(NodePath.join(dir, "state.json"), state);
        const handle = new AdoptableProcess({ dir, state, adopted: false, child });
        input.signal?.addEventListener("abort", () => handle.kill("SIGTERM"), { once: true });
        return handle;
      },
    };
  }

  /**
   * The live CLI a previous server left for this thread and Claude session,
   * if any. Sessions this process owns are never adopted: a second query
   * for the same thread here means the first is being replaced.
   */
  findAdoptable(
    threadId: string,
    sessionId: string,
  ): { dir: string; state: AdoptableState } | undefined {
    const threadDir = this.#threadDir(threadId);
    let entries: string[];
    try {
      entries = NodeFS.readdirSync(threadDir).toSorted().toReversed();
    } catch {
      return undefined;
    }
    for (const name of entries) {
      const dir = NodePath.join(threadDir, name);
      if ([...owned].some((session) => session.dir === dir)) continue;
      if (NodeFS.existsSync(NodePath.join(dir, "closed"))) continue;
      if (readExitStatus(dir) !== null) continue;
      const state = readJson<AdoptableState>(NodePath.join(dir, "state.json"));
      if (state === undefined || state.sessionId !== sessionId) continue;
      if (!processAlive(state.pid, state.startTime)) continue;
      return { dir, state };
    }
    return undefined;
  }

  /**
   * Live CLIs a previous server left that still have something to say: a
   * turn in progress, background work, or output nobody read.
   */
  listLive(): Array<{ dir: string; state: AdoptableState; status: CliStatus }> {
    const live: Array<{ dir: string; state: AdoptableState; status: CliStatus }> = [];
    for (const dir of this.#launchDirs()) {
      if ([...owned].some((session) => session.dir === dir)) continue;
      if (NodeFS.existsSync(NodePath.join(dir, "closed"))) continue;
      if (readExitStatus(dir) !== null) continue;
      const state = readJson<AdoptableState>(NodePath.join(dir, "state.json"));
      if (state === undefined || state.sessionId === null) continue;
      if (!processAlive(state.pid, state.startTime)) continue;
      const status = cliStatus(dir, state.offset);
      if (status.busy || status.background || status.unread) live.push({ dir, state, status });
    }
    return live;
  }

  /**
   * True when a previous server left a live CLI for this thread and its last
   * event was a result: no turn is in progress, so a restart prompt must not
   * reach it. Its session is adopted, and its unread output delivered, the
   * next time the thread opens it.
   */
  hasIdleLive(threadId: string): boolean {
    const threadDir = this.#threadDir(threadId);
    let entries: string[];
    try {
      entries = NodeFS.readdirSync(threadDir);
    } catch {
      return false;
    }
    for (const name of entries) {
      const dir = NodePath.join(threadDir, name);
      if ([...owned].some((session) => session.dir === dir)) continue;
      if (NodeFS.existsSync(NodePath.join(dir, "closed"))) continue;
      if (readExitStatus(dir) !== null) continue;
      const state = readJson<AdoptableState>(NodePath.join(dir, "state.json"));
      if (state === undefined || state.sessionId === null) continue;
      if (!processAlive(state.pid, state.startTime)) continue;
      if (adoptionPrompt(cliStatus(dir, state.offset)) === undefined) return true;
    }
    return false;
  }

  #launchDirs(): string[] {
    const dirs: string[] = [];
    let threads: string[];
    try {
      threads = NodeFS.readdirSync(this.root);
    } catch {
      return dirs;
    }
    for (const thread of threads) {
      try {
        for (const name of NodeFS.readdirSync(NodePath.join(this.root, thread))) {
          dirs.push(NodePath.join(this.root, thread, name));
        }
      } catch {}
    }
    return dirs;
  }

  adopt(found: { dir: string; state: AdoptableState }): AdoptableProcess {
    const handle = new AdoptableProcess({ dir: found.dir, state: found.state, adopted: true });
    return handle;
  }

  /**
   * Startup sweep: removes launches whose CLI is gone, and stops CLIs nobody
   * adopted that have been silent for {@link UNADOPTED_IDLE_LIMIT_MS}.
   */
  sweep(now = Date.now()): { removed: number; stopped: number; live: number } {
    let removed = 0;
    let stopped = 0;
    let live = 0;
    let threads: string[];
    try {
      threads = NodeFS.readdirSync(this.root);
    } catch {
      return { removed, stopped, live };
    }
    for (const thread of threads) {
      const threadDir = NodePath.join(this.root, thread);
      let launches: string[];
      try {
        launches = NodeFS.readdirSync(threadDir);
      } catch {
        continue;
      }
      for (const name of launches) {
        const dir = NodePath.join(threadDir, name);
        if ([...owned].some((session) => session.dir === dir)) continue;
        const state = readJson<AdoptableState>(NodePath.join(dir, "state.json"));
        const alive = state !== undefined && processAlive(state.pid, state.startTime);
        if (!alive) {
          NodeFS.rmSync(dir, { recursive: true, force: true });
          removed++;
          continue;
        }
        let silentFor = 0;
        try {
          silentFor = now - NodeFS.statSync(NodePath.join(dir, "out")).mtimeMs;
        } catch {}
        const status = cliStatus(dir, state.offset);
        // An idle CLI loses nothing: the next message resumes its session,
        // as upstream does for every CLI after a restart.
        const idle = !status.busy && !status.background && !status.unread;
        if (idle || silentFor > UNADOPTED_IDLE_LIMIT_MS) {
          try {
            process.kill(state.pid, "SIGTERM");
          } catch {}
          NodeFS.writeFileSync(NodePath.join(dir, "closed"), "");
          stopped++;
          continue;
        }
        live++;
      }
      try {
        NodeFS.rmdirSync(threadDir);
      } catch {}
    }
    return { removed, stopped, live };
  }
}
