import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { EntityId } from "../../src/contracts/identifier.contract";
import type { CredentialRepository } from "../../src/modules/auth/credential.repository";
import type { CredentialRecord } from "../../src/modules/auth/credential.types";
import {
  DuplicateRecordError,
  OptimisticLockError,
  RecordNotFoundError,
  RepositoryError,
} from "../../src/repositories/repository.errors";

/**
 * CredentialRepository CONTRACT TESTS - implementation-agnostic.
 *
 * Every test exercises the public `CredentialRepository` port, so the same
 * suite runs against the in-memory fake today and a SQL Server adapter
 * later:
 *
 *   describeCredentialRepositoryContract("SqlServerCredentialRepository", makeSqlFixture);
 *
 * Hashes used here are opaque synthetic strings ("contract-hash-..."), never
 * real password hashes, and nothing in this suite logs them.
 *
 * FIXTURE HOOKS:
 *   - `makeUserId()` - a credential is keyed by its user. A SQL adapter will
 *     likely have a foreign key to `users`, so the fixture creates the owning
 *     user row; the fake just returns a fresh id.
 *   - `seedCredential()` (REQUIRED) - the ONLY way to reach a state with a
 *     `lockedUntil` value, because no port method sets it (lockout is
 *     counter-based and permanent - Q4a). Required rather than optional so
 *     an adapter fixture cannot silently skip the lockedUntil tests: a
 *     fixture without it does not compile.
 *
 * DELIBERATELY NOT ASSERTED (undocumented or undecided): which refusal
 * `resetFailedAttemptsIfAuthorized` reports when BOTH locked and the hash
 * is stale (only that it is not `reset` and nothing is written); whether
 * `lastFailedLoginAt` is cleared by change/reset/clearLockout; whether
 * `reset` touches `lockedUntil`; exact `updatedAt` values.
 *
 * WHAT A FAKE CANNOT PROVE. The concurrency tests below issue overlapping
 * calls with `Promise.all`. Against the single-threaded fake they prove the
 * fake's semantics and that the CONTRACT is expressible; they do NOT prove
 * SQL Server atomicity. Run against a real adapter (with a pooled
 * connection so calls genuinely overlap) they are meaningful, and these
 * guarantees MUST be verified there:
 *   - recordFailedAttempt as ONE statement: no lost increments, lockout at
 *     exactly `threshold` under parallel failures;
 *   - resetFailedAttemptsIfAuthorized as ONE guarded UPDATE: a concurrent
 *     threshold-reaching failure is never erased;
 *   - changePassword / rehashPassword compare-and-set in the UPDATE's WHERE
 *     clause, under the adapter's chosen isolation level;
 *   - one credential per user enforced by a unique key / primary key, not a
 *     pre-check;
 *   - UTC timestamps and datetime2 precision round-tripping.
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
 * `tests/credential-repository.contract.test.ts` invokes it.
 */

/** What an implementation must provide. Setup lives here, never in assertions. */
export interface CredentialRepositoryFixture {
  /** The implementation under test. */
  repository: CredentialRepository;
  /**
   * Restores an empty state. SQL: delete/truncate the tables under test in a
   * DISPOSABLE test database - never a rolled-back transaction, never a
   * shared or development database (see SQL FIXTURE REQUIREMENTS above).
   */
  reset(): Promise<void>;
  /** A fresh user id a credential may be attached to (SQL: insert the owning user). */
  makeUserId(): Promise<EntityId>;
  /**
   * Inserts a fully formed credential row, bypassing `create()`. REQUIRED:
   * it is the only way to reach `lockedUntil` states, which no port method
   * produces. SQL: a plain INSERT into the credentials table.
   */
  seedCredential(record: CredentialRecord): Promise<void>;
}

export type CredentialRepositoryFixtureFactory = () => Promise<CredentialRepositoryFixture>;

const THRESHOLD = 5;
const HOUR = 60 * 60 * 1000;

