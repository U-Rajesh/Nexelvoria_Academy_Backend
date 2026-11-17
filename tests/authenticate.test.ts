import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Application, type RequestHandler } from "express";
import jwt from "jsonwebtoken";

import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { createProductionContainer } from "../src/container/container";
import type { UserRole } from "../src/contracts/user.contract";
import {
  createAuthenticate,
  extractBearerToken,
} from "../src/middleware/authenticate.middleware";
import {
  requireAdmin,
  requireAuth,
  requireStudent,
  requireSuperAdmin,
  requireTeacher,
} from "../src/middleware/authorize.middleware";
import { errorHandler } from "../src/middleware/error.middleware";
import { notFoundHandler } from "../src/middleware/not-found.middleware";
import { requestContext } from "../src/middleware/request-context.middleware";
import type { SessionRepository } from "../src/modules/auth/session.repository";
import {
  JWT_ALGORITHM,
  generateRefreshToken,
  issueAccessToken,
} from "../src/modules/auth/token.service";
import { sendSuccess } from "../src/utils/send";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer } from "./helpers/server";

/**
 * Session-aware authentication tests.
 *
 * Protected routes live HERE, in the test file. The real application still
 * exposes no authenticated endpoint - `createApp()` mounts only health - so
 * there is no test or bypass route in `src`, in any environment.
 *
 * Tokens are minted with the real token service using the test-only secret
 * from `.env.test`, and sessions with the in-memory fake. No secret or token
 * value is ever printed.
 */

const past = (minutes = 60): string => new Date(Date.now() - minutes * 60_000).toISOString();

