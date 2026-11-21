import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { EntityId } from "../../src/contracts/identifier.contract";
import type { SessionRepository } from "../../src/modules/auth/session.repository";
import type { CreateSessionInput, Session } from "../../src/modules/auth/session.types";
import { SessionNotActiveError } from "../../src/modules/auth/session.errors";
import {
  OptimisticLockError,
  RecordNotFoundError,
  RepositoryError,
} from "../../src/repositories/repository.errors";

/**
 * SessionRepository CONTRACT TESTS - implementation-agnostic.
 *
 * Every test exercises the public `SessionRepository` port, so the same
 * suite runs against the in-memory fake today and a SQL Server adapter
 * later:
 *
 *   describeSessionRepositoryContract("SqlServerSessionRepository", makeSqlFixture);
 *
 * Refresh-token "hashes" here are opaque synthetic strings, never real
 * tokens or token hashes, and nothing in this suite logs them.
 *
 * FIXTURE HOOKS: `makeUserId()` - sessions belong to users, and a SQL
 * adapter will likely have a foreign key to `users`, so the fixture creates
 * the owning user row; the fake just returns a fresh id.
 *
 * EXPIRED SESSIONS are produced by `create()` with an `expiresAt` in the
 * past. The port does not forbid that; if an adapter adds a CHECK
 * constraint against it, give the fixture a seed hook instead.
 *
 * DELIBERATELY NOT ASSERTED (undocumented or undecided): the exact
 * `purgeAfter <= before` vs `<` boundary (only clearly-before and
 * clearly-after); exact counts returned by `purgeConsumedRefreshTokens`
 * beyond "at least the records this test created"; order of sessions with
 * equal `lastActiveAt`; whether `rotateRefreshToken` changes `lastActiveAt`;
 * whether a rejected `updateLastActiveAt` value older than the stored one
 * is applied.
 *
 * WHAT A FAKE CANNOT PROVE. The concurrent-rotation tests issue overlapping
 * calls with `Promise.all`; against the single-threaded fake they prove the
 * fake's semantics only. These guarantees MUST be verified against a real
 * SQL Server adapter (pooled connections, so calls genuinely overlap):
 *   - rotation as ONE conditional UPDATE guarded on the old hash, with the
 *     consumed-token INSERT in the SAME transaction (no window in which the
 *     old hash is neither current nor consumed, and no two live hashes);
 *   - revocation being idempotent under concurrent revokes (first reason
 *     wins via `WHERE revoked_at IS NULL`);
 *   - unique / indexed refresh-token-hash lookups for current and consumed
 *     hashes;
 *   - UTC timestamps, datetime2 precision, and expiry evaluated against the
 *     database clock vs the application clock.
 *
 * SQL FIXTURE REQUIREMENTS (no SQL Server fixture exists yet - these bind
 * the first one):
 *   - Run ONLY against a DISPOSABLE test database created for these suites.
 *     `reset()` deletes every row in the tables under test, so a fixture
 *     must NEVER point at a shared or development database, and its reset
 *     should refuse to run unless the target is positively identified as
 *     that disposable database.
 *   - Do NOT wrap tests in one transaction that is rolled back between
 *     tests. Overlapping operations (the concurrency tests) must run on
 *     SEPARATE pooled connections; a single transaction puts them all on one
 *     connection, serialises them, and hides the races under test.
 *   - Reset safely between tests: delete or truncate the tables under test
 *     in foreign-key order and commit, so every connection sees an empty
 *     state before the next test starts.
 *
 * Not a test file itself (`npm test` runs `tests/*.test.ts` only);
 * `tests/session-repository.contract.test.ts` invokes it.
 */

/** What an implementation must provide. Setup lives here, never in assertions. */
export interface SessionRepositoryFixture {
  /** The implementation under test. */
  repository: SessionRepository;
  /**
   * Restores an empty state. SQL: delete/truncate the tables under test in a
   * DISPOSABLE test database - never a rolled-back transaction, never a
   * shared or development database (see SQL FIXTURE REQUIREMENTS above).
   */
  reset(): Promise<void>;
  /** A fresh user id sessions may belong to (SQL: insert the owning user). */
  makeUserId(): Promise<EntityId>;
}

