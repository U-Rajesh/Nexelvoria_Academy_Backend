import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RepositoryNotConfiguredError,
  createProductionContainer,
} from "../src/container/container";
import type { Session } from "../src/modules/auth/session.types";
import { getSessionStatus, isSessionUsable } from "../src/modules/auth/session.types";
import { generateRefreshToken, hashRefreshToken } from "../src/modules/auth/token.service";
import {
  OptimisticLockError,
  RecordNotFoundError,
} from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Session repository tests, verified through the in-memory adapter.
 *
 * Expiry is tested with explicit past/future `expiresAt` values rather than
 * timers, so the tests are deterministic and do not sleep.
 */

const USER_A = "user-a";
const USER_B = "user-b";

const future = (minutes = 60): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const past = (minutes = 60): string => new Date(Date.now() - minutes * 60_000).toISOString();

describe("session repository", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  /** Opens a session for a user with a real refresh-token hash. */
  const open = async (
    userId = USER_A,
    overrides: Partial<Parameters<TestHarness["sessions"]["create"]>[0]> = {},
  ): Promise<{ session: Session; rawToken: string }> => {
    const generated = generateRefreshToken();

    const session = await h.sessions.create({
      userId,
      refreshTokenHash: generated.tokenHash,
      expiresAt: generated.expiresAt,
      ...overrides,
    });

    return { session, rawToken: generated.token };
  };

  describe("creation", () => {
    it("creates a session with server-owned fields", async () => {
      const { session } = await open(USER_A, {
        device: "Windows Desktop",
        browser: "Chrome 131.0",
        os: "Windows 11",
        ipAddress: "203.0.113.10",
        location: "Hyderabad, India",
      });

      assert.equal(session.sessionId, "session-1", "the store assigns the id");
      assert.equal(session.userId, USER_A);
      assert.ok(session.createdAt, "createdAt is server-owned");
      assert.equal(session.lastActiveAt, session.createdAt);
      assert.equal(session.revokedAt, undefined);
      assert.equal(session.revocationReason, undefined);

      // Optional client metadata is carried through for the UI's SessionItem.
      assert.equal(session.device, "Windows Desktop");
      assert.equal(session.browser, "Chrome 131.0");
      assert.equal(session.os, "Windows 11");
      assert.equal(session.ipAddress, "203.0.113.10");
      assert.equal(session.location, "Hyderabad, India");
    });

    it("starts a rotation family named after itself", async () => {
      const { session } = await open();

      assert.equal(session.familyId, session.sessionId, "a fresh login starts its own family");
    });

    it("continues an existing family when asked", async () => {
      const first = await open();
      const { session } = await open(USER_A, { familyId: first.session.familyId });

      assert.equal(session.familyId, first.session.familyId);
      assert.notEqual(session.sessionId, first.session.sessionId);
    });

    it("is active immediately", async () => {
      const { session } = await open();

      assert.equal(getSessionStatus(session), "active");
      assert.equal(isSessionUsable(session), true);
    });
  });

  describe("lookup", () => {
    it("finds a session by id", async () => {
      const { session } = await open();
      const found = await h.sessions.findBySessionId(session.sessionId);

      assert.equal(found?.sessionId, session.sessionId);
      assert.equal(found?.userId, USER_A);
    });

    it("returns null for an unknown session id", async () => {
      assert.equal(await h.sessions.findBySessionId("session-does-not-exist"), null);
      assert.equal(await h.sessions.findBySessionId(""), null);
    });

    it("finds a session by refresh-token hash", async () => {
      const { session, rawToken } = await open();

      const found = await h.sessions.findByRefreshTokenHash(hashRefreshToken(rawToken));
      assert.equal(found?.sessionId, session.sessionId);
    });

    it("returns null for an unknown refresh-token hash", async () => {
      await open();

      const otherToken = generateRefreshToken();
      assert.equal(await h.sessions.findByRefreshTokenHash(otherToken.tokenHash), null);
      assert.equal(await h.sessions.findByRefreshTokenHash(""), null);
    });
  });

  describe("expiry", () => {
    it("reports an expired session as expired, and unusable", async () => {
      const { session } = await open(USER_A, { expiresAt: past(1) });

      assert.equal(getSessionStatus(session), "expired");
      assert.equal(isSessionUsable(session), false);
    });

    it("still RETURNS an expired session from lookups", async () => {
      // The port returns revoked/expired rows so callers can distinguish
      // "expired" from "unknown" - a null could not express the difference.
      const { session, rawToken } = await open(USER_A, { expiresAt: past(1) });

      assert.ok(await h.sessions.findBySessionId(session.sessionId));
      assert.ok(await h.sessions.findByRefreshTokenHash(hashRefreshToken(rawToken)));
    });

    it("excludes expired sessions from the user's list by default", async () => {
      await open(USER_A, { expiresAt: past(1) });
      const live = await open(USER_A);

      const listed = await h.sessions.listSessionsForUser(USER_A);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, live.session.sessionId);

      const all = await h.sessions.listSessionsForUser(USER_A, { includeExpired: true });
      assert.equal(all.length, 2);
    });

    it("treats a session expiring exactly now as expired", async () => {
      const { session } = await open(USER_A, { expiresAt: new Date().toISOString() });

      assert.equal(isSessionUsable(session), false);
    });
  });

  describe("revocation", () => {
    it("revokes one session with a reason", async () => {
      const { session } = await open();

      const revoked = await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      assert.ok(revoked.revokedAt);
      assert.equal(revoked.revocationReason, "logout");
      assert.equal(getSessionStatus(revoked), "revoked");
      assert.equal(isSessionUsable(revoked), false);
    });

    it("still returns a revoked session from lookups", async () => {
      // Required for reuse detection: a rotated-away token must look
      // REVOKED, not unknown.
      const { session, rawToken } = await open();

      await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      const byHash = await h.sessions.findByRefreshTokenHash(hashRefreshToken(rawToken));
      assert.ok(byHash, "a revoked session must still be findable by its hash");
      assert.ok(byHash.revokedAt);
    });

    it("is idempotent and keeps the FIRST reason", async () => {
      const { session } = await open();

      await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "token_reuse_detected",
      });

      const again = await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      // The security-relevant reason must not be overwritten by a later logout.
      assert.equal(again.revocationReason, "token_reuse_detected");
    });

    it("throws for an unknown session", async () => {
      await assert.rejects(
        () => h.sessions.revokeSession({ sessionId: "nope", userId: USER_A, reason: "logout" }),
        RecordNotFoundError,
      );
    });

    it("excludes revoked sessions from the list by default", async () => {
      const a = await open(USER_A);
      await open(USER_A);

      await h.sessions.revokeSession({
        sessionId: a.session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      assert.equal((await h.sessions.listSessionsForUser(USER_A)).length, 1);
      assert.equal(
        (await h.sessions.listSessionsForUser(USER_A, { includeRevoked: true })).length,
        2,
      );
    });
  });

  describe("bulk revocation", () => {
    it("revokes every session for a user", async () => {
      await open(USER_A);
      await open(USER_A);
      await open(USER_A);

      const count = await h.sessions.revokeAllForUser({
        userId: USER_A,
        reason: "password_changed",
      });

      assert.equal(count, 3);
      assert.equal((await h.sessions.listSessionsForUser(USER_A)).length, 0);
    });

    it("preserves the excepted session — 'terminate all others'", async () => {
      const keep = await open(USER_A);
      await open(USER_A);
      await open(USER_A);

      const count = await h.sessions.revokeAllForUser({
        userId: USER_A,
        reason: "logout_all",
        exceptSessionId: keep.session.sessionId,
      });

      assert.equal(count, 2, "only the other two are revoked");

      const remaining = await h.sessions.listSessionsForUser(USER_A);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.sessionId, keep.session.sessionId);
    });

    it("counts only sessions it newly revoked", async () => {
      const a = await open(USER_A);
      await open(USER_A);

      await h.sessions.revokeSession({
        sessionId: a.session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      const count = await h.sessions.revokeAllForUser({
        userId: USER_A,
        reason: "account_suspended",
      });

      assert.equal(count, 1, "the already-revoked session is not counted again");
    });

    it("revokes a whole rotation family on reuse detection", async () => {
      const root = await open(USER_A);
      await open(USER_A, { familyId: root.session.familyId });
      const unrelated = await open(USER_A);

      const count = await h.sessions.revokeSessionFamily({
        familyId: root.session.familyId,
        reason: "token_reuse_detected",
      });

      assert.equal(count, 2, "both members of the family go");

      const survivor = await h.sessions.findBySessionId(unrelated.session.sessionId);
      assert.equal(survivor?.revokedAt, undefined, "an unrelated family is untouched");
    });

    it("returns 0 when there is nothing to revoke", async () => {
      assert.equal(
        await h.sessions.revokeAllForUser({ userId: "ghost", reason: "logout" }),
        0,
      );
      assert.equal(
        await h.sessions.revokeSessionFamily({ familyId: "ghost", reason: "logout" }),
        0,
      );
    });
  });

  describe("refresh-token rotation", () => {
    it("replaces the hash atomically and invalidates the old one", async () => {
      const { session, rawToken } = await open();
      const next = generateRefreshToken();

      const rotated = await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: hashRefreshToken(rawToken),
        newRefreshTokenHash: next.tokenHash,
        expiresAt: next.expiresAt,
      });

      assert.equal(rotated.refreshTokenHash, next.tokenHash);
      assert.notEqual(rotated.refreshTokenHash, hashRefreshToken(rawToken));

      // The new token resolves to the session...
      assert.equal(
        (await h.sessions.findByRefreshTokenHash(next.tokenHash))?.sessionId,
        session.sessionId,
      );

      // ...and the old one no longer does.
      assert.equal(
        await h.sessions.findByRefreshTokenHash(hashRefreshToken(rawToken)),
        null,
        "the rotated-away token must no longer resolve",
      );
    });

    it("keeps the session id and family across rotation", async () => {
      const { session, rawToken } = await open();
      const next = generateRefreshToken();

      const rotated = await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: hashRefreshToken(rawToken),
        newRefreshTokenHash: next.tokenHash,
      });

      assert.equal(rotated.sessionId, session.sessionId);
      assert.equal(rotated.familyId, session.familyId);
    });

    it("rejects rotation when the expected hash no longer matches", async () => {
      // This is the concurrency guard: a second rotation attempt presenting
      // the already-consumed hash loses, which is how reuse is detected.
      const { session, rawToken } = await open();
      const first = generateRefreshToken();

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: hashRefreshToken(rawToken),
        newRefreshTokenHash: first.tokenHash,
      });

      const second = generateRefreshToken();

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: hashRefreshToken(rawToken), // stale
            newRefreshTokenHash: second.tokenHash,
          }),
        OptimisticLockError,
      );

      // The state from the first rotation is intact.
      const current = await h.sessions.findBySessionId(session.sessionId);
      assert.equal(current?.refreshTokenHash, first.tokenHash);
    });

    it("throws for an unknown session", async () => {
      const next = generateRefreshToken();

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: "nope",
            expectedCurrentHash: "whatever",
            newRefreshTokenHash: next.tokenHash,
          }),
        RecordNotFoundError,
      );
    });
  });

  describe("last-active tracking", () => {
    it("updates the timestamp", async () => {
      const { session } = await open();
      const stamp = future(1);

      await h.sessions.updateLastActiveAt(session.sessionId, stamp);

      assert.equal((await h.sessions.findBySessionId(session.sessionId))?.lastActiveAt, stamp);
    });

    it("silently ignores unknown and revoked sessions", async () => {
      // Best-effort: an informational timestamp must never throw on a hot path.
      await h.sessions.updateLastActiveAt("nope", future(1));

      const { session } = await open();
      await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      const stamp = future(5);
      await h.sessions.updateLastActiveAt(session.sessionId, stamp);

      const after = await h.sessions.findBySessionId(session.sessionId);
      assert.notEqual(after?.lastActiveAt, stamp, "a revoked session is not touched");
    });
  });

  describe("cross-user isolation", () => {
    it("never lists another user's sessions", async () => {
      await open(USER_A);
      await open(USER_A);
      await open(USER_B);

      assert.equal((await h.sessions.listSessionsForUser(USER_A)).length, 2);
      assert.equal((await h.sessions.listSessionsForUser(USER_B)).length, 1);
      assert.deepEqual(await h.sessions.listSessionsForUser("ghost"), []);
    });

    it("refuses to revoke a session belonging to another user", async () => {
      const victim = await open(USER_B);

      await assert.rejects(
        () =>
          h.sessions.revokeSession({
            sessionId: victim.session.sessionId,
            userId: USER_A, // attacker
            reason: "logout",
          }),
        RecordNotFoundError,
        "a mismatched owner must be indistinguishable from a missing session",
      );

      const still = await h.sessions.findBySessionId(victim.session.sessionId);
      assert.equal(still?.revokedAt, undefined, "the victim's session is untouched");
    });

    it("scopes bulk revocation to one user", async () => {
      await open(USER_A);
      await open(USER_B);

      await h.sessions.revokeAllForUser({ userId: USER_A, reason: "account_suspended" });

      assert.equal((await h.sessions.listSessionsForUser(USER_A)).length, 0);
      assert.equal((await h.sessions.listSessionsForUser(USER_B)).length, 1);
    });
  });

  describe("listing", () => {
    it("orders by most recently active first", async () => {
      const a = await open(USER_A);
      const b = await open(USER_A);

      await h.sessions.updateLastActiveAt(a.session.sessionId, future(10));
      await h.sessions.updateLastActiveAt(b.session.sessionId, future(5));

      const listed = await h.sessions.listSessionsForUser(USER_A);

      assert.equal(listed[0]?.sessionId, a.session.sessionId);
      assert.equal(listed[1]?.sessionId, b.session.sessionId);
    });

    it("exposes the fields the UI needs, and no isCurrent flag", async () => {
      await open(USER_A, { device: "iPhone", browser: "Safari", os: "iOS 18" });

      const [listed] = await h.sessions.listSessionsForUser(USER_A);
      assert.ok(listed);

      // `isCurrent` is a property of the REQUEST, not the row, so the
      // repository cannot and must not provide it.
      assert.equal("isCurrent" in listed, false);
      assert.equal(listed.device, "iPhone");
      assert.ok(listed.lastActiveAt);
    });
  });

  describe("no raw refresh tokens are stored", () => {
    it("stores only the hash, never the token", async () => {
      const { session, rawToken } = await open();

      assert.notEqual(session.refreshTokenHash, rawToken);
      assert.equal(session.refreshTokenHash, hashRefreshToken(rawToken));
      assert.equal(session.refreshTokenHash.length, 64, "hex SHA-256");

      // The raw token must appear nowhere in the stored row.
      assert.equal(
        JSON.stringify(session).includes(rawToken),
        false,
        "the raw refresh token must never be persisted",
      );
    });

    it("keeps raw tokens out of every stored row, including after rotation", async () => {
      const { session, rawToken } = await open();
      const next = generateRefreshToken();

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: hashRefreshToken(rawToken),
        newRefreshTokenHash: next.tokenHash,
      });

      const all = await h.sessions.listSessionsForUser(USER_A, {
        includeRevoked: true,
        includeExpired: true,
      });

      const serialised = JSON.stringify(all);
      assert.equal(serialised.includes(rawToken), false);
      assert.equal(serialised.includes(next.token), false);
    });

    it("leaks nothing sensitive through a session row", async () => {
      const { session } = await open();
      const keys = Object.keys(session);

      for (const forbidden of ["password", "passwordHash", "refreshToken", "token", "secret"]) {
        assert.equal(keys.includes(forbidden), false, `${forbidden} must not be a session field`);
      }
    });
  });

  describe("test isolation", () => {
    it("gives each harness its own sessions", async () => {
      const other = createTestHarness();

      await open(USER_A);

      assert.equal(h.sessions.count, 1);
      assert.equal(other.sessions.count, 0);
    });

    it("reset() clears sessions and restarts ids", async () => {
      await open(USER_A);
      assert.equal(h.sessions.count, 1);

      h.reset();
      assert.equal(h.sessions.count, 0);

      const { session } = await open(USER_A);
      assert.equal(session.sessionId, "session-1", "ids are deterministic after reset");
    });
  });

  describe("dependency injection", () => {
    it("resolves through the container as a SessionRepository", async () => {
      const fromContainer = h.container.repositories.sessions;

      assert.equal(h.container.has("sessions"), true);
      assert.equal(fromContainer, h.sessions, "one instance per container");

      const generated = generateRefreshToken();
      const created = await fromContainer.create({
        userId: USER_A,
        refreshTokenHash: generated.tokenHash,
        expiresAt: generated.expiresAt,
      });

      assert.equal(created.userId, USER_A);
    });

    it("is NOT registered in the production container", () => {
      const production = createProductionContainer();

      assert.equal(production.has("sessions"), false);
      assert.throws(() => production.repositories.sessions, RepositoryNotConfiguredError);
    });
  });
});
