import { afterEach, describe, expect, it } from "vite-plus/test";
import { AuthOrchestrationReadScope, AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerHttp from "../http.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const handlerFor = (authenticated: boolean) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    ServerHttp.layerMedulaContextRoute.pipe(
      Layer.provideMerge(ProjectionStore.layerMemory),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: () =>
            authenticated
              ? Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: [AuthOrchestrationReadScope],
                })
              : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

describe("GET /api/medula/context", () => {
  it("rejects requests without a session", async () => {
    const response = await handlerFor(false)(
      new Request("http://t3.test/api/medula/context?threadId=t1"),
    );
    expect(response.status).toBe(401);
  });

  it("answers thread-not-found for unknown and invalid thread ids", async () => {
    const handler = handlerFor(true);
    for (const query of ["threadId=missing", "threadId=%20", ""]) {
      const response = await handler(new Request(`http://t3.test/api/medula/context?${query}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ available: false, reason: "thread-not-found" });
    }
  });
});
