import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RepositoryNotConfiguredError,
  createProductionContainer,
} from "../src/container/container";
import type { CredentialRecord } from "../src/modules/auth/credential.types";
import {
  isCredentialLocked,
  remainingAttempts,
  toCredentialSecurityView,
  toLockoutState,
} from "../src/modules/auth/credential.types";
import {
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../src/modules/auth/password.service";
import {
  DuplicateRecordError,
  OptimisticLockError,
  RecordNotFoundError,
} from "../src/repositories/repository.errors";
import { REDACTED, redact } from "../src/utils/redact";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Credential repository tests, verified through the in-memory adapter.
 *
 * Real argon2id hashes are used where the test is about a hash, so the port
 * is exercised with the values it will actually store. Hashing costs ~120ms,
 * so it is used sparingly.
 */

const USER_A = "user-a";
const USER_B = "user-b";

/** Confirmed threshold: the frontend locks after 5 consecutive failures. */
const THRESHOLD = 5;

const past = (minutes = 60): string => new Date(Date.now() - minutes * 60_000).toISOString();
const future = (minutes = 60): string => new Date(Date.now() + minutes * 60_000).toISOString();

describe("credential repository", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  const seedCredential = async (userId = USER_A, hash = "$argon2id$placeholder") =>
    h.credentials.create({ userId, passwordHash: hash });

  /** Drives a credential into lockout through the real counter path. */
  const lockOut = async (userId = USER_A): Promise<void> => {
    for (let i = 0; i < THRESHOLD; i += 1) {
      await h.credentials.recordFailedAttempt({ userId, threshold: THRESHOLD });
    }
  };

  describe("creation", () => {
    it("creates a credential with server-owned defaults", async () => {
      const created = await seedCredential();

      assert.equal(created.userId, USER_A);
      assert.equal(created.failedLoginAttempts, 0);
      assert.equal(created.lockedUntil, undefined);
      assert.equal(created.lastFailedLoginAt, undefined);
      assert.ok(created.createdAt);
      assert.ok(created.updatedAt);
      assert.ok(created.passwordUpdatedAt);
    });

    it("stores a real argon2id hash verbatim", async () => {
      const hash = await hashPassword("Password@123");
      const created = await h.credentials.create({ userId: USER_A, passwordHash: hash });

      assert.equal(created.passwordHash, hash);
      assert.match(created.passwordHash, /^\$argon2id\$/);
      assert.equal((await verifyPassword(created.passwordHash, "Password@123")).valid, true);
    });

    it("allows exactly one credential per user", async () => {
      await seedCredential();

      await assert.rejects(
        () => seedCredential(),
        (err: unknown) => {
          assert.ok(err instanceof DuplicateRecordError);
          assert.equal(err.entity, "credential");
          assert.equal(err.field, "userId");
          return true;
        },
      );
    });

    it("holds no identity fields", async () => {
      const created = await seedCredential();

      for (const field of ["email", "mobile", "name", "role", "status"]) {
        assert.equal(field in created, false, `${field} must not be on a credential`);
      }
    });

    it("never stores a plaintext password", async () => {
      const plaintext = "Password@123";
      const hash = await hashPassword(plaintext);
      const created = await h.credentials.create({ userId: USER_A, passwordHash: hash });

      assert.equal(JSON.stringify(created).includes(plaintext), false);
    });
  });

  describe("lookup", () => {
    it("finds by user id", async () => {
      await seedCredential();
      assert.equal((await h.credentials.findByUserId(USER_A))?.userId, USER_A);
    });

    it("returns null when the user has no credential", async () => {
      assert.equal(await h.credentials.findByUserId("user-nobody"), null);
      assert.equal(await h.credentials.findByUserId(""), null);
    });

    it("hands back detached copies, as a real database would", async () => {
      const created = await seedCredential();
      created.passwordHash = "$argon2id$tampered";

      assert.equal(
        (await h.credentials.findByUserId(USER_A))?.passwordHash,
        "$argon2id$placeholder",
      );
    });

    it("exposes no lookup by email", () => {
      assert.equal("findByEmail" in h.credentials, false);
      assert.equal("findByIdentifier" in h.credentials, false);
    });
  });

  // =========================================================================
  // Part 1 — the three password write paths
  // =========================================================================

  describe("changePassword — a deliberate change by the user", () => {
    it("replaces the hash under compare-and-set", async () => {
      const original = await hashPassword("Password@123");
      await h.credentials.create({ userId: USER_A, passwordHash: original });

      const replacement = await hashPassword("Different@456");
      const updated = await h.credentials.changePassword({
        userId: USER_A,
        expectedCurrentHash: original,
        newPasswordHash: replacement,
      });

      assert.equal(updated.passwordHash, replacement);
      assert.equal((await verifyPassword(updated.passwordHash, "Password@123")).valid, false);
      assert.equal((await verifyPassword(updated.passwordHash, "Different@456")).valid, true);
    });

    it("stamps passwordUpdatedAt, clears the counter and the lockout", async () => {
      const old = past(1000);
      h.credentials.seed({
        userId: USER_A,
        passwordHash: "$argon2id$current",
        passwordUpdatedAt: old,
        failedLoginAttempts: 0,
        createdAt: old,
        updatedAt: old,
      });
      await lockOut();

      const updated = await h.credentials.changePassword({
        userId: USER_A,
        expectedCurrentHash: "$argon2id$current",
        newPasswordHash: "$argon2id$next",
      });

      assert.notEqual(updated.passwordUpdatedAt, old);
      assert.ok(Date.parse(updated.passwordUpdatedAt) > Date.parse(old));
      assert.equal(updated.failedLoginAttempts, 0);
      assert.equal(updated.lockedUntil, undefined);
      assert.equal(isCredentialLocked(updated, THRESHOLD), false);
    });

    it("rejects a stale expected hash", async () => {
      await seedCredential(USER_A, "$argon2id$current");

      // Someone else changed it first.
      await h.credentials.resetPassword({
        userId: USER_A,
        newPasswordHash: "$argon2id$someone-else",
      });

      await assert.rejects(
        () =>
          h.credentials.changePassword({
            userId: USER_A,
            expectedCurrentHash: "$argon2id$current",
            newPasswordHash: "$argon2id$mine",
          }),
        OptimisticLockError,
      );

      assert.equal(
        (await h.credentials.findByUserId(USER_A))?.passwordHash,
        "$argon2id$someone-else",
        "the newer password must survive",
      );
    });

    it("throws for a user with no credential", async () => {
      await assert.rejects(
        () =>
          h.credentials.changePassword({
            userId: "nobody",
            expectedCurrentHash: "$argon2id$x",
            newPasswordHash: "$argon2id$y",
          }),
        RecordNotFoundError,
      );
    });
  });

  describe("rehashPassword — a storage upgrade, not a password change", () => {
    it("replaces only the hash, leaving passwordUpdatedAt untouched", async () => {
      const old = past(1000);
      const created = h.credentials.seed({
        userId: USER_A,
        passwordHash: "$argon2id$weak-params",
        passwordUpdatedAt: old,
        failedLoginAttempts: 0,
        createdAt: old,
        updatedAt: old,
      });

      const upgraded = await h.credentials.rehashPassword({
        userId: USER_A,
        expectedCurrentHash: "$argon2id$weak-params",
        newPasswordHash: "$argon2id$strong-params",
      });

      assert.equal(upgraded.passwordHash, "$argon2id$strong-params");
      assert.equal(
        upgraded.passwordUpdatedAt,
        created.passwordUpdatedAt,
        "a rehash must NOT look like a password change — it would corrupt password-age reporting",
      );
    });

    it("does not alter lockout state", async () => {
      await seedCredential(USER_A, "$argon2id$weak");
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });

      const upgraded = await h.credentials.rehashPassword({
        userId: USER_A,
        expectedCurrentHash: "$argon2id$weak",
        newPasswordHash: "$argon2id$strong",
      });

      assert.equal(upgraded.failedLoginAttempts, 1, "the counter is not a rehash concern");
      assert.ok(upgraded.lastFailedLoginAt, "failure history is preserved");
    });

    it("REQUIRES compare-and-set — the Step 6G correction", async () => {
      // The original contract allowed an unconditional rehash, which could
      // silently reinstate an old password over a newer one.
      await seedCredential(USER_A, "$argon2id$v1");

      await assert.rejects(
        () =>
          h.credentials.rehashPassword({
            userId: USER_A,
            expectedCurrentHash: "$argon2id$not-current",
            newPasswordHash: "$argon2id$v2",
          }),
        OptimisticLockError,
      );

      assert.equal((await h.credentials.findByUserId(USER_A))?.passwordHash, "$argon2id$v1");
    });

    it("works end to end with the real needsRehash signal", async () => {
      // A hash at the OWASP minimum, i.e. below current policy.
      const argon2 = (await import("argon2")).default;
      const legacy = await argon2.hash("Password@123", {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });

      await h.credentials.create({ userId: USER_A, passwordHash: legacy });

      // Login path: verify, see the upgrade hint, re-hash under CAS.
      const verification = await verifyPassword(legacy, "Password@123");
      assert.equal(verification.valid, true);
      assert.equal(verification.needsRehash, true);
      assert.equal(needsRehash(legacy), true);

      const upgraded = await hashPassword("Password@123");
      const stored = await h.credentials.rehashPassword({
        userId: USER_A,
        expectedCurrentHash: legacy,
        newPasswordHash: upgraded,
      });

      assert.equal(needsRehash(stored.passwordHash), false, "now at current parameters");
      assert.equal((await verifyPassword(stored.passwordHash, "Password@123")).valid, true);
    });
  });

  describe("concurrent password change versus rehash", () => {
    it("a rehash must NOT overwrite a newer password", async () => {
      // The exact race the correction closes. Both operations hold the same
      // original hash; the change wins, and the rehash must lose rather than
      // roll the password back.
      const original = await hashPassword("Original@123");
      await h.credentials.create({ userId: USER_A, passwordHash: original });

      const changed = await hashPassword("BrandNew@456");
      const rehashed = await hashPassword("Original@123");

      // The change lands first.
      await h.credentials.changePassword({
        userId: USER_A,
        expectedCurrentHash: original,
        newPasswordHash: changed,
      });

      // The rehash, still holding the stale hash, must be refused.
      await assert.rejects(
        () =>
          h.credentials.rehashPassword({
            userId: USER_A,
            expectedCurrentHash: original,
            newPasswordHash: rehashed,
          }),
        OptimisticLockError,
      );

      const stored = await h.credentials.findByUserId(USER_A);
      assert.ok(stored);

      // The new password works; the old one does not.
      assert.equal((await verifyPassword(stored.passwordHash, "BrandNew@456")).valid, true);
      assert.equal(
        (await verifyPassword(stored.passwordHash, "Original@123")).valid,
        false,
        "the old password must NOT be reinstated by a losing rehash",
      );
    });

    it("exactly one of two concurrent writes on the same hash wins", async () => {
      await seedCredential(USER_A, "$argon2id$shared");

      const results = await Promise.allSettled([
        h.credentials.changePassword({
          userId: USER_A,
          expectedCurrentHash: "$argon2id$shared",
          newPasswordHash: "$argon2id$from-change",
        }),
        h.credentials.rehashPassword({
          userId: USER_A,
          expectedCurrentHash: "$argon2id$shared",
          newPasswordHash: "$argon2id$from-rehash",
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "exactly one write may land");
      assert.equal(rejected.length, 1);

      const loser = rejected[0];
      if (loser?.status === "rejected") {
        assert.ok(loser.reason instanceof OptimisticLockError);
      }
    });

    it("two concurrent changes cannot both succeed", async () => {
      await seedCredential(USER_A, "$argon2id$shared");

      const results = await Promise.allSettled([
        h.credentials.changePassword({
          userId: USER_A,
          expectedCurrentHash: "$argon2id$shared",
          newPasswordHash: "$argon2id$a",
        }),
        h.credentials.changePassword({
          userId: USER_A,
          expectedCurrentHash: "$argon2id$shared",
          newPasswordHash: "$argon2id$b",
        }),
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    });
  });

  describe("resetPassword — authorization lives in the service", () => {
    it("sets the hash without knowing the current one", async () => {
      await seedCredential(USER_A, "$argon2id$forgotten");

      const reset = await h.credentials.resetPassword({
        userId: USER_A,
        newPasswordHash: "$argon2id$fresh",
      });

      assert.equal(reset.passwordHash, "$argon2id$fresh");
    });

    it("is the confirmed self-service unlock path", async () => {
      await seedCredential();
      await lockOut();

      const locked = await h.credentials.findByUserId(USER_A);
      assert.ok(locked);
      assert.equal(isCredentialLocked(locked, THRESHOLD), true);

      const reset = await h.credentials.resetPassword({
        userId: USER_A,
        newPasswordHash: "$argon2id$fresh",
      });

      assert.equal(reset.failedLoginAttempts, 0);
      assert.equal(reset.lockedUntil, undefined);
      assert.equal(isCredentialLocked(reset, THRESHOLD), false, "a reset unlocks the account");
    });

    it("stamps passwordUpdatedAt", async () => {
      // Seeded with an old timestamp: `create` and `resetPassword` can land
      // in the same millisecond, so comparing against a fresh create is a
      // flaky assertion rather than a meaningful one.
      const old = past(1000);
      h.credentials.seed({
        userId: USER_A,
        passwordHash: "$argon2id$forgotten",
        passwordUpdatedAt: old,
        failedLoginAttempts: 0,
        createdAt: old,
        updatedAt: old,
      });

      const reset = await h.credentials.resetPassword({
        userId: USER_A,
        newPasswordHash: "$argon2id$fresh",
      });

      assert.notEqual(reset.passwordUpdatedAt, old);
      assert.ok(Date.parse(reset.passwordUpdatedAt) > Date.parse(old));
    });

    it("takes no expected hash — the grant check is the caller's job", () => {
      // Kept as its own method so that requirement is visible at every call
      // site rather than hidden in an optional field.
      assert.equal(h.credentials.resetPassword.length, 1, "one input object only");
    });

    it("throws for a user with no credential", async () => {
      await assert.rejects(
        () => h.credentials.resetPassword({ userId: "nobody", newPasswordHash: "$argon2id$x" }),
        RecordNotFoundError,
      );
    });
  });

  // =========================================================================
  // Part 2 — lockout policy
  // =========================================================================

  describe("failed attempts and lockout", () => {
    it("increments and reports remaining attempts", async () => {
      await seedCredential();

      const first = await h.credentials.recordFailedAttempt({
        userId: USER_A,
        threshold: THRESHOLD,
      });

      assert.equal(first.failedLoginAttempts, 1);
      assert.equal(first.isLocked, false);
      assert.equal(first.remainingAttempts, 4, "confirmed UX: N attempts remaining");
    });

    it("locks exactly at the threshold, not before", async () => {
      await seedCredential();

      for (let i = 1; i < THRESHOLD; i += 1) {
        const state = await h.credentials.recordFailedAttempt({
          userId: USER_A,
          threshold: THRESHOLD,
        });

        assert.equal(state.isLocked, false, `attempt ${i} must not lock`);
      }

      const final = await h.credentials.recordFailedAttempt({
        userId: USER_A,
        threshold: THRESHOLD,
      });

      assert.equal(final.failedLoginAttempts, THRESHOLD);
      assert.equal(final.isLocked, true, "the 5th consecutive failure locks");
      assert.equal(final.remainingAttempts, 0);
    });

    it("records the time of the most recent failure", async () => {
      await seedCredential();
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });

      assert.ok((await h.credentials.findByUserId(USER_A))?.lastFailedLoginAt);
    });

    it("NEVER sets lockedUntil — timed lockout is not implemented", async () => {
      // The contradictory timed-lockout path was removed: a lockedUntil that
      // elapsed while the counter stayed at the threshold could never expire.
      await seedCredential();
      await lockOut();

      const record = await h.credentials.findByUserId(USER_A);
      assert.ok(record);
      assert.equal(record.lockedUntil, undefined, "nothing populates lockedUntil");
      assert.equal(isCredentialLocked(record, THRESHOLD), true, "the counter alone locks");
    });

    it("accepts no lock-duration option", async () => {
      // Guards against the removed parameter creeping back in.
      await seedCredential();

      const state = await h.credentials.recordFailedAttempt({
        userId: USER_A,
        threshold: THRESHOLD,
        // @ts-expect-error lockDurationMinutes was removed on purpose (O4).
        lockDurationMinutes: 30,
      });

      assert.equal(state.failedLoginAttempts, 1);
      assert.equal((await h.credentials.findByUserId(USER_A))?.lockedUntil, undefined);
    });

    it("stays locked permanently until an explicit unlock", async () => {
      await seedCredential();
      await lockOut();

      // More failures do not change the outcome.
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });

      const record = await h.credentials.findByUserId(USER_A);
      assert.ok(record);
      assert.equal(isCredentialLocked(record, THRESHOLD), true);
      assert.equal(record.failedLoginAttempts, THRESHOLD + 1);

      // Only an explicit unlock clears it.
      const cleared = await h.credentials.clearLockout(USER_A);
      assert.equal(isCredentialLocked(cleared, THRESHOLD), false);
    });

    it("throws for a user with no credential", async () => {
      await assert.rejects(
        () => h.credentials.recordFailedAttempt({ userId: "nobody", threshold: THRESHOLD }),
        RecordNotFoundError,
      );
    });
  });

  describe("expired lockout timestamps never auto-unlock", () => {
    const withLockedUntil = (lockedUntil: string, attempts: number): CredentialRecord => ({
      userId: USER_A,
      passwordHash: "$argon2id$x",
      passwordUpdatedAt: past(1000),
      failedLoginAttempts: attempts,
      lockedUntil,
      createdAt: past(1000),
      updatedAt: past(1),
    });

    it("an ELAPSED lockedUntil does not unlock a credential at the threshold", async () => {
      // This is the bug Part 2 identified, now pinned as intended behaviour:
      // the counter governs, so an expired timestamp changes nothing.
      const seeded = h.credentials.seed(withLockedUntil(past(120), THRESHOLD));

      assert.equal(
        isCredentialLocked(seeded, THRESHOLD),
        true,
        "no silent automatic unlock",
      );

      const reloaded = await h.credentials.findByUserId(USER_A);
      assert.ok(reloaded);
      assert.equal(isCredentialLocked(reloaded, THRESHOLD), true);
    });

    it("an elapsed lockedUntil with a clean counter is not locked", async () => {
      const seeded = h.credentials.seed(withLockedUntil(past(120), 0));

      assert.equal(isCredentialLocked(seeded, THRESHOLD), false);
    });

    it("a FUTURE lockedUntil still locks, even with a clean counter", async () => {
      // Reserved path, honoured so a future policy can switch it on.
      const seeded = h.credentials.seed(withLockedUntil(future(30), 0));

      assert.equal(isCredentialLocked(seeded, THRESHOLD), true);
    });

    it("clearLockout removes a stale timestamp as well as the counter", async () => {
      h.credentials.seed(withLockedUntil(past(120), THRESHOLD));

      const cleared = await h.credentials.clearLockout(USER_A);

      assert.equal(cleared.lockedUntil, undefined);
      assert.equal(cleared.failedLoginAttempts, 0);
      assert.equal(isCredentialLocked(cleared, THRESHOLD), false);
    });
  });

  describe("concurrency — the lockout must not be defeated", () => {
    it("loses no increments under parallel failures", async () => {
      // A read-modify-write would let ten parallel guesses all read 0 and
      // all write 1, turning a 5-attempt limit into an unlimited one.
      await seedCredential();

      const attempts = 10;

      await Promise.all(
        Array.from({ length: attempts }, () =>
          h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD }),
        ),
      );

      const record = await h.credentials.findByUserId(USER_A);
      assert.equal(record?.failedLoginAttempts, attempts, "every attempt must be counted");
      assert.equal(isCredentialLocked(record!, THRESHOLD), true);
    });

    it("reports a strictly increasing count to each caller", async () => {
      await seedCredential();

      const states = await Promise.all(
        Array.from({ length: 6 }, () =>
          h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD }),
        ),
      );

      const counts = states.map((s) => s.failedLoginAttempts).sort((a, b) => a - b);

      assert.deepEqual(counts, [1, 2, 3, 4, 5, 6], "no two callers may see the same count");
      assert.equal(states.filter((s) => s.isLocked).length, 2, "the 5th and 6th see a lock");
    });

    it("keeps users isolated under concurrent failures", async () => {
      await seedCredential(USER_A);
      await seedCredential(USER_B);

      await Promise.all([
        ...Array.from({ length: 3 }, () =>
          h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD }),
        ),
        ...Array.from({ length: 2 }, () =>
          h.credentials.recordFailedAttempt({ userId: USER_B, threshold: THRESHOLD }),
        ),
      ]);

      assert.equal((await h.credentials.findByUserId(USER_A))?.failedLoginAttempts, 3);
      assert.equal((await h.credentials.findByUserId(USER_B))?.failedLoginAttempts, 2);
    });
  });

  describe("resetting and unlocking", () => {
    it("resets the counter on a successful verification", async () => {
      await seedCredential(USER_A, "$argon2id$current");
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });

      const outcome = await h.credentials.resetFailedAttemptsIfAuthorized({
        userId: USER_A,
        threshold: THRESHOLD,
        acceptableHashes: ["$argon2id$current"],
      });

      assert.equal(outcome.status, "reset");
      if (outcome.status !== "reset") return;
      assert.equal(outcome.credential.failedLoginAttempts, 0);
    });

    it("REFUSES the reset when the credential is locked", async () => {
      // The defect this closes: an unconditional reset would erase a lockout
      // created by a concurrent fifth failure, leaving nothing to detect.
      await seedCredential(USER_A, "$argon2id$current");
      await lockOut();

      const outcome = await h.credentials.resetFailedAttemptsIfAuthorized({
        userId: USER_A,
        threshold: THRESHOLD,
        acceptableHashes: ["$argon2id$current"],
      });

      assert.equal(outcome.status, "locked");
      assert.equal(
        (await h.credentials.findByUserId(USER_A))?.failedLoginAttempts,
        THRESHOLD,
        "the lock must survive the refused reset",
      );
    });

    it("REFUSES the reset when the stored hash is not acceptable", async () => {
      await seedCredential(USER_A, "$argon2id$current");
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });

      const outcome = await h.credentials.resetFailedAttemptsIfAuthorized({
        userId: USER_A,
        threshold: THRESHOLD,
        acceptableHashes: ["$argon2id$a-different-password"],
      });

      assert.equal(outcome.status, "password_changed");
      assert.equal(
        (await h.credentials.findByUserId(USER_A))?.failedLoginAttempts,
        1,
        "the counter is left alone",
      );
    });

    it("accepts EITHER the original hash or an upgrade from the same login", async () => {
      await seedCredential(USER_A, "$argon2id$upgraded");
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });

      const outcome = await h.credentials.resetFailedAttemptsIfAuthorized({
        userId: USER_A,
        threshold: THRESHOLD,
        acceptableHashes: ["$argon2id$original", "$argon2id$upgraded"],
      });

      assert.equal(outcome.status, "reset", "a successful rehash must not look like a change");
    });

    it("reports not_found for a user with no credential", async () => {
      const outcome = await h.credentials.resetFailedAttemptsIfAuthorized({
        userId: "nobody",
        threshold: THRESHOLD,
        acceptableHashes: ["$argon2id$x"],
      });

      assert.equal(outcome.status, "not_found");
    });

    it("refuses the reset for a credential with a future lockedUntil", async () => {
      h.credentials.seed({
        userId: USER_A,
        passwordHash: "$argon2id$x",
        passwordUpdatedAt: past(100),
        failedLoginAttempts: 0,
        lockedUntil: future(30),
        createdAt: past(100),
        updatedAt: past(1),
      });

      const outcome = await h.credentials.resetFailedAttemptsIfAuthorized({
        userId: USER_A,
        threshold: THRESHOLD,
        acceptableHashes: ["$argon2id$x"],
      });

      assert.equal(outcome.status, "locked");
      assert.ok(
        (await h.credentials.findByUserId(USER_A))?.lockedUntil,
        "the lockout must survive",
      );
    });

    it("clearLockout removes both the counter and the lockout", async () => {
      await seedCredential();
      await lockOut();

      const cleared = await h.credentials.clearLockout(USER_A);

      assert.equal(cleared.failedLoginAttempts, 0);
      assert.equal(cleared.lockedUntil, undefined);
      assert.equal(isCredentialLocked(cleared, THRESHOLD), false);
    });

    it("clearLockout is idempotent", async () => {
      await seedCredential();
      await h.credentials.clearLockout(USER_A);

      assert.equal((await h.credentials.clearLockout(USER_A)).failedLoginAttempts, 0);
    });

    it("throws for a user with no credential", async () => {
      await assert.rejects(() => h.credentials.clearLockout("nobody"), RecordNotFoundError);
    });

    it("keeps the password hash untouched when resetting or unlocking", async () => {
      await seedCredential(USER_A, "$argon2id$keepme");

      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });
      await h.credentials.resetFailedAttemptsIfAuthorized({
        userId: USER_A,
        threshold: THRESHOLD,
        acceptableHashes: ["$argon2id$keepme"],
      });
      await h.credentials.clearLockout(USER_A);

      assert.equal((await h.credentials.findByUserId(USER_A))?.passwordHash, "$argon2id$keepme");
    });
  });

  // =========================================================================
  // Part 3 — hash exposure
  // =========================================================================

  describe("password hash exposure safeguards", () => {
    it("the security view cannot carry a hash — it is not in the type", async () => {
      const hash = await hashPassword("Password@123");
      await h.credentials.create({ userId: USER_A, passwordHash: hash });
      await h.credentials.recordFailedAttempt({ userId: USER_A, threshold: THRESHOLD });

      const record = await h.credentials.findByUserId(USER_A);
      assert.ok(record);

      const view = toCredentialSecurityView(record, THRESHOLD);

      assert.equal("passwordHash" in view, false, "structurally hash-free");
      assert.equal(JSON.stringify(view).includes(hash), false);

      // But it still carries everything the admin security screen needs.
      assert.equal(view.userId, USER_A);
      assert.equal(view.failedLoginAttempts, 1);
      assert.equal(view.isLocked, false);
      assert.ok(view.passwordUpdatedAt);
      assert.ok(view.lastFailedLoginAt);
    });

    it("redact() strips the hash from anything logged", async () => {
      const hash = await hashPassword("Password@123");
      await h.credentials.create({ userId: USER_A, passwordHash: hash });

      const record = await h.credentials.findByUserId(USER_A);
      const output = redact(record) as Record<string, unknown>;

      assert.equal(output["passwordHash"], REDACTED);
      assert.equal(JSON.stringify(output).includes(hash), false);

      // Non-sensitive fields survive, so a log line is still useful.
      assert.equal(output["userId"], USER_A);
      assert.equal(output["failedLoginAttempts"], 0);
    });

    it("redacts a credential nested inside a log context", async () => {
      const hash = await hashPassword("Password@123");
      await h.credentials.create({ userId: USER_A, passwordHash: hash });
      const record = await h.credentials.findByUserId(USER_A);

      const output = redact({ requestId: "r1", credential: record }) as Record<string, unknown>;

      // The key "credential" itself matches the pattern, so the whole
      // subtree is replaced.
      assert.equal(output["credential"], REDACTED);
      assert.equal(JSON.stringify(output).includes(hash), false);
    });

    it("repository errors never contain a hash", async () => {
      const hash = await hashPassword("Password@123");
      await h.credentials.create({ userId: USER_A, passwordHash: hash });

      const captured: string[] = [];

      // Every failing path, with a real hash in play.
      await h.credentials
        .changePassword({
          userId: USER_A,
          expectedCurrentHash: hash,
          newPasswordHash: hash,
        })
        .catch((err: unknown) => captured.push(String(err)));

      await h.credentials
        .rehashPassword({
          userId: USER_A,
          expectedCurrentHash: "$argon2id$wrong",
          newPasswordHash: hash,
        })
        .catch((err: unknown) => captured.push(String(err)));

      await h.credentials
        .create({ userId: USER_A, passwordHash: hash })
        .catch((err: unknown) => captured.push(String(err)));

      await h.credentials
        .resetPassword({ userId: "nobody", newPasswordHash: hash })
        .catch((err: unknown) => captured.push(String(err)));

      assert.ok(captured.length >= 2, "at least the CAS and duplicate errors should fire");

      for (const message of captured) {
        assert.equal(message.includes(hash), false, `error leaked a hash: ${message}`);
        assert.equal(message.includes("argon2"), false, "no hash fragment either");
      }
    });

    it("no identity or secret fields appear on a credential record", async () => {
      const record = await seedCredential();
      const keys = Object.keys(record);

      assert.deepEqual(
        keys.sort(),
        [
          "createdAt",
          "failedLoginAttempts",
          "passwordHash",
          "passwordUpdatedAt",
          "updatedAt",
          "userId",
        ],
        "the record surface must stay minimal and known",
      );
    });
  });

  describe("lockout helpers", () => {
    it("remainingAttempts never goes negative", () => {
      assert.equal(remainingAttempts(0, 5), 5);
      assert.equal(remainingAttempts(3, 5), 2);
      assert.equal(remainingAttempts(5, 5), 0);
      assert.equal(remainingAttempts(9, 5), 0);
    });

    it("isCredentialLocked is counter-first", () => {
      assert.equal(isCredentialLocked({ failedLoginAttempts: 0 }, 5), false);
      assert.equal(isCredentialLocked({ failedLoginAttempts: 4 }, 5), false);
      assert.equal(isCredentialLocked({ failedLoginAttempts: 5 }, 5), true);
      assert.equal(isCredentialLocked({ failedLoginAttempts: 6 }, 5), true);
    });

    it("toLockoutState summarises a record", () => {
      assert.deepEqual(toLockoutState({ failedLoginAttempts: 2 }, 5), {
        failedLoginAttempts: 2,
        isLocked: false,
        remainingAttempts: 3,
      });
    });
  });

  describe("dependency injection", () => {
    it("resolves through the container", async () => {
      const fromContainer = h.container.repositories.credentials;

      assert.equal(h.container.has("credentials"), true);
      assert.equal(fromContainer, h.credentials, "one instance per container");

      const created = await fromContainer.create({
        userId: USER_A,
        passwordHash: "$argon2id$x",
      });

      assert.equal(created.userId, USER_A);
    });

    it("fails closed in the production container", () => {
      const production = createProductionContainer();

      assert.equal(production.has("credentials"), false);
      assert.throws(() => production.repositories.credentials, RepositoryNotConfiguredError);
    });

    it("does not disturb the other registered repositories", () => {
      for (const name of [
        "sessions",
        "users",
        "students",
        "teachers",
        "courses",
        "enrollments",
      ] as const) {
        assert.equal(h.container.has(name), true, `${name} must still resolve`);
      }
    });
  });

  describe("test isolation", () => {
    it("gives each harness its own credentials", async () => {
      const other = createTestHarness();
      await seedCredential();

      assert.equal(h.credentials.count, 1);
      assert.equal(other.credentials.count, 0);
    });

    it("reset() clears credentials", async () => {
      await seedCredential();
      h.reset();
      assert.equal(h.credentials.count, 0);
    });
  });
});