export const describeCredentialRepositoryContract = (
  label: string,
  makeFixture: CredentialRepositoryFixtureFactory,
): void => {
  describe(`CredentialRepository contract: ${label}`, () => {
    let fx: CredentialRepositoryFixture;
    let repo: CredentialRepository;

    const run = randomUUID().slice(0, 8);
    let counter = 0;
    const hash = (): string => `contract-hash-${run}-${(counter += 1)}`;
    const missingId = (): EntityId => `missing-${randomUUID()}`;
    const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

    /** A user with a fresh credential. */
    const withCredential = async (passwordHash = hash()) => {
      const userId = await fx.makeUserId();
      const credential = await repo.create({ userId, passwordHash });
      return { userId, passwordHash, credential };
    };

    const stored = async (userId: EntityId): Promise<CredentialRecord> => {
      const record = await repo.findByUserId(userId);
      assert.ok(record, "credential exists");
      return record;
    };

    const fail = async (userId: EntityId, times: number) => {
      for (let i = 0; i < times; i += 1) await repo.recordFailedAttempt({ userId, threshold: THRESHOLD });
    };

    /** Seeds a credential carrying a `lockedUntil`, via the optional hook. */
    const seedWithLockedUntil = async (lockedUntil: string, failedLoginAttempts = 0) => {
      const userId = await fx.makeUserId();
      const passwordHash = hash();
      const now = new Date().toISOString();
      await fx.seedCredential({
        userId,
        passwordHash,
        passwordUpdatedAt: now,
        failedLoginAttempts,
        lockedUntil,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, passwordHash };
    };

    const notChanged = (after: CredentialRecord, before: CredentialRecord) => {
      assert.equal(after.passwordHash === before.passwordHash, true, "hash unchanged");
      assert.equal(after.failedLoginAttempts, before.failedLoginAttempts);
      assert.equal(Date.parse(after.passwordUpdatedAt), Date.parse(before.passwordUpdatedAt));
      assert.equal(after.lockedUntil === undefined, before.lockedUntil === undefined);
    };

    beforeEach(async () => {
      fx = await makeFixture();
      await fx.reset();
      repo = fx.repository;
    });

    afterEach(async () => {
      await fx.reset();
    });

    // --- findByUserId / create ----------------------------------------------------------

    describe("findByUserId", () => {
      it("returns null - not a throw - when the user has no credential", async () => {
        assert.equal(await repo.findByUserId(missingId()), null);
        assert.equal(await repo.findByUserId(await fx.makeUserId()), null);
      });

      it("returns the stored credential", async () => {
        const { userId, credential } = await withCredential();
        assert.deepEqual(await repo.findByUserId(userId), credential);
      });

      it("returns detached copies", async () => {
        const { userId } = await withCredential();
        const read = await stored(userId);
        read.failedLoginAttempts = 99;
        assert.equal((await stored(userId)).failedLoginAttempts, 0);
      });
    });

    describe("create", () => {
      it("stores the hash with a clean counter, no lockout and adapter-set timestamps", async () => {
        const before = Date.now();
        const { userId, passwordHash, credential } = await withCredential();

        assert.equal(credential.userId, userId);
        assert.equal(credential.passwordHash === passwordHash, true, "stores the given hash");
        assert.equal(credential.failedLoginAttempts, 0);
        assert.equal(credential.lockedUntil, undefined);
        assert.equal(credential.lastFailedLoginAt, undefined);
        for (const field of ["passwordUpdatedAt", "createdAt", "updatedAt"] as const) {
          assert.ok(Date.parse(credential[field]) >= before - 1000, `${field} set to now`);
        }
      });

      it("allows exactly one credential per user (DuplicateRecordError on 'userId')", async () => {
        const { userId, credential } = await withCredential();
        await assert.rejects(repo.create({ userId, passwordHash: hash() }), (error: unknown) => {
          assert.ok(error instanceof DuplicateRecordError);
          assert.ok(error instanceof RepositoryError);
          assert.equal(error.field, "userId");
          return true;
        });
        notChanged(await stored(userId), credential);
      });

      it("concurrent creates for one user: exactly one succeeds (fake: ordering only)", async () => {
        const userId = await fx.makeUserId();
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () => repo.create({ userId, passwordHash: hash() })),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (const r of results) {
          if (r.status === "rejected") assert.ok(r.reason instanceof DuplicateRecordError);
        }
      });
    });

    // --- recordFailedAttempt (ATOMIC) -------------------------------------------------------

    describe("recordFailedAttempt", () => {
      it("increments by one and reports remaining attempts", async () => {
        const { userId } = await withCredential();
        const state = await repo.recordFailedAttempt({ userId, threshold: THRESHOLD });

        assert.equal(state.failedLoginAttempts, 1);
        assert.equal(state.isLocked, false);
        assert.equal(state.remainingAttempts, THRESHOLD - 1);
        assert.equal("passwordHash" in state, false, "lockout state never carries the hash");

        const record = await stored(userId);
        assert.equal(record.failedLoginAttempts, 1);
        assert.ok(record.lastFailedLoginAt !== undefined, "lastFailedLoginAt recorded");
      });

      it("locks at exactly the threshold, not before", async () => {
        const { userId } = await withCredential();
        await fail(userId, THRESHOLD - 1);
        const almost = await stored(userId);
        assert.equal(almost.failedLoginAttempts, THRESHOLD - 1);

        const state = await repo.recordFailedAttempt({ userId, threshold: THRESHOLD });
        assert.equal(state.failedLoginAttempts, THRESHOLD);
        assert.equal(state.isLocked, true);
        assert.equal(state.remainingAttempts, 0);
      });

      it("keeps counting past the threshold and stays locked", async () => {
        const { userId } = await withCredential();
        await fail(userId, THRESHOLD);
        const state = await repo.recordFailedAttempt({ userId, threshold: THRESHOLD });
        assert.equal(state.failedLoginAttempts, THRESHOLD + 1);
        assert.equal(state.isLocked, true);
        assert.equal(state.remainingAttempts, 0);
      });

      it("never sets lockedUntil (lockout is counter-based and permanent)", async () => {
        const { userId } = await withCredential();
        const state = await repo.recordFailedAttempt({ userId, threshold: 1 });
        assert.equal(state.isLocked, true);
        assert.equal(state.lockedUntil, undefined);
        assert.equal((await stored(userId)).lockedUntil, undefined);
      });

      it("does not change the hash or passwordUpdatedAt", async () => {
        const { userId, credential } = await withCredential();
        await fail(userId, 2);
        const after = await stored(userId);
        assert.equal(after.passwordHash === credential.passwordHash, true);
        assert.equal(Date.parse(after.passwordUpdatedAt), Date.parse(credential.passwordUpdatedAt));
      });

      it("throws RecordNotFoundError when the user has no credential", async () => {
        await assert.rejects(
          repo.recordFailedAttempt({ userId: missingId(), threshold: THRESHOLD }),
          RecordNotFoundError,
        );
      });

      it("CONCURRENT failures lose no increments (20 parallel -> 20)", async () => {
        const { userId } = await withCredential();
        const states = await Promise.all(
          Array.from({ length: 20 }, () => repo.recordFailedAttempt({ userId, threshold: THRESHOLD })),
        );
        assert.equal((await stored(userId)).failedLoginAttempts, 20);
        // Each call observed a distinct post-increment value: no two read the same counter.
        assert.deepEqual(
          states.map((s) => s.failedLoginAttempts).sort((a, b) => a - b),
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
      });

      it("CONCURRENT failures lock at exactly the threshold", async () => {
        const { userId } = await withCredential();
        const states = await Promise.all(
          Array.from({ length: 10 }, () => repo.recordFailedAttempt({ userId, threshold: THRESHOLD })),
        );
        assert.equal(states.filter((s) => !s.isLocked).length, THRESHOLD - 1);
        assert.equal(states.filter((s) => s.isLocked).length, 10 - (THRESHOLD - 1));
      });

      it("only touches the target user's credential", async () => {
        const a = await withCredential();
        const b = await withCredential();
        await fail(a.userId, 3);
        assert.equal((await stored(b.userId)).failedLoginAttempts, 0);
      });
    });

    // --- resetFailedAttemptsIfAuthorized (ATOMIC, guarded) ----------------------------------

    describe("resetFailedAttemptsIfAuthorized", () => {
      it("reset: zeroes the counter when unlocked and the hash is acceptable", async () => {
        const { userId, passwordHash } = await withCredential();
        await fail(userId, THRESHOLD - 1);

        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [passwordHash],
        });
        assert.equal(result.status, "reset");
        assert.ok(result.status === "reset");
        assert.equal(result.credential.failedLoginAttempts, 0);
        assert.equal((await stored(userId)).failedLoginAttempts, 0);
      });

      it("reset: any of several acceptable hashes matches (rehash window)", async () => {
        const { userId, passwordHash } = await withCredential();
        await fail(userId, 2);
        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [hash(), passwordHash],
        });
        assert.equal(result.status, "reset");
      });

      it("reset: does not change the hash or passwordUpdatedAt", async () => {
        const { userId, passwordHash, credential } = await withCredential();
        await repo.resetFailedAttemptsIfAuthorized({ userId, threshold: THRESHOLD, acceptableHashes: [passwordHash] });
        const after = await stored(userId);
        assert.equal(after.passwordHash === passwordHash, true);
        assert.equal(Date.parse(after.passwordUpdatedAt), Date.parse(credential.passwordUpdatedAt));
      });

      it("locked: at the threshold nothing is written - a correct password never unlocks", async () => {
        const { userId, passwordHash } = await withCredential();
        await fail(userId, THRESHOLD);
        const before = await stored(userId);

        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [passwordHash],
        });
        assert.equal(result.status, "locked");
        assert.ok(result.status === "locked");
        assert.equal(result.credential.failedLoginAttempts, THRESHOLD);
        notChanged(await stored(userId), before);
      });

      it("locked: a future lockedUntil blocks the reset and survives it", async () => {
        const lockedUntil = iso(HOUR);
        const { userId, passwordHash } = await seedWithLockedUntil(lockedUntil, 2);

        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [passwordHash],
        });
        assert.equal(result.status, "locked");
        const after = await stored(userId);
        assert.equal(after.failedLoginAttempts, 2);
        assert.equal(Date.parse(after.lockedUntil!), Date.parse(lockedUntil));
      });

      it("an ELAPSED lockedUntil does not block the reset", async () => {
        const { userId, passwordHash } = await seedWithLockedUntil(iso(-HOUR), 2);
        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [passwordHash],
        });
        assert.equal(result.status, "reset");
        assert.equal((await stored(userId)).failedLoginAttempts, 0);
      });

      it("password_changed: a stale hash leaves the counter alone and returns no credential", async () => {
        const { userId } = await withCredential();
        await fail(userId, 2);
        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [hash()],
        });
        assert.deepEqual(result, { status: "password_changed" });
        assert.equal((await stored(userId)).failedLoginAttempts, 2);
      });

      it("password_changed: an empty acceptable list never resets", async () => {
        const { userId } = await withCredential();
        await fail(userId, 1);
        const result = await repo.resetFailedAttemptsIfAuthorized({ userId, threshold: THRESHOLD, acceptableHashes: [] });
        assert.equal(result.status, "password_changed");
        assert.equal((await stored(userId)).failedLoginAttempts, 1);
      });

      it("locked AND stale hash: refused (which refusal is not asserted) and nothing written", async () => {
        const { userId } = await withCredential();
        await fail(userId, THRESHOLD);
        const before = await stored(userId);
        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [hash()],
        });
        assert.notEqual(result.status, "reset");
        notChanged(await stored(userId), before);
      });

      it("not_found: returns a result, not a throw", async () => {
        const result = await repo.resetFailedAttemptsIfAuthorized({
          userId: missingId(),
          threshold: THRESHOLD,
          acceptableHashes: [hash()],
        });
        assert.deepEqual(result, { status: "not_found" });
      });

      for (const order of ["failure first", "reset first"] as const) {
        it(`CONCURRENT with a threshold-reaching failure (${order}): the lockout is never erased`, async () => {
          const { userId, passwordHash } = await withCredential();
          await fail(userId, THRESHOLD - 1);

          const failure = () => repo.recordFailedAttempt({ userId, threshold: THRESHOLD });
          const reset = () =>
            repo.resetFailedAttemptsIfAuthorized({ userId, threshold: THRESHOLD, acceptableHashes: [passwordHash] });

          const [state, result] =
            order === "failure first"
              ? await Promise.all([failure(), reset()])
              : await Promise.all([reset(), failure()]).then(([r, s]) => [s, r] as const);

          const final = (await stored(userId)).failedLoginAttempts;
          if (state.isLocked) {
            // The failure landed first and locked the account: the reset
            // must have been refused and the lock must survive.
            assert.equal(state.failedLoginAttempts, THRESHOLD);
            assert.equal(result.status, "locked");
            assert.equal(final, THRESHOLD);
          } else {
            // The reset landed first; the failure then counted from zero.
            assert.equal(result.status, "reset");
            assert.equal(state.failedLoginAttempts, 1);
            assert.equal(final, 1);
          }
        });
      }
    });

    // --- password-hash comparison is CASE-SENSITIVE ----------------------------------------
    //
    // A hash is case-significant (base64 / PHC text). If the adapter compared
    // it under a case-insensitive collation (Q-CR2), a hash differing only in
    // letter case would satisfy a compare-and-set or the reset guard. Every
    // assertion here compares by boolean or status, so a failure never prints
    // a hash value.

    describe("password-hash case sensitivity", () => {
      /** Inverts the case of every letter; the result differs only by case. */
      const swapCase = (value: string): string =>
        [...value].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
      const mixedCaseHash = (): string => `Contract-Hash-${hash()}-AbCdEfXyZ`;

      /** A credential whose stored hash has letters in both cases, plus its case-swapped twin. */
      const withMixedCaseCredential = async () => {
        const passwordHash = mixedCaseHash();
        const { userId } = await withCredential(passwordHash);
        const caseVariant = swapCase(passwordHash);
        assert.equal(caseVariant !== passwordHash, true, "variant differs");
        assert.equal(caseVariant.toLowerCase() === passwordHash.toLowerCase(), true, "variant differs ONLY by case");
        return { userId, passwordHash, caseVariant };
      };

      it("stores the hash with its exact letter case", async () => {
        const { userId, passwordHash, caseVariant } = await withMixedCaseCredential();
        const record = await stored(userId);
        assert.equal(record.passwordHash === passwordHash, true, "stored hash preserves case");
        assert.equal(record.passwordHash === caseVariant, false, "stored hash is not the case variant");
      });

      it("changePassword: a case-only variant of the current hash fails the compare-and-set", async () => {
        const { userId, passwordHash, caseVariant } = await withMixedCaseCredential();
        await fail(userId, 1);
        const before = await stored(userId);

        await assert.rejects(
          repo.changePassword({ userId, expectedCurrentHash: caseVariant, newPasswordHash: hash() }),
          (error: unknown) => error instanceof OptimisticLockError,
        );
        notChanged(await stored(userId), before);

        // Control: the exact-case hash still succeeds, so the refusal above was about case.
        await repo.changePassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() });
      });

      it("rehashPassword: a case-only variant of the current hash fails the compare-and-set", async () => {
        const { userId, passwordHash, caseVariant } = await withMixedCaseCredential();
        await assert.rejects(
          repo.rehashPassword({ userId, expectedCurrentHash: caseVariant, newPasswordHash: hash() }),
          (error: unknown) => error instanceof OptimisticLockError,
        );
        assert.equal((await stored(userId)).passwordHash === passwordHash, true, "hash unchanged");
        await repo.rehashPassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() });
      });

      it("resetFailedAttemptsIfAuthorized: a case-only variant is not an acceptable hash", async () => {
        const { userId, passwordHash, caseVariant } = await withMixedCaseCredential();
        await fail(userId, 2);

        const refused = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [caseVariant],
        });
        assert.equal(refused.status, "password_changed");
        assert.equal((await stored(userId)).failedLoginAttempts, 2, "counter untouched");

        const accepted = await repo.resetFailedAttemptsIfAuthorized({
          userId,
          threshold: THRESHOLD,
          acceptableHashes: [passwordHash],
        });
        assert.equal(accepted.status, "reset");
      });
    });

    // --- changePassword (CAS) -------------------------------------------------------------

    describe("changePassword", () => {
      it("replaces the hash, stamps passwordUpdatedAt and resets the counter", async () => {
        const { userId, passwordHash, credential } = await withCredential();
        await fail(userId, 2);
        const newHash = hash();

        const updated = await repo.changePassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: newHash });
        assert.equal(updated.passwordHash === newHash, true);
        assert.equal(updated.failedLoginAttempts, 0);
        assert.equal(updated.lockedUntil, undefined);
        assert.ok(Date.parse(updated.passwordUpdatedAt) >= Date.parse(credential.passwordUpdatedAt));
        assert.deepEqual(await stored(userId), updated);
      });

      it("clears a counter-based lockout", async () => {
        const { userId, passwordHash } = await withCredential();
        await fail(userId, THRESHOLD);
        const updated = await repo.changePassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() });
        assert.equal(updated.failedLoginAttempts, 0);
      });

      it("clears a lockedUntil", async () => {
        const { userId, passwordHash } = await seedWithLockedUntil(iso(HOUR), THRESHOLD);
        const updated = await repo.changePassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() });
        assert.equal(updated.lockedUntil, undefined);
        assert.equal((await stored(userId)).lockedUntil, undefined);
      });

      it("OptimisticLockError when expectedCurrentHash is stale, and nothing is written", async () => {
        const { userId, credential } = await withCredential();
        await fail(userId, 1);
        const before = await stored(userId);
        await assert.rejects(
          repo.changePassword({ userId, expectedCurrentHash: hash(), newPasswordHash: hash() }),
          (error: unknown) => {
            assert.ok(error instanceof OptimisticLockError);
            assert.ok(error instanceof RepositoryError);
            return true;
          },
        );
        notChanged(await stored(userId), before);
        assert.equal((await stored(userId)).passwordHash === credential.passwordHash, true);
      });

      it("RecordNotFoundError when the user has no credential", async () => {
        await assert.rejects(
          repo.changePassword({ userId: missingId(), expectedCurrentHash: hash(), newPasswordHash: hash() }),
          RecordNotFoundError,
        );
      });

      it("CONCURRENT changes from the same hash: exactly one wins, the loser writes nothing", async () => {
        const { userId, passwordHash } = await withCredential();
        const candidates = [hash(), hash(), hash()];
        const results = await Promise.allSettled(
          candidates.map((newPasswordHash) =>
            repo.changePassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash }),
          ),
        );
        const winners = results.filter((r) => r.status === "fulfilled");
        assert.equal(winners.length, 1);
        for (const r of results) {
          if (r.status === "rejected") assert.ok(r.reason instanceof OptimisticLockError);
        }
        const winner = (winners[0] as PromiseFulfilledResult<CredentialRecord>).value;
        assert.equal((await stored(userId)).passwordHash === winner.passwordHash, true, "stored hash is the winner's");
      });
    });

    // --- rehashPassword (CAS, storage upgrade only) ----------------------------------------

    describe("rehashPassword", () => {
      it("replaces ONLY the hash: passwordUpdatedAt and the counter are untouched", async () => {
        const { userId, passwordHash, credential } = await withCredential();
        await fail(userId, 2);
        const newHash = hash();

        const updated = await repo.rehashPassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: newHash });
        assert.equal(updated.passwordHash === newHash, true);
        assert.equal(Date.parse(updated.passwordUpdatedAt), Date.parse(credential.passwordUpdatedAt));
        assert.equal(updated.failedLoginAttempts, 2);
        assert.equal((await stored(userId)).passwordHash === newHash, true);
      });

      it("does not clear a counter-based lockout", async () => {
        const { userId, passwordHash } = await withCredential();
        await fail(userId, THRESHOLD);
        const updated = await repo.rehashPassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() });
        assert.equal(updated.failedLoginAttempts, THRESHOLD);
      });

      it("does not clear a lockedUntil", async () => {
        const lockedUntil = iso(HOUR);
        const { userId, passwordHash } = await seedWithLockedUntil(lockedUntil);
        await repo.rehashPassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() });
        assert.equal(Date.parse((await stored(userId)).lockedUntil!), Date.parse(lockedUntil));
      });

      it("OptimisticLockError after a concurrent password change: the rehash is abandoned", async () => {
        const { userId, passwordHash } = await withCredential();
        const changedHash = hash();
        await repo.changePassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: changedHash });

        await assert.rejects(
          repo.rehashPassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() }),
          OptimisticLockError,
        );
        assert.equal((await stored(userId)).passwordHash === changedHash, true, "old password not reinstated");
      });

      it("RecordNotFoundError when the user has no credential", async () => {
        await assert.rejects(
          repo.rehashPassword({ userId: missingId(), expectedCurrentHash: hash(), newPasswordHash: hash() }),
          RecordNotFoundError,
        );
      });

      it("CONCURRENT rehash and change from the same hash: exactly one wins", async () => {
        const { userId, passwordHash } = await withCredential();
        const results = await Promise.allSettled([
          repo.changePassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() }),
          repo.rehashPassword({ userId, expectedCurrentHash: passwordHash, newPasswordHash: hash() }),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        assert.ok(loser.reason instanceof OptimisticLockError);
      });
    });

    // --- resetPassword (no CAS) ----------------------------------------------------------

    describe("resetPassword", () => {
      it("sets the hash without the old one, stamps passwordUpdatedAt and resets the counter", async () => {
        const { userId, credential } = await withCredential();
        await fail(userId, THRESHOLD);
        const newHash = hash();

        const updated = await repo.resetPassword({ userId, newPasswordHash: newHash });
        assert.equal(updated.passwordHash === newHash, true);
        assert.equal(updated.failedLoginAttempts, 0, "a reset is the self-service unlock path");
        assert.equal(updated.lockedUntil, undefined);
        assert.ok(Date.parse(updated.passwordUpdatedAt) >= Date.parse(credential.passwordUpdatedAt));
        assert.deepEqual(await stored(userId), updated);
      });

      it("clears a lockedUntil", async () => {
        const { userId } = await seedWithLockedUntil(iso(HOUR), THRESHOLD);
        const updated = await repo.resetPassword({ userId, newPasswordHash: hash() });
        assert.equal(updated.lockedUntil, undefined);
      });

      it("RecordNotFoundError when the user has no credential", async () => {
        await assert.rejects(repo.resetPassword({ userId: missingId(), newPasswordHash: hash() }), RecordNotFoundError);
      });
    });

    // --- clearLockout ----------------------------------------------------------------------

    describe("clearLockout", () => {
      it("zeroes the counter without touching the hash", async () => {
        const { userId, passwordHash, credential } = await withCredential();
        await fail(userId, THRESHOLD + 2);
        const cleared = await repo.clearLockout(userId);
        assert.equal(cleared.failedLoginAttempts, 0);
        assert.equal(cleared.lockedUntil, undefined);
        assert.equal(cleared.passwordHash === passwordHash, true);
        assert.equal(Date.parse(cleared.passwordUpdatedAt), Date.parse(credential.passwordUpdatedAt));
        assert.equal((await stored(userId)).failedLoginAttempts, 0);
      });

      it("removes a lockedUntil", async () => {
        const { userId } = await seedWithLockedUntil(iso(HOUR), 1);
        const cleared = await repo.clearLockout(userId);
        assert.equal(cleared.lockedUntil, undefined);
        assert.equal(cleared.failedLoginAttempts, 0);
      });

      it("is idempotent: unlocking an unlocked credential succeeds", async () => {
        const { userId } = await withCredential();
        assert.equal((await repo.clearLockout(userId)).failedLoginAttempts, 0);
        assert.equal((await repo.clearLockout(userId)).failedLoginAttempts, 0);
      });

      it("RecordNotFoundError when the user has no credential", async () => {
        await assert.rejects(repo.clearLockout(missingId()), RecordNotFoundError);
      });
    });
  });
};
