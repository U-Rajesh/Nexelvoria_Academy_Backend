import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Application } from "express";

import {
  MAX_PAGE,
  MAX_PAGE_SIZE,
  normalizePagination,
} from "../src/contracts/api.contract";
import type { AuthenticatedPrincipal } from "../src/contracts/user.contract";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { errorHandler } from "../src/middleware/error.middleware";
import { requestContext } from "../src/middleware/request-context.middleware";
import { requireAuth } from "../src/middleware/authorize.middleware";
import { createLoginService } from "../src/modules/auth/login.service";
import { hashPassword } from "../src/modules/auth/password.service";
import { createRefreshService } from "../src/modules/auth/refresh.service";
import type { SessionRepository } from "../src/modules/auth/session.repository";
import {
  createSessionService,
  type SessionService,
} from "../src/modules/auth/session.service";
import { toSessionView } from "../src/modules/auth/session.types";
import { hashRefreshToken } from "../src/modules/auth/token.service";
import { describeError } from "../src/utils/redact";
import type { User } from "../src/modules/users/user.types";
import { sendSuccess } from "../src/utils/send";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer } from "./helpers/server";

/**
 * Session management service tests.
 *
 * Sessions are opened through the REAL login service and exercised with the
 * REAL refresh service and authenticate middleware, so the lifecycle
 * assertions (logout really does stop a refresh and an access token) hold
 * end to end rather than against a mock.
 */

const PASSWORD = "Password@123";
const THRESHOLD = 5;

let passwordHash: string;

const userFixture = (overrides: Partial<User> = {}): User => ({
  id: "user-1",
  name: "Ananya Rao",
  email: "ananya@test.local",
  mobile: "9876543210",
  role: "student",
  status: "active",
  createdAt: new Date().toISOString(),
  ...overrides,
});

/** Returns `base` with some methods replaced, preserving `this` binding. */
const withOverrides = <T extends object>(base: T, overrides: Partial<T>): T =>
  new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop in overrides) {
        return overrides[prop as keyof T];
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });

