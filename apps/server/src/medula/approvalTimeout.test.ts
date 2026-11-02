import { describe, expect, it } from "vite-plus/test";

import {
  approvalExpiredMessage,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  describeApprovalRequest,
  readApprovalTimeoutMs,
  resolveApprovalNotifier,
} from "./approvalTimeout.ts";

describe("readApprovalTimeoutMs", () => {
  it("defaults to three minutes", () => {
    expect(readApprovalTimeoutMs({})).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(180_000);
  });

  it("reads seconds from the env and turns off at 0", () => {
    expect(readApprovalTimeoutMs({ T3CODE_MEDULA_APROVACAO_TETO_S: "600" })).toBe(600_000);
    expect(readApprovalTimeoutMs({ T3CODE_MEDULA_APROVACAO_TETO_S: "0" })).toBeNull();
  });

  it("falls back to the default on nonsense", () => {
    expect(readApprovalTimeoutMs({ T3CODE_MEDULA_APROVACAO_TETO_S: "abc" })).toBe(180_000);
    expect(readApprovalTimeoutMs({ T3CODE_MEDULA_APROVACAO_TETO_S: "-5" })).toBe(180_000);
  });
});

describe("approval notice text", () => {
  it("tells the agent how long it waited and how to rewrite", () => {
    expect(approvalExpiredMessage(180_000)).toBe(
      "aprovação expirou sem resposta ao fim de 3 min: reescreve o comando sem o padrão que " +
        "pede aprovação (ex.: git -C, git restore --staged, caminhos absolutos)",
    );
  });

  it("names the command on one line", () => {
    expect(describeApprovalRequest("Bash", { command: "rm -rf a\n  b" }, "prompt")).toBe(
      "Bash: rm -rf a b",
    );
    expect(describeApprovalRequest("Edit", { file_path: "/x/y.ts" }, undefined)).toBe(
      "Edit: /x/y.ts",
    );
    expect(describeApprovalRequest("Odd", {}, undefined)).toBe("Odd");
  });

  it("skips the push when the notifier is off or missing", () => {
    expect(resolveApprovalNotifier({ T3CODE_MEDULA_APROVACAO_AVISO: "" })).toBeNull();
    expect(
      resolveApprovalNotifier({ T3CODE_MEDULA_APROVACAO_AVISO: "/nonexistent/ws-push" }),
    ).toBeNull();
  });
});
