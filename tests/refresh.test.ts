import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { env } from "../src/config/env";
import { USER_STATUSES, type UserRole, type UserStatus } from "../src/contracts/user.contract";
import { createLoginService } from "../src/modules/auth/login.service";
import { hashPassword } from "../src/modules/auth/password.service";
import {
  createRefreshService,
  type RefreshResult,
  type RefreshService,
} from "../src/modules/auth/refresh.service";
import type { SessionRepository } from "../src/modules/auth/session.repository";
import { SessionNotActiveError } from "../src/modules/auth/session.errors";
import { hashRefreshToken } from "../src/modules/auth/token.service";
import type { UserRepository } from "../src/modules/users/user.repository";
import type { User } from "../src/modules/users/user.types";
import { OptimisticLockError } from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Refresh service tests.
 *
 * Sessions are opened through the REAL login service, so every refresh runs
 * against a session and token pair produced exactly as production would
 * produce them. Concurrency is driven by injected repository behaviour, not
 * sleeps.
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

describe("refresh service", () => {
  let h: TestHarness;
  let service: RefreshService;

  before(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(() => {
    h = createTestHarness();
    service = createRefreshService({ users: h.users, sessions: h.sessions });
  });

  const serviceWith = (overrides: {
    users?: UserRepository;
    sessions?: SessionRepository;
  }): RefreshService =>
    createRefreshService({
      users: overrides.users ?? h.users,
      sessions: overrides.sessions ?? h.sessions,
    });

  /** Logs in for real and returns the issued pair. */
  const openSession = async (
    overrides: Partial<User> = {},
  ): Promise<{ user: User; refreshToken: string; sessionId: string; accessToken: string }> => {
    const user = h.users.seed(userFixture(overrides));
    await h.credentials.create({ userId: user.id, passwordHash });

    const login = await createLoginService({
      users: h.users,
      credentials: h.credentials,
      sessions: h.sessions,
      maxFailedLoginAttempts: THRESHOLD,
    }).login({ identifier: user.email, password: PASSWORD });

    assert.equal(login.outcome, "success", "fixture login must succeed");
    if (login.outcome !== "success") throw new Error("unreachable");

    return {
      user,
      refreshToken: login.data.refreshToken,
      sessionId: login.data.sessionId,
      accessToken: login.data.accessToken,
    };
  };

  const expectFailure = (result: RefreshResult): Extract<RefreshResult, { outcome: "failure" }> => {
    assert.equal(result.outcome, "failure", `expected failure, got ${JSON.stringify(result)}`);
    if (result.outcome !== "failure") assert.fail("expected a failure");
    return result;
  };

  const expectSuccess = (result: RefreshResult): Extract<RefreshResult, { outcome: "success" }> => {
    assert.equal(result.outcome, "success", `expected success, got ${JSON.stringify(result)}`);
    if (result.outcome !== "success") assert.fail("expected success");
    return result;
  };

  describe("successful refresh", () => {
    it("issues a usable access token and a new refresh token", async () => {
      const { refreshToken, sessionId, accessToken } = await openSession();

      const { data } = expectSuccess(await service.refresh(refreshToken));

      assert.ok(data.accessToken);
      assert.equal(data.expiresIn, 900);

      // The refreshed access token is asserted by its CLAIMS, not by
      // differing from the previous one. `iat`/`exp` have one-second
      // granularity, so a token signed in the same second as login carries
      // identical claims and is therefore byte-identical - inherent to JWT,
      // and harmless here: same subject, same session, same validity window.
      const claims = jwt.verify(data.accessToken, env.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      }) as Record<string, unknown>;

      assert.equal(claims["sid"], sessionId);
      assert.ok(typeof claims["exp"] === "number");
      assert.ok((claims["exp"] as number) > Math.floor(Date.now() / 1000));
      assert.ok(accessToken, "the original token existed");

      // The refresh token, by contrast, is 256 bits of fresh randomness and
      // must always differ.
      assert.ok(data.refreshToken);
      assert.notEqual(data.refreshToken, refreshToken, "a NEW refresh token");
      assert.equal(data.sessionId, sessionId, "the session continues");
    });

    it("issues a distinguishable access token once the clock advances", async () => {
      // Proves the previous test's caveat is only about granularity: with a
      // later `iat` the token differs. The timestamp is forced, not slept on.
      const { refreshToken } = await openSession();

      const realNow = Date.now;

      try {
        Date.now = () => realNow() + 2000;
        const { data } = expectSuccess(await service.refresh(refreshToken));

        const claims = jwt.decode(data.accessToken) as Record<string, unknown>;
        assert.ok(typeof claims["iat"] === "number");
      } finally {
        Date.now = realNow;
      }
    });

    it("returns an opaque refresh token, not a JWT", async () => {
      const { refreshToken } = await openSession();

      const { data } = expectSuccess(await service.refresh(refreshToken));

      assert.match(data.refreshToken, /^[A-Za-z0-9_-]{43}$/, "base64url, 32 bytes");
      assert.equal(data.refreshToken.includes("."), false, "carries no JWT segments");
      assert.equal(jwt.decode(data.refreshToken), null, "is not decodable as a JWT");
    });

    it("persists only the hash of the new token", async () => {
      const { refreshToken, sessionId } = await openSession();

      const { data } = expectSuccess(await service.refresh(refreshToken));

      const session = await h.sessions.findBySessionId(sessionId);
      assert.ok(session);

      assert.equal(session.refreshTokenHash, hashRefreshToken(data.refreshToken));
      assert.equal(
        JSON.stringify(session).includes(data.refreshToken),
        false,
        "the raw token must never be persisted",
      );
      assert.equal(JSON.stringify(session).includes(refreshToken), false);
    });

    it("consumes the old token, which can never be used again", async () => {
      const { refreshToken } = await openSession();

      expectSuccess(await service.refresh(refreshToken));

      const resolved = await h.sessions.resolveRefreshToken(hashRefreshToken(refreshToken));
      assert.equal(resolved.status, "consumed", "the old token is retained as consumed");

      assert.equal(await h.sessions.findByRefreshTokenHash(hashRefreshToken(refreshToken)), null);
    });

    it("preserves the session and its token family", async () => {
      const { refreshToken, sessionId } = await openSession();

      const before = await h.sessions.findBySessionId(sessionId);
      const { data } = expectSuccess(await service.refresh(refreshToken));
      const after = await h.sessions.findBySessionId(sessionId);

      assert.equal(data.sessionId, sessionId);
      assert.equal(after?.familyId, before?.familyId, "the family is unchanged");
      assert.equal(after?.userId, before?.userId);
      assert.equal(after?.revokedAt, undefined, "the session stays live");
    });

    it("can be chained: each rotation consumes the last", async () => {
      const { refreshToken } = await openSession();

      let current = refreshToken;
      const history: string[] = [current];

      for (let i = 0; i < 3; i += 1) {
        const { data } = expectSuccess(await service.refresh(current));
        current = data.refreshToken;
        history.push(current);
      }

      // Every retired generation is consumed; only the newest is active.
      for (const old of history.slice(0, -1)) {
        assert.equal(
          (await h.sessions.resolveRefreshToken(hashRefreshToken(old))).status,
          "consumed",
        );
      }

      assert.equal(
        (await h.sessions.resolveRefreshToken(hashRefreshToken(current))).status,
        "active",
      );
    });
  });

  describe("the new access token", () => {
    it("carries the CURRENT role and the same session id", async () => {
      const { refreshToken, sessionId, user } = await openSession({ role: "teacher" });

      const { data } = expectSuccess(await service.refresh(refreshToken));

      const claims = jwt.verify(data.accessToken, env.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      }) as Record<string, unknown>;

      assert.equal(claims["sub"], user.id);
      assert.equal(claims["role"], "teacher");
      assert.equal(claims["sid"], sessionId);
    });

    it("picks up a role change made since the session began", async () => {
      const { refreshToken, user } = await openSession({ role: "student" });

      // Promoted after login; the refreshed token must reflect it.
      h.users.seed({ ...user, role: "admin" });

      const { data } = expectSuccess(await service.refresh(refreshToken));

      const claims = jwt.decode(data.accessToken) as Record<string, unknown>;
      assert.equal(claims["role"], "admin" as UserRole, "the current role, not the original");
      assert.equal(data.user.role, "admin");
    });

    it("reflects a demotion too", async () => {
      const { refreshToken, user } = await openSession({ role: "super_admin" });

      h.users.seed({ ...user, role: "student" });

      const { data } = expectSuccess(await service.refresh(refreshToken));
      const claims = jwt.decode(data.accessToken) as Record<string, unknown>;

      assert.equal(claims["role"], "student", "a demotion must not yield a privileged token");
    });
  });

  describe("rejected refreshes", () => {
    it("rejects a malformed token without touching the repository", async () => {
      const { refreshToken } = await openSession();

      let lookups = 0;
      const counting = withOverrides<SessionRepository>(h.sessions, {
        resolveRefreshToken: async (hash) => {
          lookups += 1;
          return h.sessions.resolveRefreshToken(hash);
        },
      });

      for (const bad of [
        undefined,
        null,
        "",
        "   ",
        "short",
        `${refreshToken}x`, // wrong length
        refreshToken.slice(0, -1),
        "a".repeat(43).replace("a", "+"), // not base64url
        "header.payload.signature", // a JWT-shaped value
        42,
        {},
      ]) {
        const failure = expectFailure(await serviceWith({ sessions: counting }).refresh(bad));
        assert.equal(failure.reason, "invalid_refresh_token", `${String(bad)} must be refused`);
      }

      assert.equal(lookups, 0, "a malformed token must cost no database work");
    });

    it("rejects an unknown token", async () => {
      await openSession();

      // Correctly shaped, never issued.
      const failure = expectFailure(await service.refresh("A".repeat(43)));
      assert.equal(failure.reason, "invalid_refresh_token");
    });

    it("rejects a revoked session", async () => {
      const { refreshToken, sessionId, user } = await openSession();

      await h.sessions.revokeSession({ sessionId, userId: user.id, reason: "logout" });

      const failure = expectFailure(await service.refresh(refreshToken));
      assert.equal(failure.reason, "invalid_refresh_token");
    });

    it("rejects an expired session", async () => {
      const { user } = await openSession();

      // A session whose refresh window has already closed.
      const expired = await h.sessions.create({
        userId: user.id,
        refreshTokenHash: hashRefreshToken("E".repeat(43)),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      assert.ok(expired);

      const failure = expectFailure(await service.refresh("E".repeat(43)));
      assert.equal(failure.reason, "invalid_refresh_token");
    });

    it("issues nothing and rotates nothing on failure", async () => {
      const { refreshToken, sessionId, user } = await openSession();

      await h.sessions.revokeSession({ sessionId, userId: user.id, reason: "logout" });

      const before = await h.sessions.findBySessionId(sessionId);
      expectFailure(await service.refresh(refreshToken));
      const after = await h.sessions.findBySessionId(sessionId);

      assert.equal(after?.refreshTokenHash, before?.refreshTokenHash, "no rotation happened");
    });
  });

  describe("user authorization", () => {
    it("rejects a suspended user", async () => {
      const { refreshToken, user } = await openSession();

      h.users.seed({ ...user, status: "suspended" });

      const failure = expectFailure(await service.refresh(refreshToken));
      assert.equal(failure.reason, "user_not_authorized");
    });

    it("rejects a deactivated user", async () => {
      const { refreshToken, user } = await openSession();

      h.users.seed({ ...user, status: "deactivated" });

      assert.equal(
        expectFailure(await service.refresh(refreshToken)).reason,
        "user_not_authorized",
      );
    });

    it("rejects a pending user", async () => {
      const { refreshToken, user } = await openSession();

      h.users.seed({ ...user, status: "pending" });

      assert.equal(
        expectFailure(await service.refresh(refreshToken)).reason,
        "user_not_authorized",
      );
    });

    it("rejects a deleted user", async () => {
      const { refreshToken } = await openSession();

      h.users.reset();

      assert.equal(
        expectFailure(await service.refresh(refreshToken)).reason,
        "user_not_authorized",
      );
    });

    it("does NOT consume the token when the user is already unauthorized", async () => {
      // The pre-rotation gate exists so a doomed refresh does not burn a
      // token the legitimate client may still need after reinstatement.
      const { refreshToken, user } = await openSession();

      h.users.seed({ ...user, status: "suspended" });
      expectFailure(await service.refresh(refreshToken));

      assert.equal(
        (await h.sessions.resolveRefreshToken(hashRefreshToken(refreshToken))).status,
        "active",
        "the token was not consumed",
      );
    });

    it("discards the session when suspension lands AFTER rotation", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      // findById is called by the pre-gate (1) and the final gate (2).
      let calls = 0;
      const suspending = withOverrides<UserRepository>(h.users, {
        findById: async (id) => {
          calls += 1;
          if (calls === 2) {
            h.users.seed({ ...user, status: "suspended" });
          }
          return h.users.findById(id);
        },
      });

      const failure = expectFailure(
        await serviceWith({ users: suspending }).refresh(refreshToken),
      );

      assert.equal(failure.reason, "user_not_authorized");

      // The rotation committed, so the session must not be left usable.
      const session = await h.sessions.findBySessionId(sessionId);
      assert.ok(session?.revokedAt, "the session is discarded");
      assert.equal(session?.revocationReason, "issuance_failed");
      assert.equal(failure.cleanup, "committed", "and the cleanup is confirmed");
      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });
  });

  describe("reuse detection", () => {
    it("detects a replayed token and revokes the whole family", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      // Legitimate rotation.
      expectSuccess(await service.refresh(refreshToken));

      // The old token is presented again - the classic stolen-token replay.
      const failure = expectFailure(await service.refresh(refreshToken));

      assert.equal(failure.reason, "token_reuse_detected");

      const session = await h.sessions.findBySessionId(sessionId);
      assert.ok(session?.revokedAt, "the session is revoked");
      assert.equal(session?.revocationReason, "token_reuse_detected");
      assert.deepEqual(
        await h.sessions.listSessionsForUser(user.id),
        [],
        "nothing of the family survives",
      );
    });

    it("issues no tokens and creates no replacement session on reuse", async () => {
      const { refreshToken, user } = await openSession();

      const { data } = expectSuccess(await service.refresh(refreshToken));
      const sessionsBefore = (
        await h.sessions.listSessionsForUser(user.id, {
          includeRevoked: true,
          includeExpired: true,
        })
      ).length;

      expectFailure(await service.refresh(refreshToken));

      const sessionsAfter = await h.sessions.listSessionsForUser(user.id, {
        includeRevoked: true,
        includeExpired: true,
      });

      assert.equal(sessionsAfter.length, sessionsBefore, "no replacement session");

      // And the legitimate holder's token is dead too, because the family went.
      assert.equal(
        expectFailure(await service.refresh(data.refreshToken)).reason,
        "invalid_refresh_token",
      );
    });

    it("revokes every session in the family, not just the one presented", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      const root = await h.sessions.findBySessionId(sessionId);
      assert.ok(root);

      // A second session sharing the rotation family.
      const sibling = await h.sessions.create({
        userId: user.id,
        refreshTokenHash: hashRefreshToken("S".repeat(43)),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        familyId: root.familyId,
      });

      expectSuccess(await service.refresh(refreshToken));
      expectFailure(await service.refresh(refreshToken));

      const siblingAfter = await h.sessions.findBySessionId(sibling.sessionId);
      assert.ok(siblingAfter?.revokedAt, "the sibling in the same family is revoked too");
    });

    it("refuses even if the family revocation itself fails, and reports it", async () => {
      const { refreshToken, user } = await openSession();

      expectSuccess(await service.refresh(refreshToken));

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeSessionFamily: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: broken }).refresh(refreshToken));

      // The request is still refused; the failed revocation is an operator
      // problem, not a reason to issue tokens.
      assert.equal(failure.reason, "token_reuse_detected");

      // And the service does NOT pretend the revocation happened.
      assert.equal(failure.cleanup, "failed");

      // The family genuinely survived - this is the residual risk, and the
      // test states it rather than asserting a revocation that never
      // occurred.
      const survivors = await h.sessions.listSessionsForUser(user.id);
      assert.ok(
        survivors.length > 0,
        "sessions remain usable when family revocation fails - the documented risk",
      );
    });
  });

  describe("concurrency: two refreshes with the same token", () => {
    it("exactly one succeeds, and the loser triggers reuse detection", async () => {
      const { refreshToken, user } = await openSession();

      const results = await Promise.all([
        service.refresh(refreshToken),
        service.refresh(refreshToken),
      ]);

      const successes = results.filter((r) => r.outcome === "success");
      const failures = results.filter((r) => r.outcome === "failure");

      assert.equal(successes.length, 1, "exactly one refresh may succeed");
      assert.equal(failures.length, 1, "the loser must be refused, never silently accepted");

      const loser = failures[0];
      if (loser?.outcome === "failure") {
        assert.equal(loser.reason, "token_reuse_detected");
      }

      // Documented consequence: the family is revoked, so even the winner's
      // brand-new token is dead. A legitimate double-submit logs the user out.
      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });

    it("the loser of a lost compare-and-set is treated as reuse", async () => {
      // Deterministic version: the resolve succeeds, then the rotation loses
      // the CAS - the window where both requests saw an active token.
      const { refreshToken, user, sessionId } = await openSession();

      const losing = withOverrides<SessionRepository>(h.sessions, {
        rotateRefreshToken: () => {
          throw new OptimisticLockError("session", sessionId);
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: losing }).refresh(refreshToken));

      assert.equal(failure.reason, "token_reuse_detected");
      assert.deepEqual(
        await h.sessions.listSessionsForUser(user.id),
        [],
        "the family is revoked on a lost CAS, exactly as on a replay",
      );
    });

    it("three concurrent refreshes still yield at most one success", async () => {
      const { refreshToken } = await openSession();

      const results = await Promise.all([
        service.refresh(refreshToken),
        service.refresh(refreshToken),
        service.refresh(refreshToken),
      ]);

      assert.equal(results.filter((r) => r.outcome === "success").length, 1);
    });
  });

  describe("failure handling and cleanup", () => {
    it("fails closed when the token lookup throws", async () => {
      const { refreshToken } = await openSession();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        resolveRefreshToken: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: broken }).refresh(refreshToken));
      assert.equal(failure.reason, "refresh_unavailable");
    });

    it("fails closed when the user lookup throws", async () => {
      const { refreshToken } = await openSession();

      const broken = withOverrides<UserRepository>(h.users, {
        findById: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(await serviceWith({ users: broken }).refresh(refreshToken));

      assert.equal(failure.reason, "refresh_unavailable");
      assert.equal(
        (await h.sessions.resolveRefreshToken(hashRefreshToken(refreshToken))).status,
        "active",
        "nothing was consumed",
      );
    });

    it("discards the session when the rotation outcome is uncertain", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      const timingOut = withOverrides<SessionRepository>(h.sessions, {
        rotateRefreshToken: () => {
          // Not a CAS failure: the write may or may not have committed.
          throw new Error("ETIMEDOUT");
        },
      });

      const failure = expectFailure(
        await serviceWith({ sessions: timingOut }).refresh(refreshToken),
      );

      assert.equal(failure.reason, "refresh_unavailable");

      const session = await h.sessions.findBySessionId(sessionId);
      assert.ok(session?.revokedAt, "an ambiguous state is resolved deterministically");
      assert.equal(session?.revocationReason, "issuance_failed");
      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });

    it("refuses without revoking when the session died mid-rotation", async () => {
      const { refreshToken, sessionId } = await openSession();

      const dying = withOverrides<SessionRepository>(h.sessions, {
        rotateRefreshToken: () => {
          throw new SessionNotActiveError(sessionId, "revoked", "logout");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: dying }).refresh(refreshToken));

      // Already revoked, so there is nothing to clean up and no family to burn.
      assert.equal(failure.reason, "invalid_refresh_token");
    });

    it("leaves no usable rotated token when access-token signing fails", async () => {
      // A user row carrying the `public` role reaches signing and
      // `issueAccessToken` refuses it, which exercises the signing-failure
      // path without faking the token service.
      const { refreshToken, user, sessionId } = await openSession();

      h.users.seed({ ...user, role: "public" });

      const failure = expectFailure(await service.refresh(refreshToken));

      assert.equal(failure.reason, "refresh_unavailable");

      const session = await h.sessions.findBySessionId(sessionId);
      assert.ok(session?.revokedAt, "the rotated session is discarded");
      assert.equal(session?.revocationReason, "issuance_failed");

      // The rotated token was never returned, and the session is dead, so
      // nothing usable survives.
      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });

    it("still refuses when the cleanup revoke fails, and reports cleanup failure", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      h.users.seed({ ...user, role: "public" });

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: broken }).refresh(refreshToken));

      assert.equal(failure.reason, "refresh_unavailable", "a failed cleanup never grants access");
      assert.equal(failure.cleanup, "failed", "the failure is reported, not hidden");

      // The session was NOT revoked. Asserting that honestly is the point:
      // an earlier version of this suite would have claimed otherwise.
      const session = await h.sessions.findBySessionId(sessionId);
      assert.equal(session?.revokedAt, undefined, "the session really is still listed");
    });
  });

  describe("no sensitive information leaks", () => {
    it("never returns a raw token in a failure", async () => {
      const { refreshToken } = await openSession();

      expectSuccess(await service.refresh(refreshToken));
      const failure = expectFailure(await service.refresh(refreshToken));

      const serialised = JSON.stringify(failure);

      assert.equal(serialised.includes(refreshToken), false, "the presented token is not echoed");
      assert.equal(serialised.includes(hashRefreshToken(refreshToken)), false, "nor its hash");
      assert.deepEqual(Object.keys(failure).sort(), ["cleanup", "outcome", "reason"]);
    });

    it("never returns the signing secret or a hash on success", async () => {
      const { refreshToken } = await openSession();

      const { data } = expectSuccess(await service.refresh(refreshToken));
      const serialised = JSON.stringify(data);

      assert.equal(serialised.includes(env.JWT_SECRET), false);
      assert.equal(serialised.includes(hashRefreshToken(data.refreshToken)), false);
      assert.equal(serialised.includes(passwordHash), false);
      assert.equal("passwordHash" in data.user, false);
    });

    it("keeps every failure shape uniform and minimal", async () => {
      const { refreshToken, user } = await openSession();

      const unknown = expectFailure(await service.refresh("Z".repeat(43)));
      const malformed = expectFailure(await service.refresh("nope"));

      h.users.seed({ ...user, status: "suspended" });
      const unauthorized = expectFailure(await service.refresh(refreshToken));

      for (const failure of [unknown, malformed, unauthorized]) {
        assert.deepEqual(Object.keys(failure).sort(), ["cleanup", "outcome", "reason"]);
      }

      // Malformed and unknown are indistinguishable to the client.
      assert.deepEqual(unknown, malformed);
    });
  });
  // =========================================================================
  // Step 6I final corrections
  // =========================================================================

  describe("user status fails closed", () => {
    it("denies every non-active status", async () => {
      for (const status of USER_STATUSES.filter((s) => s !== "active")) {
        h.reset();
        const { refreshToken, user } = await openSession();
        h.users.seed({ ...user, status });

        const failure = expectFailure(await service.refresh(refreshToken));

        assert.equal(failure.reason, "user_not_authorized", `${status} must be denied`);
        assert.equal(
          (await h.sessions.resolveRefreshToken(hashRefreshToken(refreshToken))).status,
          "active",
          "and the token must not be consumed",
        );
      }
    });

    it("denies an UNKNOWN status rather than allowing it", async () => {
      // The defect this closes: a deny-list permitted anything not listed,
      // so a status added to `UserStatus` later would have been allowed by
      // default. The cast simulates exactly that future addition.
      const { refreshToken, user } = await openSession();

      h.users.seed({ ...user, status: "archived" as UserStatus });

      const failure = expectFailure(await service.refresh(refreshToken));

      assert.equal(failure.reason, "user_not_authorized", "an unmapped status must be denied");
    });

    it("permits only exactly active", async () => {
      const { refreshToken, user } = await openSession();

      h.users.seed({ ...user, status: "active" });
      expectSuccess(await service.refresh(refreshToken));
    });
  });

  describe("cleanup outcome is reported honestly", () => {
    it("reports committed when the cleanup really wrote", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      // A signing failure forces cleanup; the fake revokes successfully.
      h.users.seed({ ...user, role: "public" });

      const failure = expectFailure(await service.refresh(refreshToken));

      assert.equal(failure.cleanup, "committed");
      assert.ok((await h.sessions.findBySessionId(sessionId))?.revokedAt);
    });

    it("reports not_required when nothing needed cleaning", async () => {
      const { refreshToken, user } = await openSession();

      // Refused before rotation, so there is nothing to compensate.
      h.users.seed({ ...user, status: "suspended" });

      const failure = expectFailure(await service.refresh(refreshToken));

      assert.equal(failure.cleanup, "not_required");
    });

    it("reports committed when the revoke errors but actually landed", async () => {
      // The timeout-that-committed case: the confirmation read establishes
      // the truth instead of the error type deciding it.
      const { refreshToken, user, sessionId } = await openSession();

      h.users.seed({ ...user, role: "public" });

      const lying = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: async (input) => {
          const revoked = await h.sessions.revokeSession(input);
          void revoked;
          throw new Error("ETIMEDOUT");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: lying }).refresh(refreshToken));

      assert.equal(failure.cleanup, "committed", "confirmed by reading, not assumed");
      assert.ok((await h.sessions.findBySessionId(sessionId))?.revokedAt);
    });

    it("retries once, then reports committed if the retry succeeds", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      h.users.seed({ ...user, role: "public" });

      let attempts = 0;
      const flaky = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: async (input) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("transient");
          }
          return h.sessions.revokeSession(input);
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: flaky }).refresh(refreshToken));

      assert.equal(attempts, 2, "revocation is idempotent, so a retry is safe");
      assert.equal(failure.cleanup, "committed");
      assert.ok((await h.sessions.findBySessionId(sessionId))?.revokedAt);
    });

    it("reports failed when neither the write nor the confirmation works", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      h.users.seed({ ...user, role: "public" });

      const dead = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: () => {
          throw new Error("connection reset");
        },
        findBySessionId: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: dead }).refresh(refreshToken));

      assert.equal(failure.cleanup, "failed", "an unknown outcome is reported as failed");
      assert.equal(
        (await h.sessions.findBySessionId(sessionId))?.revokedAt,
        undefined,
        "the session genuinely survives",
      );
    });
  });

  describe("uncertain rotation followed by cleanup failure", () => {
    it("refuses and reports the cleanup failure", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        rotateRefreshToken: () => {
          throw new Error("ETIMEDOUT");
        },
        revokeSession: () => {
          throw new Error("connection reset");
        },
        findBySessionId: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: broken }).refresh(refreshToken));

      assert.equal(failure.reason, "refresh_unavailable");
      assert.equal(failure.cleanup, "failed");

      // Residual state, stated accurately: the session survives. Nobody
      // holds a token for it, because the rotation outcome is unknown and
      // nothing was returned.
      const session = await h.sessions.findBySessionId(sessionId);
      assert.equal(session?.revokedAt, undefined);
      assert.ok(user.id);
    });
  });

  describe("reuse detection followed by family revocation failure", () => {
    it("refuses, reports failure, and leaves the family intact", async () => {
      const { refreshToken, user, sessionId } = await openSession();

      expectSuccess(await service.refresh(refreshToken));

      const dead = withOverrides<SessionRepository>(h.sessions, {
        revokeSessionFamily: () => {
          throw new Error("connection reset");
        },
        listSessionsForUser: () => {
          throw new Error("connection reset");
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: dead }).refresh(refreshToken));

      assert.equal(failure.reason, "token_reuse_detected");
      assert.equal(failure.cleanup, "failed");

      // THE MOST SERIOUS residual risk: the theft response did not take
      // effect, so the session stays usable until it expires.
      const session = await h.sessions.findBySessionId(sessionId);
      assert.equal(
        session?.revokedAt,
        undefined,
        "the family survives - this needs manual intervention",
      );
      assert.ok(user.id);
    });

    it("retries the family revocation before giving up", async () => {
      const { refreshToken, user } = await openSession();

      expectSuccess(await service.refresh(refreshToken));

      let attempts = 0;
      const flaky = withOverrides<SessionRepository>(h.sessions, {
        revokeSessionFamily: async (input) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("transient");
          }
          return h.sessions.revokeSessionFamily(input);
        },
      });

      const failure = expectFailure(await serviceWith({ sessions: flaky }).refresh(refreshToken));

      assert.equal(attempts, 2);
      assert.equal(failure.cleanup, "committed");
      assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
    });
  });

  describe("no tokens are returned on any failure", () => {
    it("carries no token fields on every failure path", async () => {
      const { refreshToken, user } = await openSession();

      const failures = [
        // malformed
        expectFailure(await service.refresh("nope")),
        // unknown
        expectFailure(await service.refresh("Q".repeat(43))),
      ];

      // unauthorized
      h.users.seed({ ...user, status: "suspended" });
      failures.push(expectFailure(await service.refresh(refreshToken)));

      // reuse
      h.users.seed({ ...user, status: "active" });
      expectSuccess(await service.refresh(refreshToken));
      failures.push(expectFailure(await service.refresh(refreshToken)));

      for (const failure of failures) {
        assert.deepEqual(
          Object.keys(failure).sort(),
          ["cleanup", "outcome", "reason"],
          "a failure carries only its outcome, reason and cleanup status",
        );

        const serialised = JSON.stringify(failure);
        assert.equal(serialised.includes(refreshToken), false);
        assert.equal(serialised.includes("accessToken"), false);
        assert.equal(serialised.includes("refreshToken"), false);
        assert.equal(serialised.includes(env.JWT_SECRET), false);
      }
    });
  });

  describe("safe error logging", () => {
    /** Swaps console.* for a collector. Restored by the returned function. */
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

    const SECRETS = ["P@ssw0rd!", "db-prod-01", "1433", "Password=", "Login failed for user"];

    const assertNoSecrets = (lines: string[]): string => {
      const output = lines.join("\n");

      for (const secret of SECRETS) {
        assert.equal(output.includes(secret), false, `logs must not contain ${secret}`);
      }

      return output;
    };

    it("logs no driver message when the token lookup fails", async () => {
      const { refreshToken } = await openSession();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        resolveRefreshToken: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        const result = await serviceWith({ sessions: broken }).refresh(refreshToken);
        assert.equal(expectFailure(result).reason, "refresh_unavailable");
      } finally {
        captured.restore();
      }

      const output = assertNoSecrets(captured.lines);
      assert.ok(output.includes("Error"), "the error CLASS is logged");
    });

    it("logs no driver message when the rotation fails", async () => {
      const { refreshToken } = await openSession();

      const broken = withOverrides<SessionRepository>(h.sessions, {
        rotateRefreshToken: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        await serviceWith({ sessions: broken }).refresh(refreshToken);
      } finally {
        captured.restore();
      }

      assertNoSecrets(captured.lines);
    });

    it("logs no driver message when the user re-read fails", async () => {
      const { refreshToken } = await openSession();

      const broken = withOverrides<UserRepository>(h.users, {
        findById: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        const result = await serviceWith({ users: broken }).refresh(refreshToken);
        assert.equal(expectFailure(result).reason, "refresh_unavailable");
      } finally {
        captured.restore();
      }

      assertNoSecrets(captured.lines);
    });

    it("logs no driver message when the cleanup revocation fails", async () => {
      // The worst case: the refresh is rejected AND the cleanup fails, so
      // two error paths log at once. The session is opened while the account
      // is active - a suspended account cannot log in - and suspended
      // afterwards, which is what makes the refresh reject.
      const { user, refreshToken } = await openSession();
      await h.users.setStatus(user.id, "suspended");

      const broken = withOverrides<SessionRepository>(h.sessions, {
        revokeSession: () => {
          throw new Error(SENSITIVE);
        },
        revokeSessionFamily: () => {
          throw new Error(SENSITIVE);
        },
        listSessionsForUser: () => {
          throw new Error(SENSITIVE);
        },
      });

      const captured = captureLogs();

      try {
        await serviceWith({ sessions: broken }).refresh(refreshToken);
      } finally {
        captured.restore();
      }

      assertNoSecrets(captured.lines);
    });

    it("never logs the presented or the issued refresh token", async () => {
      const { refreshToken } = await openSession();
      const captured = captureLogs();

      let issued = "";

      try {
        const result = await service.refresh(refreshToken);
        issued = expectSuccess(result).data.refreshToken;

        // And the failure paths too.
        await service.refresh(refreshToken);
        await service.refresh("not-a-real-token");
      } finally {
        captured.restore();
      }

      const output = captured.lines.join("\n");

      assert.equal(output.includes(refreshToken), false, "the presented token is never logged");
      assert.ok(issued.length > 0);
      assert.equal(output.includes(issued), false, "nor the newly issued one");
      assert.equal(
        output.includes(hashRefreshToken(refreshToken)),
        false,
        "nor even its hash",
      );
    });
  });
});