export type SessionRepositoryFixtureFactory = () => Promise<SessionRepositoryFixture>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const describeSessionRepositoryContract = (
  label: string,
  makeFixture: SessionRepositoryFixtureFactory,
): void => {
  describe(`SessionRepository contract: ${label}`, () => {
    let fx: SessionRepositoryFixture;
    let repo: SessionRepository;

    const run = randomUUID().slice(0, 8);
    let counter = 0;
    const tokenHash = (): string => `contract-rt-${run}-${(counter += 1)}`;
    const missingId = (): EntityId => `missing-${randomUUID()}`;
    const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
    const sameInstant = (a: string | undefined, b: string | undefined) =>
      assert.equal(a === undefined ? undefined : Date.parse(a), b === undefined ? undefined : Date.parse(b));

    const open = async (overrides: Partial<CreateSessionInput> = {}): Promise<Session> =>
      repo.create({
        userId: overrides.userId ?? (await fx.makeUserId()),
        refreshTokenHash: tokenHash(),
        expiresAt: iso(DAY),
        ...overrides,
      });

    const openExpired = (overrides: Partial<CreateSessionInput> = {}) => open({ expiresAt: iso(-HOUR), ...overrides });

    const rotate = (session: Session, expected = session.refreshTokenHash, expiresAt?: string) =>
      repo.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: expected,
        newRefreshTokenHash: tokenHash(),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

    const stored = async (sessionId: EntityId): Promise<Session> => {
      const session = await repo.findBySessionId(sessionId);
      assert.ok(session, "session exists");
      return session;
    };

    const ids = (sessions: Session[]) => sessions.map((s) => s.sessionId).sort();

    beforeEach(async () => {
      fx = await makeFixture();
      await fx.reset();
      repo = fx.repository;
    });

    afterEach(async () => {
      await fx.reset();
    });

    // --- create -------------------------------------------------------------------------

    describe("create", () => {
      it("assigns sessionId, createdAt and lastActiveAt and stores the input", async () => {
        const userId = await fx.makeUserId();
        const refreshTokenHash = tokenHash();
        const expiresAt = iso(DAY);
        const before = Date.now();
        const session = await repo.create({
          userId,
          refreshTokenHash,
          expiresAt,
          device: "Laptop",
          browser: "Firefox",
          os: "Linux",
          ipAddress: "203.0.113.7",
          location: "Test City",
        });

        assert.ok(session.sessionId.length > 0);
        assert.equal(session.userId, userId);
        assert.equal(session.refreshTokenHash === refreshTokenHash, true);
        sameInstant(session.expiresAt, expiresAt);
        assert.ok(Date.parse(session.createdAt) >= before - 1000);
        assert.ok(Date.parse(session.lastActiveAt) >= before - 1000);
        assert.equal(session.revokedAt, undefined);
        assert.equal(session.revocationReason, undefined);
        assert.deepEqual(
          [session.device, session.browser, session.os, session.ipAddress, session.location],
          ["Laptop", "Firefox", "Linux", "203.0.113.7", "Test City"],
        );
        assert.deepEqual(await repo.findBySessionId(session.sessionId), session);
      });

      it("familyId defaults to the new sessionId (a fresh login starts its own family)", async () => {
        const session = await open();
        assert.equal(session.familyId, session.sessionId);
      });

      it("keeps an explicit familyId", async () => {
        const first = await open();
        const second = await open({ userId: first.userId, familyId: first.familyId });
        assert.equal(second.familyId, first.familyId);
        assert.notEqual(second.sessionId, first.sessionId);
      });

      it("omitted device metadata stays absent", async () => {
        const session = await open();
        for (const field of ["device", "browser", "os", "ipAddress", "location"] as const) {
          assert.equal(session[field], undefined, field);
        }
      });
    });

    // --- reads ----------------------------------------------------------------------------

    describe("findBySessionId", () => {
      it("returns null - not a throw - for an unknown id", async () => {
        assert.equal(await repo.findBySessionId(missingId()), null);
      });

      it("returns revoked and expired sessions too (the caller decides)", async () => {
        const revoked = await open();
        await repo.revokeSession({ sessionId: revoked.sessionId, userId: revoked.userId, reason: "logout" });
        const expired = await openExpired();

        assert.ok((await stored(revoked.sessionId)).revokedAt !== undefined);
        assert.equal((await stored(expired.sessionId)).sessionId, expired.sessionId);
      });

      it("returns detached copies", async () => {
        const session = await open();
        const read = await stored(session.sessionId);
        read.userId = "someone-else";
        assert.equal((await stored(session.sessionId)).userId, session.userId);
      });
    });

    describe("findByRefreshTokenHash", () => {
      it("finds a session by its CURRENT hash", async () => {
        const session = await open();
        assert.equal((await repo.findByRefreshTokenHash(session.refreshTokenHash))?.sessionId, session.sessionId);
      });

      it("finds a revoked session by its current hash", async () => {
        const session = await open();
        await repo.revokeSession({ sessionId: session.sessionId, userId: session.userId, reason: "logout" });
        assert.equal((await repo.findByRefreshTokenHash(session.refreshTokenHash))?.sessionId, session.sessionId);
      });

      it("never matches a rotated-away hash, an unknown hash or an empty string", async () => {
        const session = await open();
        await rotate(session);
        assert.equal(await repo.findByRefreshTokenHash(session.refreshTokenHash), null);
        assert.equal(await repo.findByRefreshTokenHash(tokenHash()), null);
        assert.equal(await repo.findByRefreshTokenHash(""), null);
      });
    });

    describe("resolveRefreshToken", () => {
      it("active: the current hash of a session", async () => {
        const session = await open();
        const lookup = await repo.resolveRefreshToken(session.refreshTokenHash);
        assert.equal(lookup.status, "active");
        assert.ok(lookup.status === "active");
        assert.equal(lookup.session.sessionId, session.sessionId);
      });

      it("consumed: a rotated-away hash is recorded with its session, family and owner", async () => {
        const session = await open();
        const before = Date.now();
        await rotate(session);

        const lookup = await repo.resolveRefreshToken(session.refreshTokenHash);
        assert.equal(lookup.status, "consumed");
        assert.ok(lookup.status === "consumed");
        assert.equal(lookup.consumed.refreshTokenHash === session.refreshTokenHash, true);
        assert.equal(lookup.consumed.sessionId, session.sessionId);
        assert.equal(lookup.consumed.familyId, session.familyId);
        assert.equal(lookup.consumed.userId, session.userId);
        assert.ok(Date.parse(lookup.consumed.consumedAt) >= before - 1000);
        // purgeAfter = the expiry the consumed token already had.
        sameInstant(lookup.consumed.purgeAfter, session.expiresAt);
      });

      it("unknown: a hash that never existed, and the empty string", async () => {
        assert.deepEqual(await repo.resolveRefreshToken(tokenHash()), { status: "unknown" });
        assert.deepEqual(await repo.resolveRefreshToken(""), { status: "unknown" });
      });

      it("every hash in a rotation chain stays consumed; only the latest is active", async () => {
        const s0 = await open();
        const s1 = await rotate(s0);
        const s2 = await rotate(s1);

        assert.equal((await repo.resolveRefreshToken(s0.refreshTokenHash)).status, "consumed");
        assert.equal((await repo.resolveRefreshToken(s1.refreshTokenHash)).status, "consumed");
        assert.equal((await repo.resolveRefreshToken(s2.refreshTokenHash)).status, "active");
      });
    });

    // --- rotateRefreshToken ----------------------------------------------------------------

    describe("rotateRefreshToken", () => {
      it("replaces the hash and keeps identity, family, owner and createdAt", async () => {
        const session = await open();
        const newRefreshTokenHash = tokenHash();
        const rotated = await repo.rotateRefreshToken({
          sessionId: session.sessionId,
          expectedCurrentHash: session.refreshTokenHash,
          newRefreshTokenHash,
        });

        assert.equal(rotated.refreshTokenHash === newRefreshTokenHash, true);
        assert.equal(rotated.sessionId, session.sessionId);
        assert.equal(rotated.familyId, session.familyId);
        assert.equal(rotated.userId, session.userId);
        sameInstant(rotated.createdAt, session.createdAt);
        assert.equal(rotated.revokedAt, undefined);
        assert.deepEqual(await stored(session.sessionId), rotated);
      });

      it("keeps expiresAt when omitted and applies it when given", async () => {
        const session = await open();
        const kept = await rotate(session);
        sameInstant(kept.expiresAt, session.expiresAt);

        const newExpiry = iso(2 * DAY);
        const extended = await rotate(kept, kept.refreshTokenHash, newExpiry);
        sameInstant(extended.expiresAt, newExpiry);
      });

      it("RecordNotFoundError for an unknown session", async () => {
        await assert.rejects(
          repo.rotateRefreshToken({ sessionId: missingId(), expectedCurrentHash: tokenHash(), newRefreshTokenHash: tokenHash() }),
          (error: unknown) => {
            assert.ok(error instanceof RecordNotFoundError);
            assert.ok(error instanceof RepositoryError);
            return true;
          },
        );
      });

      it("SessionNotActiveError for a revoked session, which stays revoked and unconsumed", async () => {
        const session = await open();
        await repo.revokeSession({ sessionId: session.sessionId, userId: session.userId, reason: "logout" });

        await assert.rejects(rotate(session, session.refreshTokenHash, iso(2 * DAY)), (error: unknown) => {
          assert.ok(error instanceof SessionNotActiveError);
          assert.ok(error instanceof RepositoryError);
          assert.equal(error.status, "revoked");
          assert.equal(error.revocationReason, "logout");
          return true;
        });
        const after = await stored(session.sessionId);
        assert.equal(after.refreshTokenHash === session.refreshTokenHash, true, "hash not replaced");
        assert.ok(after.revokedAt !== undefined, "still revoked");
        sameInstant(after.expiresAt, session.expiresAt);
        assert.notEqual((await repo.resolveRefreshToken(session.refreshTokenHash)).status, "consumed");
      });

      it("SessionNotActiveError for an expired session; a future expiresAt never resurrects it", async () => {
        const session = await openExpired();
        await assert.rejects(rotate(session, session.refreshTokenHash, iso(2 * DAY)), (error: unknown) => {
          assert.ok(error instanceof SessionNotActiveError);
          assert.equal(error.status, "expired");
          return true;
        });
        const after = await stored(session.sessionId);
        sameInstant(after.expiresAt, session.expiresAt);
        assert.equal(after.refreshTokenHash === session.refreshTokenHash, true);
      });

      it("the active check precedes the hash check (revoked + stale -> SessionNotActiveError)", async () => {
        const session = await open();
        await repo.revokeSession({ sessionId: session.sessionId, userId: session.userId, reason: "logout" });
        await assert.rejects(rotate(session, tokenHash()), SessionNotActiveError);
      });

      it("OptimisticLockError for a stale expectedCurrentHash, and nothing is written", async () => {
        const session = await open();
        await assert.rejects(rotate(session, tokenHash()), (error: unknown) => {
          assert.ok(error instanceof OptimisticLockError);
          assert.ok(error instanceof RepositoryError);
          return true;
        });
        const after = await stored(session.sessionId);
        assert.equal(after.refreshTokenHash === session.refreshTokenHash, true);
        assert.equal((await repo.resolveRefreshToken(session.refreshTokenHash)).status, "active");
      });

      it("a consumed hash can never be used to rotate again", async () => {
        const session = await open();
        const rotated = await rotate(session);
        await assert.rejects(rotate(rotated, session.refreshTokenHash), OptimisticLockError);
        assert.equal((await stored(session.sessionId)).refreshTokenHash === rotated.refreshTokenHash, true);
      });

      it("CONCURRENT rotations from the same hash: exactly one wins; the loser's token is never live", async () => {
        const session = await open();
        const candidates = [tokenHash(), tokenHash(), tokenHash()];
        const results = await Promise.allSettled(
          candidates.map((newRefreshTokenHash) =>
            repo.rotateRefreshToken({
              sessionId: session.sessionId,
              expectedCurrentHash: session.refreshTokenHash,
              newRefreshTokenHash,
            }),
          ),
        );

        const winners = results.filter((r) => r.status === "fulfilled");
        assert.equal(winners.length, 1);
        for (const r of results) {
          if (r.status === "rejected") assert.ok(r.reason instanceof OptimisticLockError);
        }

        const winner = (winners[0] as PromiseFulfilledResult<Session>).value;
        assert.equal((await stored(session.sessionId)).refreshTokenHash === winner.refreshTokenHash, true);
        assert.equal((await repo.resolveRefreshToken(session.refreshTokenHash)).status, "consumed");
        for (const candidate of candidates) {
          if (candidate === winner.refreshTokenHash) continue;
          assert.deepEqual(await repo.resolveRefreshToken(candidate), { status: "unknown" }, "loser hash never stored");
        }
      });
    });

    // --- updateLastActiveAt -------------------------------------------------------------

    describe("updateLastActiveAt", () => {
      it("updates an active session", async () => {
        const session = await open();
        const at = iso(5 * 60 * 1000);
        assert.equal(await repo.updateLastActiveAt(session.sessionId, at), undefined);
        sameInstant((await stored(session.sessionId)).lastActiveAt, at);
      });

      it("silently does nothing for unknown, revoked or expired sessions", async () => {
        await repo.updateLastActiveAt(missingId(), iso(0));

        const revoked = await open();
        await repo.revokeSession({ sessionId: revoked.sessionId, userId: revoked.userId, reason: "logout" });
        const expired = await openExpired();
        const before = [await stored(revoked.sessionId), await stored(expired.sessionId)];

        await repo.updateLastActiveAt(revoked.sessionId, iso(HOUR));
        await repo.updateLastActiveAt(expired.sessionId, iso(HOUR));

        sameInstant((await stored(revoked.sessionId)).lastActiveAt, before[0]!.lastActiveAt);
        sameInstant((await stored(expired.sessionId)).lastActiveAt, before[1]!.lastActiveAt);
      });
    });

    // --- revokeSession ---------------------------------------------------------------------

    describe("revokeSession", () => {
      it("revokes with a timestamp and reason", async () => {
        const session = await open();
        const before = Date.now();
        const revoked = await repo.revokeSession({ sessionId: session.sessionId, userId: session.userId, reason: "logout" });
        assert.ok(Date.parse(revoked.revokedAt!) >= before - 1000);
        assert.equal(revoked.revocationReason, "logout");
        assert.deepEqual(await stored(session.sessionId), revoked);
      });

      it("is scoped by owner: another user's session id is RecordNotFoundError and untouched", async () => {
        const session = await open();
        const intruder = await fx.makeUserId();
        await assert.rejects(
          repo.revokeSession({ sessionId: session.sessionId, userId: intruder, reason: "logout" }),
          RecordNotFoundError,
        );
        assert.equal((await stored(session.sessionId)).revokedAt, undefined);
      });

      it("RecordNotFoundError for an unknown session", async () => {
        await assert.rejects(
          repo.revokeSession({ sessionId: missingId(), userId: await fx.makeUserId(), reason: "logout" }),
          RecordNotFoundError,
        );
      });

      it("is idempotent and the FIRST reason wins", async () => {
        const session = await open();
        const first = await repo.revokeSession({
          sessionId: session.sessionId,
          userId: session.userId,
          reason: "token_reuse_detected",
        });
        const again = await repo.revokeSession({ sessionId: session.sessionId, userId: session.userId, reason: "logout" });

        assert.equal(again.revocationReason, "token_reuse_detected");
        sameInstant(again.revokedAt, first.revokedAt);
        assert.equal((await stored(session.sessionId)).revocationReason, "token_reuse_detected");
      });

      it("CONCURRENT revokes of one session: all succeed and one reason is kept", async () => {
        const session = await open();
        const results = await Promise.all(
          (["logout", "logout_all", "admin_terminated"] as const).map((reason) =>
            repo.revokeSession({ sessionId: session.sessionId, userId: session.userId, reason }),
          ),
        );
        const reason = (await stored(session.sessionId)).revocationReason;
        assert.ok(reason !== undefined);
        assert.ok(results.every((r) => r.revocationReason === reason), "every caller sees the winning reason");
      });

      it("does not revoke the user's other sessions", async () => {
        const a = await open();
        const b = await open({ userId: a.userId });
        await repo.revokeSession({ sessionId: a.sessionId, userId: a.userId, reason: "logout" });
        assert.equal((await stored(b.sessionId)).revokedAt, undefined);
      });
    });

    // --- revokeAllForUser ------------------------------------------------------------------

    describe("revokeAllForUser", () => {
      it("revokes every live session of the user and returns how many it newly revoked", async () => {
        const a = await open();
        const b = await open({ userId: a.userId });
        const expired = await openExpired({ userId: a.userId });

        const count = await repo.revokeAllForUser({ userId: a.userId, reason: "password_changed" });
        assert.equal(count, 3);
        for (const s of [a, b, expired]) {
          assert.equal((await stored(s.sessionId)).revocationReason, "password_changed");
        }
      });

      it("spares exceptSessionId", async () => {
        const current = await open();
        const other = await open({ userId: current.userId });
        const count = await repo.revokeAllForUser({
          userId: current.userId,
          reason: "logout_all",
          exceptSessionId: current.sessionId,
        });
        assert.equal(count, 1);
        assert.equal((await stored(current.sessionId)).revokedAt, undefined);
        assert.equal((await stored(other.sessionId)).revocationReason, "logout_all");
      });

      it("does not touch other users' sessions", async () => {
        const mine = await open();
        const theirs = await open();
        await repo.revokeAllForUser({ userId: mine.userId, reason: "account_suspended" });
        assert.equal((await stored(theirs.sessionId)).revokedAt, undefined);
      });

      it("already-revoked sessions are not recounted and keep their first reason", async () => {
        const a = await open();
        const b = await open({ userId: a.userId });
        await repo.revokeSession({ sessionId: a.sessionId, userId: a.userId, reason: "token_reuse_detected" });

        assert.equal(await repo.revokeAllForUser({ userId: a.userId, reason: "role_changed" }), 1);
        assert.equal((await stored(a.sessionId)).revocationReason, "token_reuse_detected");
        assert.equal((await stored(b.sessionId)).revocationReason, "role_changed");
        assert.equal(await repo.revokeAllForUser({ userId: a.userId, reason: "role_changed" }), 0, "idempotent");
      });

      it("returns 0 for a user with no sessions", async () => {
        assert.equal(await repo.revokeAllForUser({ userId: await fx.makeUserId(), reason: "logout_all" }), 0);
      });
    });

    // --- revokeSessionFamily ---------------------------------------------------------------

    describe("revokeSessionFamily", () => {
      it("revokes every session in the family, across rotations, and nothing else", async () => {
        const root = await open();
        const rotated = await rotate(root);
        const sibling = await open({ userId: root.userId, familyId: root.familyId });
        const otherFamily = await open({ userId: root.userId });
        const otherUser = await open();

        const count = await repo.revokeSessionFamily({ familyId: root.familyId, reason: "token_reuse_detected" });
        assert.equal(count, 2);
        for (const s of [rotated, sibling]) {
          assert.equal((await stored(s.sessionId)).revocationReason, "token_reuse_detected");
        }
        assert.equal((await stored(otherFamily.sessionId)).revokedAt, undefined);
        assert.equal((await stored(otherUser.sessionId)).revokedAt, undefined);
      });

      it("is idempotent (second call returns 0) and the first reason wins", async () => {
        const session = await open();
        await repo.revokeSession({ sessionId: session.sessionId, userId: session.userId, reason: "logout" });
        assert.equal(await repo.revokeSessionFamily({ familyId: session.familyId, reason: "token_reuse_detected" }), 0);
        assert.equal((await stored(session.sessionId)).revocationReason, "logout");
      });

      it("reuse response: a consumed token's family is revocable from the lookup alone", async () => {
        const session = await open();
        const rotated = await rotate(session);
        const lookup = await repo.resolveRefreshToken(session.refreshTokenHash);
        assert.ok(lookup.status === "consumed");

        assert.equal(await repo.revokeSessionFamily({ familyId: lookup.consumed.familyId, reason: "token_reuse_detected" }), 1);
        await assert.rejects(rotate(rotated), SessionNotActiveError, "the live token dies with its family");
      });

      it("returns 0 for an unknown family", async () => {
        assert.equal(await repo.revokeSessionFamily({ familyId: missingId(), reason: "token_reuse_detected" }), 0);
      });
    });

    // --- listSessionsForUser -------------------------------------------------------------

    describe("listSessionsForUser", () => {
      it("defaults to active sessions only; options include revoked and/or expired", async () => {
        const active = await open();
        const userId = active.userId;
        const revoked = await open({ userId });
        await repo.revokeSession({ sessionId: revoked.sessionId, userId, reason: "logout" });
        const expired = await openExpired({ userId });

        assert.deepEqual(ids(await repo.listSessionsForUser(userId)), [active.sessionId]);
        assert.deepEqual(
          ids(await repo.listSessionsForUser(userId, { includeRevoked: true })),
          ids([active, revoked]),
        );
        assert.deepEqual(
          ids(await repo.listSessionsForUser(userId, { includeExpired: true })),
          ids([active, expired]),
        );
        assert.deepEqual(
          ids(await repo.listSessionsForUser(userId, { includeRevoked: true, includeExpired: true })),
          ids([active, revoked, expired]),
        );
      });

      it("orders by lastActiveAt, most recent first", async () => {
        const a = await open();
        const b = await open({ userId: a.userId });
        const c = await open({ userId: a.userId });
        await repo.updateLastActiveAt(a.sessionId, iso(3 * 60 * 1000));
        await repo.updateLastActiveAt(b.sessionId, iso(1 * 60 * 1000));
        await repo.updateLastActiveAt(c.sessionId, iso(2 * 60 * 1000));

        assert.deepEqual(
          (await repo.listSessionsForUser(a.userId)).map((s) => s.sessionId),
          [a.sessionId, c.sessionId, b.sessionId],
        );
      });

      it("never includes another user's sessions; empty for a user with none", async () => {
        const mine = await open();
        await open();
        assert.deepEqual(ids(await repo.listSessionsForUser(mine.userId)), [mine.sessionId]);
        assert.deepEqual(await repo.listSessionsForUser(await fx.makeUserId()), []);
      });
    });

    // --- purgeConsumedRefreshTokens ------------------------------------------------------

    describe("purgeConsumedRefreshTokens", () => {
      it("keeps records whose purgeAfter has not passed", async () => {
        const session = await open({ expiresAt: iso(DAY) });
        await rotate(session);
        await repo.purgeConsumedRefreshTokens(iso(HOUR));
        assert.equal((await repo.resolveRefreshToken(session.refreshTokenHash)).status, "consumed");
      });

      it("removes records whose purgeAfter has passed; the token degrades to unknown, never active", async () => {
        const session = await open({ expiresAt: iso(HOUR) });
        const rotated = await rotate(session);

        const removed = await repo.purgeConsumedRefreshTokens(iso(2 * HOUR));
        assert.ok(removed >= 1, "at least this test's record was purged");
        assert.deepEqual(await repo.resolveRefreshToken(session.refreshTokenHash), { status: "unknown" });
        // The live session and its current hash are unaffected.
        assert.equal((await repo.resolveRefreshToken(rotated.refreshTokenHash)).status, "active");
        assert.equal((await stored(session.sessionId)).revokedAt, undefined);
      });

      it("returns 0 when nothing is due", async () => {
        const session = await open({ expiresAt: iso(DAY) });
        await rotate(session);
        assert.equal(await repo.purgeConsumedRefreshTokens(iso(-DAY)), 0);
      });
    });
  });
};
