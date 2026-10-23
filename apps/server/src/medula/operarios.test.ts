// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  bearerToken,
  ensureTokenFile,
  isLoopbackAddress,
  MEDULA_OPERARIOS_TOKEN_FILE,
  parseCancelRequest,
  parseLaunchRequest,
  parseMessageRequest,
  remoteAddressOf,
  resolveModelAlias,
  statusForFailureCode,
  tokensMatch,
} from "./operarios.ts";

describe("auth helpers", () => {
  it("accepts only loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("100.64.0.7")).toBe(false);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
  it("reads the Node socket address", () => {
    expect(remoteAddressOf({ socket: { remoteAddress: "::1" } })).toBe("::1");
    expect(remoteAddressOf({})).toBeNull();
    expect(remoteAddressOf(undefined)).toBeNull();
  });
  it("parses bearer tokens and compares them", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("abc", null)).toBe(false);
  });
  it("creates a private token file once and reuses it", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "medula-operarios-"));
    const first = await ensureTokenFile(dir);
    const second = await ensureTokenFile(dir);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    const stat = NodeFS.statSync(NodePath.join(dir, MEDULA_OPERARIOS_TOKEN_FILE));
    expect(stat.mode & 0o077).toBe(0);
  });
});

describe("requests", () => {
  it("maps model aliases to catalog ids", () => {
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-5-5");
    expect(resolveModelAlias("Opus")).toBe("claude-opus-5-5");
    expect(resolveModelAlias("claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });
  it("parses a launch from a session id", () => {
    const parsed = parseLaunchRequest({
      parentSessionId: "4cab2cbe",
      task: "faz X",
      model: "sonnet",
      title: "X",
      clientRequestId: "O-7",
      options: [{ id: "effort", value: "high" }],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        parentThreadId: null,
        parentSessionId: "4cab2cbe",
        title: "X",
        task: "faz X",
        model: "claude-sonnet-5-5",
        providerInstanceId: null,
        options: [{ id: "effort", value: "high" }],
        clientRequestId: "O-7",
      },
    });
  });
  it("refuses launches without a parent, task or request id", () => {
    expect(parseLaunchRequest({ task: "x", clientRequestId: "O-1" }).ok).toBe(false);
    expect(parseLaunchRequest({ parentThreadId: "t", clientRequestId: "O-1" }).ok).toBe(false);
    expect(parseLaunchRequest({ parentThreadId: "t", task: "x" }).ok).toBe(false);
    expect(
      parseLaunchRequest({ parentThreadId: "t", task: "x", clientRequestId: "O-1", options: {} })
        .ok,
    ).toBe(false);
    expect(parseLaunchRequest([]).ok).toBe(false);
  });
  it("parses messages and cancels", () => {
    expect(parseMessageRequest({ parentThreadId: "p", childThreadId: "c", text: "oi" })).toEqual({
      ok: true,
      value: { parentThreadId: "p", childThreadId: "c", text: "oi", mode: "auto" },
    });
    expect(
      parseMessageRequest({ parentThreadId: "p", childThreadId: "c", text: "oi", mode: "x" }).ok,
    ).toBe(false);
    expect(parseCancelRequest({ parentThreadId: "p", taskId: "n" })).toEqual({
      ok: true,
      value: { parentThreadId: "p", taskId: "n", reason: null },
    });
    expect(parseCancelRequest({ parentThreadId: "p" }).ok).toBe(false);
  });
  it("maps failure codes to statuses", () => {
    expect(statusForFailureCode("task_not_found")).toBe(404);
    expect(statusForFailureCode("parent_not_active")).toBe(409);
    expect(statusForFailureCode("invalid_request")).toBe(400);
    expect(statusForFailureCode("orchestration_error")).toBe(500);
  });
});
