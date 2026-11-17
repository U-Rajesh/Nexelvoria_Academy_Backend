import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { createTestHarness } from "./fakes";
import { startServer, json, type TestServer } from "./helpers/server";

/**
 * Tests against the REAL application, exactly as it is served.
 * No test-only routes are added to it.
 */
describe("application", () => {
  let server: TestServer;

  before(async () => {
    server = await startServer(createApp());
  });

  after(async () => {
    await server.close();
  });

  describe("health endpoint (must not regress)", () => {
    it("returns the exact contract agreed in Step 1", async () => {
      const res = await server.get("/api/v1/health");
      assert.equal(res.status, 200);

      const body = await json(res);
      // Byte-for-byte contract: success + message, and NO data key.
      assert.deepEqual(body, {
        success: true,
        message: "NEXELVORIA Backend is running",
      });
    });
  });

  describe("unknown routes", () => {
    it("returns a 404 in the standard failure envelope", async () => {
      const res = await server.get("/api/v1/does-not-exist");
      assert.equal(res.status, 404);

      const body = await json(res);
      assert.equal(body["success"], false);
      assert.equal(body["error"], "ROUTE_NOT_FOUND");
      assert.match(String(body["message"]), /Route not found: GET/);
    });

    it("404s outside the api prefix too", async () => {
      const res = await server.get("/not-an-api-route");
      assert.equal(res.status, 404);
      assert.equal((await json(res))["error"], "ROUTE_NOT_FOUND");
    });

    it("404s an unknown method on a known path", async () => {
      const res = await server.post("/api/v1/health", {});
      assert.equal(res.status, 404);
    });
  });

  describe("request id", () => {
    it("issues an X-Request-Id and echoes it in the body on failure", async () => {
      const res = await server.get("/api/v1/nope");
      const header = res.headers.get("x-request-id");

      assert.ok(header, "X-Request-Id header must be present");
      assert.equal((await json(res))["requestId"], header);
    });

    it("generates a different id per request", async () => {
      const a = await server.get("/api/v1/health");
      const b = await server.get("/api/v1/health");

      assert.notEqual(a.headers.get("x-request-id"), b.headers.get("x-request-id"));
    });

    it("honours a safe client-supplied id", async () => {
      const res = await server.get("/api/v1/health", {
        headers: { "X-Request-Id": "frontend-trace-12345" },
      });

      assert.equal(res.headers.get("x-request-id"), "frontend-trace-12345");
    });

    it("rejects an unsafe client id instead of logging it", async () => {
      // A newline would let a caller forge extra log lines.
      const res = await server.get("/api/v1/health", {
        headers: { "X-Request-Id": "bad id with spaces" },
      });

      const header = res.headers.get("x-request-id");
      assert.notEqual(header, "bad id with spaces");
      // Replaced by a generated UUID.
      assert.match(String(header), /^[0-9a-f-]{36}$/);
    });
  });

  describe("security headers", () => {
    it("does not advertise the framework", async () => {
      const res = await server.get("/api/v1/health");
      assert.equal(res.headers.get("x-powered-by"), null);
    });

    it("sets a locked-down content security policy", async () => {
      const res = await server.get("/api/v1/health");
      assert.match(String(res.headers.get("content-security-policy")), /default-src 'none'/);
    });

    it("sets nosniff and frame denial", async () => {
      const res = await server.get("/api/v1/health");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
    });

    it("does not send HSTS outside production", async () => {
      const res = await server.get("/api/v1/health");
      assert.equal(res.headers.get("strict-transport-security"), null);
    });
  });

  describe("body limits and malformed input", () => {
    it("rejects malformed JSON as 400, not 500", async () => {
      const res = await fetch(`${server.url}/api/v1/health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      });

      // Route match happens after body parsing, so the parser error wins.
      assert.equal(res.status, 400);
      assert.equal((await json(res))["error"], "MALFORMED_JSON");
    });

    it("rejects an oversized body as 413", async () => {
      const res = await fetch(`${server.url}/api/v1/health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blob: "x".repeat(2 * 1024 * 1024) }),
      });

      assert.equal(res.status, 413);
      assert.equal((await json(res))["error"], "PAYLOAD_TOO_LARGE");
    });
  });

  describe("rate limit headers", () => {
    it("advertises the limit on api routes", async () => {
      const res = await server.get("/api/v1/health");
      assert.ok(res.headers.get("ratelimit"), "RateLimit header should be present");
    });
  });
  describe("dependency injection wiring", () => {
    it("accepts an injected container and still serves health", async () => {
      // Health takes no dependencies, so it must work regardless of what
      // is (or is not) registered. This is the regression guard for the
      // Step 5 container change.
      const harness = createTestHarness();
      const injected = await startServer(createApp({ container: harness.container }));

      try {
        const res = await injected.get("/api/v1/health");
        assert.equal(res.status, 200);

        assert.deepEqual(await json(res), {
          success: true,
          message: "NEXELVORIA Backend is running",
        });
      } finally {
        await injected.close();
      }
    });

    it("serves health with NO repositories registered (production state)", async () => {
      // createApp() defaults to the production container, which registers
      // nothing because the SQL Server adapters do not exist yet. The app
      // must still boot and answer the liveness probe.
      const bare = await startServer(createApp());

      try {
        assert.equal((await bare.get("/api/v1/health")).status, 200);
      } finally {
        await bare.close();
      }
    });
  });
});