describe("session-aware authentication", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  /** Opens a real session and mints a matching access token. */
  const login = async (
    role: UserRole = "student",
    userId = `user-${role}`,
    options: { expiresAt?: string } = {},
  ): Promise<{ token: string; sessionId: string; userId: string }> => {
    const refresh = generateRefreshToken();

    const session = await h.sessions.create({
      userId,
      refreshTokenHash: refresh.tokenHash,
      expiresAt: options.expiresAt ?? refresh.expiresAt,
    });

    const { token } = issueAccessToken({ userId, role, sessionId: session.sessionId });

    return { token, sessionId: session.sessionId, userId };
  };

  /**
   * Builds an app with one protected route.
   *
   * `sessions` defaults to the harness fake; a test can pass a resolver that
   * throws to exercise the fail-closed path.
   */
  const buildApp = (
    guard: RequestHandler = requireAuth,
    sessions: () => SessionRepository = () => h.sessions,
  ): Application => {
    const app = express();
    app.use(requestContext);

    const authenticate = createAuthenticate({ sessions });

    app.get("/protected", authenticate, guard, (req, res) =>
      sendSuccess(res, { data: { principal: req.principal ?? null } }),
    );

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
  };

  const call = async (
    headers: Record<string, string> = {},
    guard: RequestHandler = requireAuth,
    sessions: () => SessionRepository = () => h.sessions,
    path = "/protected",
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const server = await startServer(buildApp(guard, sessions));

    try {
      const res = await server.get(path, { headers });
      return { status: res.status, body: await json(res) };
    } finally {
      await server.close();
    }
  };

  const withToken = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
  });

  describe("bearer token extraction", () => {
    it("accepts a well-formed header, case-insensitive scheme", () => {
      assert.equal(extractBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
      assert.equal(extractBearerToken("bearer abc"), "abc");
      assert.equal(extractBearerToken("BEARER abc"), "abc");
      assert.equal(extractBearerToken("Bearer   abc"), "abc");
      assert.equal(extractBearerToken("  Bearer abc  "), "abc");
    });

    it("rejects anything that is not a bearer credential", () => {
      for (const header of [
        undefined,
        "",
        "   ",
        "abc.def.ghi",
        "Basic dXNlcjpwYXNz",
        "Digest xyz",
        "Bearer",
        "Bearer ",
        "Bearer a b",
        "BearerAbc",
        "Token abc",
      ]) {
        assert.equal(extractBearerToken(header), null, `${String(header)} must not parse`);
      }
    });
  });

  describe("valid token with an active, matching session", () => {
    it("admits the request and attaches the token-derived identity", async () => {
      const { token, sessionId, userId } = await login("student", "user-42");

      const { status, body } = await call(withToken(token));

      assert.equal(status, 200);

      const principal = (body["data"] as { principal: Record<string, unknown> }).principal;

      // Exactly the three token claims - no email, no profile data.
      assert.deepEqual(Object.keys(principal).sort(), ["id", "role", "sessionId"]);
      assert.equal(principal["id"], userId);
      assert.equal(principal["role"], "student");
      assert.equal(principal["sessionId"], sessionId);
    });

    it("records session activity on a successful request", async () => {
      const { token, sessionId } = await login();

      const before = await h.sessions.findBySessionId(sessionId);
      await h.sessions.updateLastActiveAt(sessionId, past(10));

      const { status } = await call(withToken(token));
      assert.equal(status, 200);

      const after = await h.sessions.findBySessionId(sessionId);
      assert.ok(before && after);
      assert.ok(
        Date.parse(after.lastActiveAt) > Date.parse(past(10)),
        "lastActiveAt should move forward",
      );
    });

    it("admits every authenticated role", async () => {
      for (const role of ["student", "teacher", "admin", "super_admin"] as const) {
        const { token } = await login(role);
        const { status } = await call(withToken(token));

        assert.equal(status, 200, `${role} should be admitted`);
      }
    });
  });

  describe("session validation — a valid JWT is NOT enough", () => {
    it("rejects a token whose session does not exist", async () => {
      // A perfectly signed token for a sid that was never stored (or purged).
      const { token } = issueAccessToken({
        userId: "user-1",
        role: "admin",
        sessionId: "session-never-created",
      });

      const { status, body } = await call(withToken(token));

      assert.equal(status, 401);
      assert.equal(body["error"], "UNAUTHENTICATED");
    });

    it("rejects a token whose session was REVOKED", async () => {
      const { token, sessionId, userId } = await login("admin");

      // Works before revocation.
      assert.equal((await call(withToken(token))).status, 200);

      await h.sessions.revokeSession({ sessionId, userId, reason: "logout" });

      // Same token, still cryptographically valid, now refused.
      const { status, body } = await call(withToken(token));

      assert.equal(status, 401, "revocation must take effect on the next request");
      assert.equal(body["error"], "UNAUTHENTICATED");
    });

    it("rejects a token whose session EXPIRED", async () => {
      const { token } = await login("student", "user-student", { expiresAt: past(1) });

      const { status, body } = await call(withToken(token));

      assert.equal(status, 401);
      assert.equal(body["error"], "UNAUTHENTICATED");
    });

    it("rejects when the token subject does not own the session", async () => {
      // Session belongs to user-b; the token claims user-a.
      const refresh = generateRefreshToken();
      const session = await h.sessions.create({
        userId: "user-b",
        refreshTokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });

      const { token } = issueAccessToken({
        userId: "user-a",
        role: "super_admin",
        sessionId: session.sessionId,
      });

      const { status, body } = await call(withToken(token));

      assert.equal(status, 401, "session ownership must be enforced");
      assert.equal(body["error"], "UNAUTHENTICATED");
    });

    it("rejects every revocation reason identically", async () => {
      for (const reason of [
        "logout",
        "logout_all",
        "token_reuse_detected",
        "password_changed",
        "account_suspended",
        "role_changed",
        "admin_terminated",
      ] as const) {
        const { token, sessionId, userId } = await login("teacher", `user-${reason}`);
        await h.sessions.revokeSession({ sessionId, userId, reason });

        const { status, body } = await call(withToken(token));

        assert.equal(status, 401, `${reason} must deny`);
        // The reason is for operators, never the client.
        assert.equal(body["error"], "UNAUTHENTICATED");
        assert.equal(JSON.stringify(body).includes(reason), false);
      }
    });

    it("session revocation invalidates all tokens minted for it", async () => {
      const { sessionId, userId } = await login("admin");

      // Two access tokens for the SAME session.
      const a = issueAccessToken({ userId, role: "admin", sessionId }).token;
      const b = issueAccessToken({ userId, role: "admin", sessionId }).token;

      assert.equal((await call(withToken(a))).status, 200);
      assert.equal((await call(withToken(b))).status, 200);

      await h.sessions.revokeSession({ sessionId, userId, reason: "admin_terminated" });

      assert.equal((await call(withToken(a))).status, 401);
      assert.equal((await call(withToken(b))).status, 401, "both tokens die with the session");
    });
  });

  describe("token-level rejections (all 401)", () => {
    it("rejects a missing Authorization header", async () => {
      const { status, body } = await call();

      assert.equal(status, 401);
      assert.equal(body["success"], false);
      assert.equal(body["error"], "UNAUTHENTICATED");
    });

    it("rejects the wrong scheme and malformed headers", async () => {
      for (const header of ["Basic dXNlcjpwYXNz", "Digest abc", "Bearer", "Bearer a b", "abc"]) {
        const { status } = await call({ Authorization: header });
        assert.equal(status, 401, `"${header}" must be refused`);
      }
    });

    it("rejects an invalid signature", async () => {
      const { sessionId } = await login("admin");

      const forged = jwt.sign({ role: "super_admin", sid: sessionId }, "a-different-secret-1234567890123456", {
        algorithm: JWT_ALGORITHM,
        subject: "user-admin",
        expiresIn: 900,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      });

      const { status, body } = await call(withToken(forged));

      assert.equal(status, 401);
      assert.equal(body["error"], "UNAUTHENTICATED");
    });

    it("rejects an expired token with a DISTINGUISHABLE code", async () => {
      const { sessionId, userId } = await login("admin");

      const expired = jwt.sign({ role: "admin", sid: sessionId }, env.JWT_SECRET, {
        algorithm: JWT_ALGORITHM,
        subject: userId,
        expiresIn: -120,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      });

      const { status, body } = await call(withToken(expired));

      assert.equal(status, 401);
      // Distinguishable on purpose: tells the client to refresh.
      assert.equal(body["error"], "TOKEN_EXPIRED");
    });

    it("rejects an unsupported role even with a valid signature and session", async () => {
      const { sessionId, userId } = await login("student");

      for (const role of ["public", "root", "SUPER_ADMIN"]) {
        const token = jwt.sign({ role, sid: sessionId }, env.JWT_SECRET, {
          algorithm: JWT_ALGORITHM,
          subject: userId,
          expiresIn: 900,
          issuer: env.JWT_ISSUER,
          audience: env.JWT_AUDIENCE,
        });

        const { status, body } = await call(withToken(token));

        assert.equal(status, 401, `role "${role}" must be refused`);
        assert.equal(body["error"], "UNAUTHENTICATED");
      }
    });

    it("never reaches the session lookup for a bad token", async () => {
      // Proven by passing a resolver that would throw: a token-level
      // rejection must short-circuit before the repository is touched.
      const thrower = (): SessionRepository => {
        throw new Error("the repository must not be resolved");
      };

      const { status, body } = await call({ Authorization: "Bearer garbage" }, requireAuth, thrower);

      assert.equal(status, 401, "token check comes first");
      assert.equal(body["error"], "UNAUTHENTICATED");
    });
  });

  describe("identity cannot be asserted by the client", () => {
    it("ignores role and id headers entirely", async () => {
      const { status } = await call({
        "X-User-Role": "super_admin",
        "X-User-Id": "attacker",
        "X-Session-Id": "session-1",
      });

      assert.equal(status, 401, "headers must never establish identity");
    });

    it("ignores a role in the query string", async () => {
      const { status } = await call({}, requireAuth, () => h.sessions, "/protected?role=admin");

      assert.equal(status, 401);
    });

    it("uses the token's role, not a conflicting header", async () => {
      const { token } = await login("student");

      const { status, body } = await call(
        { ...withToken(token), "X-User-Role": "super_admin" },
        requireAdmin,
      );

      // The token says student; the header claims super_admin. Token wins.
      assert.equal(status, 403);
      assert.equal(body["error"], "INSUFFICIENT_ROLE");
    });
  });

  describe("fail-closed when the session store is unavailable", () => {
    it("returns 503 when no session adapter is registered", async () => {
      // The real production container registers nothing, so resolving throws.
      const production = createProductionContainer();
      const { token } = await login("admin");

      const { status, body } = await call(
        withToken(token),
        requireAuth,
        () => production.repositories.sessions,
      );

      assert.equal(status, 503, "must deny, never bypass session validation");
      assert.equal(body["error"], "SERVICE_UNAVAILABLE");
      assert.equal(body["success"], false);
    });

    it("returns 503 when the session lookup throws (store outage)", async () => {
      const broken: SessionRepository = {
        ...h.sessions,
        findBySessionId: async () => {
          throw new Error("connection reset");
        },
      } as unknown as SessionRepository;

      const { token } = await login("admin");
      const { status, body } = await call(withToken(token), requireAuth, () => broken);

      assert.equal(status, 503);
      assert.equal(body["error"], "SERVICE_UNAVAILABLE");
    });

    it("does not leak the underlying failure to the client", async () => {
      const broken: SessionRepository = {
        ...h.sessions,
        findBySessionId: async () => {
          throw new Error("Login failed for user 'sa' on server db-prod-01");
        },
      } as unknown as SessionRepository;

      const { token } = await login("admin");
      const { body } = await call(withToken(token), requireAuth, () => broken);

      const serialised = JSON.stringify(body);

      // Assert on distinctive markers. A short needle like "sa" is useless
      // here: the word "message" contains it, so such a check always fails.
      assert.equal(serialised.includes("db-prod-01"), false, "no host names");
      assert.equal(serialised.includes("Login failed"), false, "no driver text");
      assert.equal(serialised.includes("'sa'"), false, "no database account names");
      assert.equal(body["message"], "Authentication is temporarily unavailable");
    });

    it("still succeeds when only the activity write fails", async () => {
      // updateLastActiveAt is informational and must never fail a request.
      const flaky: SessionRepository = {
        ...h.sessions,
        findBySessionId: (id: string) => h.sessions.findBySessionId(id),
        updateLastActiveAt: async () => {
          throw new Error("write timeout");
        },
      } as unknown as SessionRepository;

      const { token } = await login("admin");
      const { status } = await call(withToken(token), requireAuth, () => flaky);

      assert.equal(status, 200, "a failed activity write must not deny the request");
    });
  });

  describe("integration with the Step 4 role guards", () => {
    it("admits a valid admin token with an active session through requireAdmin", async () => {
      const { token } = await login("admin");
      const { status, body } = await call(withToken(token), requireAdmin);

      assert.equal(status, 200);
      assert.equal(body["success"], true);
    });

    it("admits super_admin through the admin guard — inheritance preserved", async () => {
      const { token } = await login("super_admin");

      assert.equal((await call(withToken(token), requireAdmin)).status, 200);
    });

    it("refuses a student at the admin guard with 403, not 401", async () => {
      const { token } = await login("student");
      const { status, body } = await call(withToken(token), requireAdmin);

      // 401 would make the frontend interceptor treat it as a session
      // problem; a role mismatch must be 403.
      assert.equal(status, 403);
      assert.equal(body["error"], "INSUFFICIENT_ROLE");
    });

    it("refuses an admin at the super-admin guard — no upward inheritance", async () => {
      const { token } = await login("admin");
      const { status, body } = await call(withToken(token), requireSuperAdmin);

      assert.equal(status, 403);
      assert.equal(body["error"], "INSUFFICIENT_ROLE");
    });

    it("keeps each role on its own tier", async () => {
      const cases: [UserRole, RequestHandler, number][] = [
        ["student", requireStudent, 200],
        ["teacher", requireTeacher, 200],
        ["admin", requireStudent, 403],
        ["student", requireTeacher, 403],
        ["teacher", requireSuperAdmin, 403],
      ];

      for (const [role, guard, expected] of cases) {
        const { token } = await login(role);
        const { status } = await call(withToken(token), guard);

        assert.equal(status, expected, `${role} against its guard`);
      }
    });

    it("a revoked session is 401 even for a role the guard allows", async () => {
      // Authentication runs first: revocation beats authorization.
      const { token, sessionId, userId } = await login("super_admin");

      await h.sessions.revokeSession({ sessionId, userId, reason: "account_suspended" });

      const { status } = await call(withToken(token), requireSuperAdmin);
      assert.equal(status, 401, "not 403 — identity could not be established");
    });

    it("returns 401 (not 403) when authentication never ran successfully", async () => {
      const { status } = await call({}, requireAdmin);

      assert.equal(status, 401);
    });
  });

  describe("the real application is unaffected", () => {
    it("keeps the public health endpoint open", async () => {
      const server = await startServer(createApp());

      try {
        const res = await server.get("/api/v1/health");

        assert.equal(res.status, 200);
        assert.deepEqual(await json(res), {
          success: true,
          message: "NEXELVORIA Backend is running",
        });
      } finally {
        await server.close();
      }
    });

    it("serves health with a bogus token and with no session store", async () => {
      // `authenticate` is not mounted globally, so a public route cannot be
      // broken by an absent session adapter.
      const server = await startServer(createApp());

      try {
        const res = await server.get("/api/v1/health", {
          headers: { Authorization: "Bearer total-garbage" },
        });

        assert.equal(res.status, 200);
      } finally {
        await server.close();
      }
    });

    it("keeps unimplemented auth endpoints absent and student routes protected", async () => {
      const server = await startServer(createApp());

      try {
        for (const path of ["/api/v1/auth/login", "/api/v1/auth/me"]) {
          assert.equal((await server.get(path)).status, 404, `${path} must not exist yet`);
        }
        assert.equal((await server.get("/api/v1/students")).status, 401);
      } finally {
        await server.close();
      }
    });
  });

  describe("no sensitive information leaks", () => {
    it("never echoes the token or the secret in a failure body", async () => {
      const { token } = await login("admin");
      const { body } = await call({ Authorization: `Bearer ${token}tampered` });

      const serialised = JSON.stringify(body);

      assert.equal(serialised.includes(token), false, "token must not be echoed");
      assert.equal(serialised.includes(env.JWT_SECRET), false, "secret must not appear");
      assert.equal(serialised.includes("signature"), false, "no internal reason");
    });

    it("never exposes session state or ids in a failure body", async () => {
      const { token, sessionId, userId } = await login("admin");
      await h.sessions.revokeSession({ sessionId, userId, reason: "token_reuse_detected" });

      const { body } = await call(withToken(token));
      const serialised = JSON.stringify(body);

      assert.equal(serialised.includes(sessionId), false, "session id must not leak");
      assert.equal(serialised.includes("revoked"), false, "session state must not leak");
      assert.equal(serialised.includes("token_reuse_detected"), false);
    });

    it("never exposes a refresh token", async () => {
      const refresh = generateRefreshToken();
      const session = await h.sessions.create({
        userId: "user-1",
        refreshTokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });

      const { token } = issueAccessToken({
        userId: "user-1",
        role: "admin",
        sessionId: session.sessionId,
      });

      const { body } = await call(withToken(token));
      const serialised = JSON.stringify(body);

      assert.equal(serialised.includes(refresh.token), false);
      assert.equal(serialised.includes(refresh.tokenHash), false);
    });

    it("keeps the failure envelope to the standard fields", async () => {
      const { body } = await call();

      assert.deepEqual(
        Object.keys(body).sort(),
        ["error", "message", "requestId", "success"],
        "the 401 body must carry nothing extra",
      );
      assert.ok(body["requestId"], "still traceable to a log line");
    });

    it("does not reveal the role the endpoint required", async () => {
      const { token } = await login("student");
      const { body } = await call(withToken(token), requireSuperAdmin);

      assert.equal(JSON.stringify(body).includes("super_admin"), false);
    });
  });
});