describe("session management service", () => {
  let h: TestHarness;
  let service: SessionService;

  before(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(() => {
    h = createTestHarness();
    service = createSessionService({ sessions: h.sessions });
  });

  const serviceWith = (sessions: SessionRepository): SessionService =>
    createSessionService({ sessions });

  interface Signed {
    user: User;
    principal: AuthenticatedPrincipal;
    accessToken: string;
    refreshToken: string;
  }

  /** Signs a user in for real and returns their principal and tokens. */
  const signIn = async (
    overrides: Partial<User> = {},
    device = "Windows Desktop",
  ): Promise<Signed> => {
    const existing = await h.users.findById(overrides.id ?? "user-1");
    const user = existing ?? h.users.seed(userFixture(overrides));

    if (existing === null) {
      await h.credentials.create({ userId: user.id, passwordHash });
    }

    const login = await createLoginService({
      users: h.users,
      credentials: h.credentials,
      sessions: h.sessions,
      maxFailedLoginAttempts: THRESHOLD,
    }).login(
      { identifier: user.email, password: PASSWORD },
      // A realistic client context, so the projection test exercises the
      // optional metadata fields rather than only the mandatory ones.
      { device, ipAddress: "203.0.113.10" },
    );

    assert.equal(login.outcome, "success", "fixture login must succeed");
    if (login.outcome !== "success") throw new Error("unreachable");

    return {
      user,
      principal: {
        id: user.id,
        role: user.role,
        sessionId: login.data.sessionId,
      },
      accessToken: login.data.accessToken,
      refreshToken: login.data.refreshToken,
    };
  };

  /** Builds an app whose protected route requires a live session. */
  const protectedApp = (): Application => {
    const app = express();
    app.use(requestContext);

    app.get(
      "/protected",
      createAuthenticate({ sessions: () => h.sessions, studentAccess: null }),
      requireAuth,
      (_req, res) => sendSuccess(res, { message: "ok" }),
    );

    app.use(errorHandler);
    return app;
  };

  /** Calls the protected route with a bearer token. */
  const callProtected = async (accessToken: string): Promise<number> => {
    const server = await startServer(protectedApp());

    try {
      const res = await server.get("/protected", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      return res.status;
    } finally {
      await server.close();
    }
  };

  describe("logout current session", () => {
    it("revokes the session the caller is using", async () => {
      const { principal, user } = await signIn();

      const result = await service.logout(principal);

      assert.equal(result.outcome, "success");

      const session = await h.sessions.findBySessionId(principal.sessionId);
      assert.ok(session?.revokedAt);
      assert.equal(session?.revocationReason, "logout");
      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });

    it("is idempotent — logging out twice still succeeds", async () => {
      const { principal } = await signIn();

      const first = await service.logout(principal);
      const second = await service.logout(principal);

      assert.equal(first.outcome, "success", "first logout");
      assert.equal(
        second.outcome,
        "success",
        "a second logout is not an error - the end state is the same",
      );

      // The original reason survives - a later logout must not overwrite it.
      const session = await h.sessions.findBySessionId(principal.sessionId);
      assert.equal(session?.revocationReason, "logout");
    });

    it("needs no refresh token and returns no tokens", async () => {
      const { principal } = await signIn();

      const result = await service.logout(principal);
      const serialised = JSON.stringify(result);

      assert.equal(serialised.includes("accessToken"), false);
      assert.equal(serialised.includes("refreshToken"), false);
      assert.deepEqual(Object.keys(result).sort(), ["outcome"]);
    });

    it("refuses when the principal's session does not exist", async () => {
      const { user } = await signIn();

      const result = await service.logout({
        id: user.id,
        role: user.role,
        sessionId: "session-does-not-exist",
      });

      assert.equal(result.outcome, "not_found");
    });
  });

  describe("logout stops further use of the session", () => {
    it("makes a refresh fail afterwards", async () => {
      const { principal, refreshToken } = await signIn();
      const refresh = createRefreshService({ users: h.users, sessions: h.sessions });

      // It works before logout.
      const before = await refresh.refresh(refreshToken);
      assert.equal(before.outcome, "success");
      if (before.outcome !== "success") return;

      await service.logout(principal);

      const after = await refresh.refresh(before.data.refreshToken);
      assert.equal(after.outcome, "failure", "a revoked session cannot be refreshed");
      if (after.outcome === "failure") {
        assert.equal(after.reason, "invalid_refresh_token");
      }
    });

    it("makes the access token rejected afterwards", async () => {
      const { principal, accessToken } = await signIn();

      assert.equal(await callProtected(accessToken), 200, "accepted before logout");

      await service.logout(principal);

      assert.equal(
        await callProtected(accessToken),
        401,
        "the same cryptographically valid token is refused once the session is gone",
      );
    });

    it("completes the whole lifecycle: login -> refresh -> logout -> refresh rejected", async () => {
      const { principal, refreshToken, accessToken } = await signIn();
      const refresh = createRefreshService({ users: h.users, sessions: h.sessions });

      assert.equal(await callProtected(accessToken), 200);

      const rotated = await refresh.refresh(refreshToken);
      assert.equal(rotated.outcome, "success");
      if (rotated.outcome !== "success") return;

      const logout = await service.logout(principal);
      assert.equal(logout.outcome, "success");

      const afterLogout = await refresh.refresh(rotated.data.refreshToken);
      assert.equal(afterLogout.outcome, "failure");

      assert.equal(
        await callProtected(rotated.data.accessToken),
        401,
        "and the refreshed access token is dead too",
      );
    });
  });

  describe("logout everywhere", () => {
    it("revokes every session, including the current one", async () => {
      const first = await signIn({}, "Desktop");
      await signIn({}, "Phone");
      await signIn({}, "Tablet");

      assert.equal((await h.sessions.listSessionsForUser(first.user.id)).length, 3);

      const result = await service.logoutEverywhere(first.principal);

      assert.equal(result.outcome, "success");
      if (result.outcome !== "success") return;

      assert.equal(result.summary.sessionsRevoked, 3);
      // No observation was taken on the clean path, so none is reported.
      assert.equal(result.summary.activeWhenLastChecked, "not_checked");

      assert.deepEqual(
        await h.sessions.listSessionsForUser(first.user.id),
        [],
        "the current session is included",
      );

      const current = await h.sessions.findBySessionId(first.principal.sessionId);
      assert.ok(current?.revokedAt);
      assert.equal(current?.revocationReason, "logout_all");
    });

    it("leaves other users untouched", async () => {
      const mine = await signIn();

      const other = h.users.seed(
        userFixture({ id: "user-2", email: "other@test.local", mobile: "9000000002" }),
      );
      await h.credentials.create({ userId: other.id, passwordHash });

      const otherLogin = await createLoginService({
        users: h.users,
        credentials: h.credentials,
        sessions: h.sessions,
        maxFailedLoginAttempts: THRESHOLD,
      }).login({ identifier: other.email, password: PASSWORD });

      assert.equal(otherLogin.outcome, "success");

      await service.logoutEverywhere(mine.principal);

      assert.deepEqual(await h.sessions.listSessionsForUser(mine.user.id), []);
      assert.equal(
        (await h.sessions.listSessionsForUser(other.id)).length,
        1,
        "another user's session must survive",
      );
    });

    it("succeeds with zero sessions to revoke", async () => {
      const { principal, user } = await signIn();
      await service.logout(principal);

      const result = await service.logoutEverywhere(principal);

      assert.equal(result.outcome, "success");
      if (result.outcome === "success") {
        assert.equal(result.summary.sessionsRevoked, 0);
      }

      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });
  });

  describe("list my sessions", () => {
    it("returns the caller's sessions with safe metadata only", async () => {
      const { principal } = await signIn({}, "Windows Desktop");

      const result = await service.listMySessions(principal);
      assert.equal(result.outcome, "success");
      if (result.outcome !== "success") return;

      const [view] = result.data.items;
      assert.ok(view);

      assert.deepEqual(
        Object.keys(view).sort(),
        ["createdAt", "device", "id", "ipAddress", "isCurrent", "lastActiveAt"],
        "only safe metadata is projected",
      );
      assert.equal(view.device, "Windows Desktop");
    });

    it("NEVER exposes a refresh token hash or the rotation family", async () => {
      const { principal } = await signIn();

      const stored = await h.sessions.findBySessionId(principal.sessionId);
      assert.ok(stored?.refreshTokenHash, "the row really does hold a hash");

      const result = await service.listMySessions(principal);
      if (result.outcome !== "success") assert.fail("expected success");

      const serialised = JSON.stringify(result.data);

      assert.equal(serialised.includes(stored.refreshTokenHash), false, "no hash");
      assert.equal(serialised.includes("refreshTokenHash"), false);
      assert.equal(serialised.includes("familyId"), false, "no internal rotation detail");
      // A VALUE check on familyId would be meaningless here: a root session
      // starts a family named after itself, so familyId === sessionId, and
      // the session id is legitimately exposed as `id`. The absence of the
      // KEY is what matters.
      assert.equal(stored.familyId, stored.sessionId, "root session: family is its own id");
    });

    it("exposes no consumed refresh tokens", async () => {
      const { principal, refreshToken } = await signIn();
      const refresh = createRefreshService({ users: h.users, sessions: h.sessions });

      const rotated = await refresh.refresh(refreshToken);
      assert.equal(rotated.outcome, "success");
      if (rotated.outcome !== "success") return;

      const result = await service.listMySessions(principal);
      if (result.outcome !== "success") assert.fail("expected success");

      const serialised = JSON.stringify(result.data);

      assert.equal(serialised.includes(hashRefreshToken(refreshToken)), false, "no consumed hash");
      assert.equal(serialised.includes(refreshToken), false);
      assert.equal(serialised.includes(rotated.data.refreshToken), false);
    });

    it("exposes no credential material", async () => {
      const { principal } = await signIn();

      const result = await service.listMySessions(principal);
      if (result.outcome !== "success") assert.fail("expected success");

      const serialised = JSON.stringify(result.data);

      assert.equal(serialised.includes(passwordHash), false);
      assert.equal(serialised.includes("argon2"), false);
      assert.equal(serialised.includes("password"), false);
    });

    it("marks exactly one session as current", async () => {
      const first = await signIn({}, "Desktop");
      await signIn({}, "Phone");
      await signIn({}, "Tablet");

      const result = await service.listMySessions(first.principal);
      if (result.outcome !== "success") assert.fail("expected success");

      const current = result.data.items.filter((s) => s.isCurrent);

      assert.equal(current.length, 1, "exactly one");
      assert.equal(current[0]?.id, first.principal.sessionId);
      assert.equal(result.data.items.length, 3);
    });

    it("lists only the caller's own sessions", async () => {
      const mine = await signIn();

      const other = h.users.seed(
        userFixture({ id: "user-2", email: "other@test.local", mobile: "9000000002" }),
      );
      await h.credentials.create({ userId: other.id, passwordHash });
      await createLoginService({
        users: h.users,
        credentials: h.credentials,
        sessions: h.sessions,
        maxFailedLoginAttempts: THRESHOLD,
      }).login({ identifier: other.email, password: PASSWORD });

      const result = await service.listMySessions(mine.principal);
      if (result.outcome !== "success") assert.fail("expected success");

      assert.equal(result.data.total, 1);
      assert.equal(result.data.items[0]?.id, mine.principal.sessionId);
    });

    it("uses the existing pagination contract", async () => {
      const first = await signIn({}, "D1");
      await signIn({}, "D2");
      await signIn({}, "D3");

      const page1 = await service.listMySessions(first.principal, { page: 1, pageSize: 2 });
      if (page1.outcome !== "success") assert.fail("expected success");

      assert.deepEqual(Object.keys(page1.data).sort(), [
        "items",
        "page",
        "pageSize",
        "total",
        "totalPages",
      ]);
      assert.equal(page1.data.items.length, 2);
      assert.equal(page1.data.total, 3);
      assert.equal(page1.data.totalPages, 2);

      const page2 = await service.listMySessions(first.principal, { page: 2, pageSize: 2 });
      if (page2.outcome !== "success") assert.fail("expected success");

      assert.equal(page2.data.items.length, 1, "last page is partial");
    });

    it("excludes revoked sessions", async () => {
      const first = await signIn({}, "Desktop");
      const second = await signIn({}, "Phone");

      await service.terminateSession(first.principal, second.principal.sessionId);

      const result = await service.listMySessions(first.principal);
      if (result.outcome !== "success") assert.fail("expected success");

      assert.equal(result.data.total, 1);
      assert.equal(result.data.items[0]?.isCurrent, true);
    });
  });

  describe("terminate one session", () => {
    it("revokes another of the caller's own sessions", async () => {
      const current = await signIn({}, "Desktop");
      const other = await signIn({}, "Phone");

      const result = await service.terminateSession(
        current.principal,
        other.principal.sessionId,
      );

      assert.equal(result.outcome, "success");

      const terminated = await h.sessions.findBySessionId(other.principal.sessionId);
      assert.ok(terminated?.revokedAt);
      assert.equal(terminated?.revocationReason, "logout");

      // The caller's own session is untouched.
      const mine = await h.sessions.findBySessionId(current.principal.sessionId);
      assert.equal(mine?.revokedAt, undefined);
    });

    it("permits terminating the current session", async () => {
      const { principal } = await signIn();

      const result = await service.terminateSession(principal, principal.sessionId);

      assert.equal(result.outcome, "success");
      assert.ok((await h.sessions.findBySessionId(principal.sessionId))?.revokedAt);
    });

    it("REFUSES to terminate another user's session, revealing nothing", async () => {
      const mine = await signIn();

      const other = h.users.seed(
        userFixture({ id: "user-2", email: "other@test.local", mobile: "9000000002" }),
      );
      await h.credentials.create({ userId: other.id, passwordHash });

      const otherLogin = await createLoginService({
        users: h.users,
        credentials: h.credentials,
        sessions: h.sessions,
        maxFailedLoginAttempts: THRESHOLD,
      }).login({ identifier: other.email, password: PASSWORD });

      assert.equal(otherLogin.outcome, "success");
      if (otherLogin.outcome !== "success") return;

      const result = await service.terminateSession(
        mine.principal,
        otherLogin.data.sessionId,
      );

      // Indistinguishable from a session that does not exist.
      assert.equal(result.outcome, "not_found");

      const victim = await h.sessions.findBySessionId(otherLogin.data.sessionId);
      assert.equal(victim?.revokedAt, undefined, "the victim's session is untouched");
    });

    it("reports a missing session identically to a foreign one", async () => {
      const { principal } = await signIn();

      const missing = await service.terminateSession(principal, "session-nope");

      assert.deepEqual(
        missing,
        { outcome: "not_found" },
        "no field distinguishes missing from foreign",
      );
    });

    it("handles an already-revoked session consistently", async () => {
      const current = await signIn({}, "Desktop");
      const other = await signIn({}, "Phone");

      await service.terminateSession(current.principal, other.principal.sessionId);
      const second = await service.terminateSession(current.principal, other.principal.sessionId);

      assert.equal(
        second.outcome,
        "success",
        "terminating an already-revoked session is not an error",
      );
    });

    it("rejects a malformed session id without touching the repository", async () => {
      const { principal } = await signIn();

      let writes = 0;
      const counting = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: async (input) => {
          writes += 1;
          return h.sessions.revokeSession(input);
        },
      });

      for (const bad of [undefined, null, "", "   ", 42, {}, []]) {
        const result = await serviceWith(counting).terminateSession(principal, bad);
        assert.equal(result.outcome, "not_found", `${String(bad)} must be refused`);
      }

      assert.equal(writes, 0, "a malformed id costs no write");
    });

    it("never uses a client-supplied user id", async () => {
      // Even if a caller could smuggle a user id alongside the session id,
      // the service reads the owner from the principal only.
      const mine = await signIn();

      const other = h.users.seed(
        userFixture({ id: "user-2", email: "other@test.local", mobile: "9000000002" }),
      );
      await h.credentials.create({ userId: other.id, passwordHash });
      const otherLogin = await createLoginService({
        users: h.users,
        credentials: h.credentials,
        sessions: h.sessions,
        maxFailedLoginAttempts: THRESHOLD,
      }).login({ identifier: other.email, password: PASSWORD });

      if (otherLogin.outcome !== "success") assert.fail("fixture login failed");

      const result = await service.terminateSession(
        // A forged principal is impossible in production - `authenticate`
        // builds it from a verified token - but the repository would refuse
        // anyway, because the session does not belong to this user.
        { ...mine.principal, id: mine.user.id },
        otherLogin.data.sessionId,
      );

      assert.equal(result.outcome, "not_found");
    });
  });

  describe("failure handling", () => {
    it("reports unavailable when the revoke write keeps failing", async () => {
      const { principal } = await signIn();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: () => {
          throw new Error("connection reset");
        },
        findBySessionId: () => {
          throw new Error("connection reset");
        },
      });

      const result = await serviceWith(broken).logout(principal);

      assert.equal(result.outcome, "unavailable", "no false success");

      // And it really is still active - the test asserts the truth rather
      // than a revocation that never happened.
      assert.equal(
        (await h.sessions.findBySessionId(principal.sessionId))?.revokedAt,
        undefined,
      );
    });

    it("reports success when the write errored but actually landed", async () => {
      const { principal } = await signIn();

      const lying = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: async (input) => {
          const revoked = await h.sessions.revokeSession(input);
          void revoked;
          throw new Error("ETIMEDOUT");
        },
      });

      const result = await serviceWith(lying).logout(principal);

      assert.equal(result.outcome, "success", "confirmed by reading, not assumed");
      assert.ok((await h.sessions.findBySessionId(principal.sessionId))?.revokedAt);
    });

    it("retries once before giving up", async () => {
      const { principal } = await signIn();

      let attempts = 0;
      const flaky = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: async (input) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("transient");
          }
          return h.sessions.revokeSession(input);
        },
        findBySessionId: () => {
          throw new Error("cannot confirm");
        },
      });

      const result = await serviceWith(flaky).logout(principal);

      assert.equal(attempts, 2, "revocation is idempotent, so a retry is safe");
      assert.equal(result.outcome, "success");
    });

    it("reports unavailable when the session lookup for listing fails", async () => {
      const { principal } = await signIn();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        listSessionsForUser: () => {
          throw new Error("connection reset");
        },
      });

      const result = await serviceWith(broken).listMySessions(principal);

      assert.equal(result.outcome, "unavailable");
    });

    it("reports INCOMPLETE when logout-everywhere leaves sessions active", async () => {
      // The repository does not promise an atomic multi-row revocation, so
      // the service establishes what is actually left rather than claiming
      // success.
      const first = await signIn({}, "Desktop");
      await signIn({}, "Phone");

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeAllForUser: () => {
          throw new Error("connection reset");
        },
      });

      const result = await serviceWith(broken).logoutEverywhere(first.principal);

      assert.equal(result.outcome, "incomplete", "not reported as success");
      if (result.outcome !== "incomplete") return;

      assert.equal(result.summary.sessionsRevoked, "unknown");
      assert.equal(result.summary.activeWhenLastChecked, 2);

      // Honest assertion: they really are still usable.
      assert.equal((await h.sessions.listSessionsForUser(first.user.id)).length, 2);
    });

    it("reports success for logout-everywhere when it errored but all were revoked", async () => {
      const first = await signIn({}, "Desktop");
      await signIn({}, "Phone");

      const lying = withOverrides<SessionRepository>(h.sessions, {
        revokeAllForUser: async (input) => {
          const count = await h.sessions.revokeAllForUser(input);
          void count;
          throw new Error("ETIMEDOUT");
        },
      });

      const result = await serviceWith(lying).logoutEverywhere(first.principal);

      assert.equal(result.outcome, "success");
      if (result.outcome === "success") {
        assert.equal(result.summary.sessionsRevoked, "unknown", "the count is not known");
        assert.equal(
          result.summary.activeWhenLastChecked,
          0,
          "but an observation confirmed none remained at that moment",
        );
      }
    });

    it("reports unavailable when the outcome cannot be established at all", async () => {
      const { principal } = await signIn();

      const dead = withOverrides<SessionRepository>(h.sessions, {
        revokeAllForUser: () => {
          throw new Error("connection reset");
        },
        listSessionsForUser: () => {
          throw new Error("connection reset");
        },
      });

      const result = await serviceWith(dead).logoutEverywhere(principal);

      assert.equal(result.outcome, "unavailable");
    });
  });

  describe("no sensitive information leaks", () => {
    it("every failure shape is minimal", async () => {
      const { principal } = await signIn();

      const notFound = await service.terminateSession(principal, "session-nope");
      assert.deepEqual(Object.keys(notFound).sort(), ["outcome"]);

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: () => {
          throw new Error("secret internal detail at db-prod-01");
        },
        findBySessionId: () => {
          throw new Error("secret internal detail at db-prod-01");
        },
      });

      const unavailable = await serviceWith(broken).logout(principal);

      assert.deepEqual(Object.keys(unavailable).sort(), ["outcome"]);
      assert.equal(JSON.stringify(unavailable).includes("db-prod-01"), false);
    });

    it("the list result carries nothing beyond the paginated view", async () => {
      const { principal } = await signIn();

      const result = await service.listMySessions(principal);
      if (result.outcome !== "success") assert.fail("expected success");

      assert.deepEqual(Object.keys(result).sort(), ["data", "outcome"]);
    });
  });
  // =========================================================================
  // Step 6J final corrections
  // =========================================================================

  describe("pagination is normalised safely", () => {
    it("never produces NaN for a non-numeric page size", async () => {
      // The defect: Math.trunc(NaN) is NaN and Math.max(1, NaN) is NaN, so
      // the response carried pageSize: NaN and totalPages: NaN - which
      // serialise to null.
      const { principal } = await signIn();

      const result = await service.listMySessions(principal, {
        page: Number.NaN,
        pageSize: Number.NaN,
      });

      if (result.outcome !== "success") assert.fail("expected success");

      assert.equal(result.data.page, 1);
      assert.equal(result.data.pageSize, 10, "falls back to the contract default");
      assert.equal(Number.isNaN(result.data.totalPages), false);
      assert.equal(JSON.stringify(result.data).includes("null"), false, "nothing serialises to null");
    });

    it("treats both infinities as invalid and falls back to the defaults", async () => {
      // `Number.isFinite(Infinity)` is false, so an infinity is rejected as
      // non-numeric rather than clamped to the maximum. That is the safer
      // reading: "pageSize: Infinity" is garbage, not a request for the
      // largest allowed page, so it must not yield 100 rows.
      const { principal } = await signIn();

      for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const result = await service.listMySessions(principal, {
          page: value,
          pageSize: value,
        });

        if (result.outcome !== "success") assert.fail("expected success");

        assert.equal(result.data.page, 1, `page for ${String(value)}`);
        assert.equal(result.data.pageSize, 10, `pageSize for ${String(value)}`);
      }

      // Large FINITE values are clamped rather than rejected.
      const finite = await service.listMySessions(principal, {
        page: 5_000_000,
        pageSize: 5_000,
      });
      if (finite.outcome !== "success") assert.fail("expected success");

      assert.equal(finite.data.page, MAX_PAGE);
      assert.equal(finite.data.pageSize, MAX_PAGE_SIZE);
    });

    it("clamps zero, negatives and fractions", async () => {
      const { principal } = await signIn();

      const cases: [Partial<{ page: number; pageSize: number }>, number, number][] = [
        [{ page: 0, pageSize: 0 }, 1, 1],
        [{ page: -5, pageSize: -5 }, 1, 1],
        [{ page: 2.7, pageSize: 3.9 }, 2, 3],
        [{ page: 1.0001, pageSize: 10.999 }, 1, 10],
      ];

      for (const [input, expectedPage, expectedSize] of cases) {
        const result = await service.listMySessions(principal, input);
        if (result.outcome !== "success") assert.fail("expected success");

        assert.equal(result.data.page, expectedPage, JSON.stringify(input));
        assert.equal(result.data.pageSize, expectedSize, JSON.stringify(input));
      }
    });

    it("caps an excessive page size at the shared contract maximum", async () => {
      const { principal } = await signIn();

      const result = await service.listMySessions(principal, { pageSize: 9999 });
      if (result.outcome !== "success") assert.fail("expected success");

      assert.equal(result.data.pageSize, MAX_PAGE_SIZE, "uses the existing shared bound");
    });

    it("keeps the offset inside the safe-integer range for absurd pages", async () => {
      const { principal } = await signIn();

      const result = await service.listMySessions(principal, {
        page: 1e18,
        pageSize: 1e18,
      });
      if (result.outcome !== "success") assert.fail("expected success");

      assert.equal(result.data.page, MAX_PAGE);
      assert.equal(result.data.pageSize, MAX_PAGE_SIZE);

      // The computed offset must stay exact, or slicing silently misbehaves.
      const offset = (result.data.page - 1) * result.data.pageSize;
      assert.ok(Number.isSafeInteger(offset), "offset must be a safe integer");
      assert.ok(Number.isSafeInteger(result.data.totalPages));
    });

    it("preserves the established response shape", async () => {
      const { principal } = await signIn();

      const result = await service.listMySessions(principal, { page: Number.NaN });
      if (result.outcome !== "success") assert.fail("expected success");

      assert.deepEqual(Object.keys(result.data).sort(), [
        "items",
        "page",
        "pageSize",
        "total",
        "totalPages",
      ]);
    });

    it("normalizePagination is total over hostile input", () => {
      // Direct unit coverage of the shared helper, including values the
      // types forbid but a JavaScript caller could still pass.
      const hostile: unknown[] = [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        0,
        -1,
        2.5,
        1e308,
        "10",
        null,
        undefined,
        {},
        [],
      ];

      for (const value of hostile) {
        const result = normalizePagination({
          page: value as number,
          pageSize: value as number,
        });

        assert.ok(Number.isSafeInteger(result.page), `page for ${String(value)}`);
        assert.ok(Number.isSafeInteger(result.pageSize), `pageSize for ${String(value)}`);
        assert.ok(result.page >= 1 && result.page <= MAX_PAGE);
        assert.ok(result.pageSize >= 1 && result.pageSize <= MAX_PAGE_SIZE);
      }
    });
  });

  describe("logout-everywhere concurrency boundary", () => {
    it("reports not_checked rather than claiming zero sessions remain", async () => {
      // The clean path takes no extra read, so it must not assert anything
      // about the CURRENT state - only about what it revoked.
      const { principal } = await signIn();

      const result = await service.logoutEverywhere(principal);

      assert.equal(result.outcome, "success");
      if (result.outcome !== "success") return;

      assert.equal(result.summary.sessionsRevoked, 1);
      assert.equal(
        result.summary.activeWhenLastChecked,
        "not_checked",
        "no observation was made, so none is reported",
      );
    });

    it("does NOT prevent a concurrent login from creating a new session", async () => {
      // THE CONCURRENCY BOUNDARY. `revokeAllForUser` revokes what was active
      // when it ran; it is not a barrier. A login landing immediately after
      // produces a valid session, and `success` must not be read as "this
      // user now has no sessions".
      const first = await signIn({}, "Desktop");

      const racing = withOverrides<SessionRepository>(h.sessions, {
        revokeAllForUser: async (input) => {
          const count = await h.sessions.revokeAllForUser(input);

          // ...a concurrent login completes here.
          await h.sessions.create({
            userId: first.user.id,
            refreshTokenHash: hashRefreshToken("N".repeat(43)),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            device: "Attacker or second tab",
          });

          return count;
        },
      });

      const result = await serviceWith(racing).logoutEverywhere(first.principal);

      assert.equal(result.outcome, "success", "it did revoke everything that was active");

      // And yet a session is live, which is exactly why the summary says
      // "not_checked" instead of claiming zero.
      const stillActive = await h.sessions.listSessionsForUser(first.user.id);
      assert.equal(
        stillActive.length,
        1,
        "a session created after the sweep survives - documented limitation",
      );
    });

    it("reports an observed count only when it actually looked", async () => {
      const first = await signIn({}, "Desktop");
      await signIn({}, "Phone");

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeAllForUser: () => {
          throw new Error("connection reset");
        },
      });

      const result = await serviceWith(broken).logoutEverywhere(first.principal);

      assert.equal(result.outcome, "incomplete");
      if (result.outcome !== "incomplete") return;

      assert.equal(result.summary.sessionsRevoked, "unknown");
      assert.equal(result.summary.activeWhenLastChecked, 2, "an observation WAS made");
    });
  });

  describe("error logging never carries driver text", () => {
    /** Captures what the logger was asked to write. */
    const captureLogs = (): { lines: string[]; restore: () => void } => {
      const lines: string[] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalLog = console.log;

      const capture = (...args: unknown[]): void => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };

      console.error = capture;
      console.warn = capture;
      console.log = capture;

      return {
        lines,
        restore: () => {
          console.error = originalError;
          console.warn = originalWarn;
          console.log = originalLog;
        },
      };
    };

    /** A driver-style exception stuffed with secrets. */
    const SENSITIVE =
      "Login failed for user 'sa' with password 'P@ssw0rd!' on server " +
      "db-prod-01.internal:1433 (connection string " +
      "Server=db-prod-01;User Id=sa;Password=P@ssw0rd!;)";

    const SECRETS = ["sa", "P@ssw0rd!", "db-prod-01", "1433", "Password="];

    it("logs no driver message when a revoke fails", async () => {
      const { principal } = await signIn();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: () => {
          throw new Error(SENSITIVE);
        },
        findBySessionId: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        const result = await serviceWith(broken).logout(principal);
        assert.equal(result.outcome, "unavailable");
      } finally {
        captured.restore();
      }

      const output = captured.lines.join("\n");

      for (const secret of SECRETS.filter((x) => x !== "sa")) {
        assert.equal(output.includes(secret), false, `logs must not contain ${secret}`);
      }

      assert.equal(output.includes("Login failed for user"), false, "no driver text at all");

      // The useful context is still there - and note which parts survive:
      // `redact()` strips any key matching /session/, so the session id is
      // itself replaced in logs. That is stricter than required and is left
      // as-is; `userId` and the error class carry the diagnosis.
      assert.ok(output.includes(principal.id), "the user id IS logged");
      assert.ok(output.includes("Error"), "the error CLASS is logged");
      assert.ok(output.includes("[REDACTED]"), "the session id is redacted by policy");
      assert.ok(output.includes("logout"), "the operation is identifiable");
    });

    it("logs no driver message when a bulk revoke fails", async () => {
      const { principal } = await signIn();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeAllForUser: () => {
          throw new Error(SENSITIVE);
        },
        listSessionsForUser: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        await serviceWith(broken).logoutEverywhere(principal);
      } finally {
        captured.restore();
      }

      const output = captured.lines.join("\n");

      assert.equal(output.includes("P@ssw0rd!"), false);
      assert.equal(output.includes("db-prod-01"), false);
      assert.equal(output.includes("Connection"), false);
    });

    it("logs no driver message when listing fails", async () => {
      const { principal } = await signIn();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        listSessionsForUser: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        await serviceWith(broken).listMySessions(principal);
      } finally {
        captured.restore();
      }

      const output = captured.lines.join("\n");

      assert.equal(output.includes("P@ssw0rd!"), false);
      assert.equal(output.includes("db-prod-01"), false);
    });

    it("describeError keeps the class and discards the message", () => {
      assert.equal(describeError(new Error(SENSITIVE)), "Error");
      assert.equal(describeError(new TypeError(SENSITIVE)), "TypeError");

      // A thrown non-Error is never stringified - it could be a credential.
      assert.equal(describeError(SENSITIVE), "string");
      assert.equal(describeError({ password: "secret" }), "UnknownObjectThrown");
      assert.equal(describeError(undefined), "undefined");
    });
  });

  describe("the session projection is a RUNTIME allowlist", () => {
    it("drops unexpected properties injected into a stored session", async () => {
      // The type alone proves nothing at runtime: a repository row with
      // extra columns, or an adapter that over-selects, would spread
      // straight through a naive projection.
      const { principal } = await signIn();

      const stored = await h.sessions.findBySessionId(principal.sessionId);
      assert.ok(stored);

      h.sessions.seed({
        ...stored,
        // Deliberately hostile extras, as a mis-mapped adapter might supply.
        refreshTokenHash: "HASH-MUST-NOT-LEAK",
        passwordHash: "$argon2id$MUST-NOT-LEAK",
        internalNote: "MUST-NOT-LEAK",
        connectionString: "Server=db-prod-01;Password=P@ssw0rd!;",
        __proto__banana: "MUST-NOT-LEAK",
      } as unknown as typeof stored);

      const result = await service.listMySessions(principal);
      if (result.outcome !== "success") assert.fail("expected success");

      const [view] = result.data.items;
      assert.ok(view);

      // Exactly the agreed keys, and nothing else.
      assert.deepEqual(
        Object.keys(view).sort(),
        ["createdAt", "device", "id", "ipAddress", "isCurrent", "lastActiveAt"],
      );

      const serialised = JSON.stringify(result.data);

      for (const leak of [
        "MUST-NOT-LEAK",
        "HASH-MUST-NOT-LEAK",
        "argon2",
        "connectionString",
        "internalNote",
        "passwordHash",
        "refreshTokenHash",
        "P@ssw0rd!",
      ]) {
        assert.equal(serialised.includes(leak), false, `${leak} must not appear`);
      }
    });

    it("builds the view by explicit assignment, never by spreading the row", async () => {
      const { principal } = await signIn();
      const stored = await h.sessions.findBySessionId(principal.sessionId);
      assert.ok(stored);

      const view = toSessionView(stored, principal.sessionId);

      // Every key is one we chose; the source has strictly more.
      const sourceKeys = new Set(Object.keys(stored));
      assert.ok(sourceKeys.has("refreshTokenHash"), "the source really does carry a hash");

      for (const key of Object.keys(view)) {
        assert.notEqual(key, "refreshTokenHash");
        assert.notEqual(key, "familyId");
        assert.notEqual(key, "userId", "the owner is implicit - it is always the caller");
      }
    });

    it("omits optional fields rather than emitting undefined", async () => {
      const { principal } = await signIn();
      const stored = await h.sessions.findBySessionId(principal.sessionId);
      assert.ok(stored);

      // A session with no client metadata at all.
      const bare = { ...stored };
      delete bare.device;
      delete bare.ipAddress;
      delete bare.browser;
      delete bare.os;
      delete bare.location;
      h.sessions.seed(bare);

      const view = toSessionView(bare, principal.sessionId);

      assert.deepEqual(Object.keys(view).sort(), ["createdAt", "id", "isCurrent", "lastActiveAt"]);
      assert.equal(JSON.stringify(view).includes("undefined"), false);
    });
  });
});
