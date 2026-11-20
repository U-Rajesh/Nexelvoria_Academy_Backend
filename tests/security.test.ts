import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cors from "cors";

import { DEV_ORIGINS, buildCorsOptions, isOriginAllowed } from "../src/config/cors";
import { errorHandler } from "../src/middleware/error.middleware";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import { requestContext } from "../src/middleware/request-context.middleware";
import { ApiError } from "../src/utils/api-error";
import { REDACTED, redact, redactHeaders } from "../src/utils/redact";
import { sendSuccess } from "../src/utils/send";
import { startServer, json } from "./helpers/server";

const ALLOWED = ["http://localhost:5173", "https://app.nexelvoria.edu.in"] as const;

describe("security", () => {
  describe("CORS origin policy", () => {
    it("allows a configured origin", () => {
      assert.equal(isOriginAllowed("http://localhost:5173", ALLOWED), true);
      assert.equal(isOriginAllowed("https://app.nexelvoria.edu.in", ALLOWED), true);
    });

    it("rejects an origin that is not configured", () => {
      assert.equal(isOriginAllowed("https://evil.example.com", ALLOWED), false);
    });

    it("rejects a lookalike origin", () => {
      // Substring and suffix tricks must not pass.
      assert.equal(isOriginAllowed("https://app.nexelvoria.edu.in.evil.com", ALLOWED), false);
      assert.equal(isOriginAllowed("https://notapp.nexelvoria.edu.in", ALLOWED), false);
    });

    it("rejects the same host on a different scheme or port", () => {
      assert.equal(isOriginAllowed("http://app.nexelvoria.edu.in", ALLOWED), false);
      assert.equal(isOriginAllowed("http://localhost:3000", ALLOWED), false);
    });

    it("allows a request with no Origin header (non-browser caller)", () => {
      // curl, health probes and server-to-server calls send no Origin and
      // are not subject to CORS. Authorization still applies to them.
      assert.equal(isOriginAllowed(undefined, ALLOWED), true);
    });

    it("rejects everything when the allow-list is empty", () => {
      // This is the production posture if CORS_ORIGINS were ever empty -
      // env.ts refuses to start in that case, so this is belt and braces.
      assert.equal(isOriginAllowed("https://app.nexelvoria.edu.in", []), false);
      assert.equal(isOriginAllowed("http://localhost:5173", []), false);
    });

    it("never produces a wildcard policy", () => {
      const options = buildCorsOptions(ALLOWED);
      assert.notEqual(options.origin, "*");
      assert.equal(typeof options.origin, "function");
      assert.equal(options.credentials, true);
    });

    it("dev defaults cover the Vite dev server only", () => {
      assert.ok(DEV_ORIGINS.includes("http://localhost:5173"));
      assert.equal(DEV_ORIGINS.some((o) => o.includes("nexelvoria")), false);
    });
  });

  describe("CORS over HTTP", () => {
    const corsApp = () => {
      const app = express();
      app.use(cors(buildCorsOptions(ALLOWED)));
      app.get("/thing", (_req, res) => sendSuccess(res, { message: "ok" }));
      return app;
    };

    it("reflects an allowed origin in the response headers", async () => {
      const server = await startServer(corsApp());

      try {
        const res = await server.get("/thing", {
          headers: { Origin: "http://localhost:5173" },
        });

        assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
      } finally {
        await server.close();
      }
    });

    it("omits CORS headers for a disallowed origin", async () => {
      const server = await startServer(corsApp());

      try {
        const res = await server.get("/thing", {
          headers: { Origin: "https://evil.example.com" },
        });

        // Denial is the ABSENCE of the header - the browser blocks the read.
        // The request itself still succeeds, which is how CORS works.
        assert.equal(res.headers.get("access-control-allow-origin"), null);
      } finally {
        await server.close();
      }
    });

    it("does not answer a preflight from a disallowed origin with approval", async () => {
      const server = await startServer(corsApp());

      try {
        const res = await fetch(`${server.url}/thing`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
          },
        });

        assert.equal(res.headers.get("access-control-allow-origin"), null);
      } finally {
        await server.close();
      }
    });
  });

  describe("rate limiting", () => {
    const limitedApp = (limit: number) => {
      const app = express();
      app.set("trust proxy", 1);
      app.use(requestContext);
      app.use(createRateLimiter({ windowMs: 60_000, limit, message: "Too many requests." }));
      app.get("/ping", (_req, res) => sendSuccess(res, { message: "pong" }));
      app.use(errorHandler);
      return app;
    };

    it("allows requests up to the limit then returns 429", async () => {
      const server = await startServer(limitedApp(3));

      try {
        for (let i = 1; i <= 3; i += 1) {
          const res = await server.get("/ping");
          assert.equal(res.status, 200, `request ${i} should pass`);
        }

        const blocked = await server.get("/ping");
        assert.equal(blocked.status, 429);

        const body = await json(blocked);
        assert.equal(body["success"], false);
        assert.equal(body["error"], "TOO_MANY_REQUESTS");
        // 429s flow through the normal error pipeline, so they carry an id.
        assert.ok(body["requestId"]);
      } finally {
        await server.close();
      }
    });

    it("exposes standard RateLimit headers", async () => {
      const server = await startServer(limitedApp(5));

      try {
        const res = await server.get("/ping");
        assert.ok(res.headers.get("ratelimit"), "RateLimit header expected");
      } finally {
        await server.close();
      }
    });

    it("keeps counting once blocked (does not reset on rejection)", async () => {
      const server = await startServer(limitedApp(1));

      try {
        assert.equal((await server.get("/ping")).status, 200);
        assert.equal((await server.get("/ping")).status, 429);
        assert.equal((await server.get("/ping")).status, 429);
      } finally {
        await server.close();
      }
    });
  });

  describe("production error sanitization", () => {
    /**
     * `isProduction` is read at module load, so instead of reloading the
     * module graph we assert the two behaviours that matter and verify the
     * production branch directly through the same code path by checking
     * that an unexpected error never carries its own message into an
     * ApiError-shaped response.
     */
    const errorApp = () => {
      const app = express();
      app.use(requestContext);

      app.get("/raw", () => {
        throw new Error("DB password is hunter2 at 10.0.0.5");
      });

      app.get("/api-error", () => {
        throw ApiError.forbidden("You cannot do that", "NO_ACCESS");
      });

      app.use(errorHandler);
      return app;
    };

    it("returns 500 with the generic code for an unexpected error", async () => {
      const server = await startServer(errorApp());

      try {
        const res = await server.get("/raw");
        assert.equal(res.status, 500);

        const body = await json(res);
        assert.equal(body["success"], false);
        assert.equal(body["error"], "INTERNAL_SERVER_ERROR");
        // No stack trace is ever serialised to the client.
        assert.equal(body["stack"], undefined);
        assert.ok(body["requestId"], "a 500 must be traceable to a log line");
      } finally {
        await server.close();
      }
    });

    it("passes an operational ApiError message through deliberately", async () => {
      const server = await startServer(errorApp());

      try {
        const res = await server.get("/api-error");
        assert.equal(res.status, 403);

        const body = await json(res);
        assert.equal(body["message"], "You cannot do that");
        assert.equal(body["error"], "NO_ACCESS");
      } finally {
        await server.close();
      }
    });

    it("sanitizes the message when NODE_ENV=production", async () => {
      // Verified in a child process because `isProduction` is resolved at
      // import time - this is the only honest way to assert the production
      // branch without mutating module state.
      const { execFileSync } = await import("node:child_process");
      const { randomBytes } = await import("node:crypto");

      // Production now refuses to start without a valid JWT_SECRET (env.ts,
      // since the auth module), and error.middleware imports env. Supply a
      // RANDOM secret generated per run - never a committed or reusable
      // value - through the child's environment, not the script text.
      const childSecret = randomBytes(48).toString("base64url");

      const script = `
        process.env.NODE_ENV = "production";
        process.env.CORS_ORIGINS = "https://app.nexelvoria.edu.in";
        const express = require("express");
        const { errorHandler } = require("./src/middleware/error.middleware");
        const app = express();
        app.get("/raw", () => { throw new Error("DB password is hunter2"); });
        app.use(errorHandler);
        const s = app.listen(0, async () => {
          const res = await fetch("http://127.0.0.1:" + s.address().port + "/raw");
          const body = await res.json();
          console.log(JSON.stringify({ status: res.status, message: body.message, error: body.error }));
          s.close();
        });
      `;

      const out = execFileSync(
        process.execPath,
        ["--import", "tsx", "-e", script],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, JWT_SECRET: childSecret },
        },
      );

      const result = JSON.parse(out.trim().split("\n").pop() ?? "{}") as {
        status: number;
        message: string;
        error: string;
      };

      assert.equal(result.status, 500);
      assert.equal(result.message, "Internal server error");
      assert.equal(result.error, "INTERNAL_SERVER_ERROR");
      // The real message must not appear anywhere in the response.
      assert.equal(result.message.includes("hunter2"), false);
    });
  });

  describe("secret redaction in logs", () => {
    it("redacts common secret-bearing keys", () => {
      const output = redact({
        email: "a@b.com",
        password: "hunter2",
        confirmPassword: "hunter2",
        token: "eyJhbGciOi",
        refreshToken: "abc",
        otp: "123456",
        apiKey: "k-1",
        api_key: "k-2",
        secret: "s",
        authorization: "Bearer x",
        cardNumber: "4111111111111111",
        cvv: "123",
      }) as Record<string, unknown>;

      assert.equal(output["email"], "a@b.com", "non-sensitive data is kept");

      for (const key of [
        "password",
        "confirmPassword",
        "token",
        "refreshToken",
        "otp",
        "apiKey",
        "api_key",
        "secret",
        "authorization",
        "cardNumber",
        "cvv",
      ]) {
        assert.equal(output[key], REDACTED, `${key} must be redacted`);
      }
    });

    it("redacts nested secrets", () => {
      const output = redact({
        user: { name: "Raj", credentials: { password: "x" } },
      }) as Record<string, Record<string, Record<string, unknown>>>;

      assert.equal(output["user"]?.["name"], "Raj");
      // "credentials" matches the pattern, so the whole subtree is replaced.
      assert.equal(output["user"]?.["credentials"] as unknown, REDACTED);
    });

    it("redacts secrets inside arrays", () => {
      const output = redact([{ otp: "1" }, { safe: "yes" }]) as Record<string, unknown>[];

      assert.equal(output[0]?.["otp"], REDACTED);
      assert.equal(output[1]?.["safe"], "yes");
    });

    it("survives circular references", () => {
      const node: Record<string, unknown> = { name: "a" };
      node["self"] = node;

      const output = redact(node) as Record<string, unknown>;
      assert.equal(output["name"], "a");
      assert.equal(output["self"], "[CIRCULAR]");
    });

    it("converts an Error into a loggable object keeping the stack", () => {
      const output = redact(new Error("boom")) as Record<string, unknown>;

      assert.equal(output["message"], "boom");
      assert.ok(String(output["stack"]).includes("boom"));
    });

    it("strips sensitive headers", () => {
      const output = redactHeaders({
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        cookie: "session=abc",
        "x-api-key": "k",
      });

      assert.equal(output["content-type"], "application/json");
      assert.equal(output["authorization"], REDACTED);
      assert.equal(output["cookie"], REDACTED);
      assert.equal(output["x-api-key"], REDACTED);
    });

    it("leaves primitives untouched", () => {
      assert.equal(redact("plain"), "plain");
      assert.equal(redact(42), 42);
      assert.equal(redact(null), null);
      assert.equal(redact(undefined), undefined);
    });
  });
});
