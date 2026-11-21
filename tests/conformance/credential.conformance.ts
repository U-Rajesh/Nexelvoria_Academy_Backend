import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CredentialRepository } from "../../src/modules/auth/credential.repository";
import { RecordNotFoundError } from "../../src/repositories/repository.errors";
import { fakeHash, type CredentialHarnessFactory } from "./harness";

const USER = "user-1";
const THRESHOLD = 5;

/**
 * The `credentials` port contract.
 *
 * The most concurrency-sensitive port in the system. Its own file states the
 * required SQL - "One guarded UPDATE, never SELECT-then-UPDATE" - because a
 * read-modify-write here does not merely lose an update, it ERASES A LOCKOUT
 * and destroys the evidence that there was one.
 */
export const describeCredentialRepositoryContract = (
  label: string,
  makeHarness: CredentialHarnessFactory,
): void => {
  describe(`CredentialRepository contract [${label}]`, () => {
    const withRepo = async (
      fn: (repo: CredentialRepository) => Promise<void>,
    ): Promise<void> => {
      const harness = await makeHarness();

      try {
        await fn(harness.repo);
      } finally {
        await harness.cleanup?.();
      }
    };

    /** A credential for USER with a known hash. */
    const seed = async (repo: CredentialRepository, hash = fakeHash("original")) => {
      await repo.create({ userId: USER, passwordHash: hash });

      return hash;
    };

    describe("create and read", () => {
      it("findByUserId returns null for an unknown user", async () => {
        await withRepo(async (repo) => {
          assert.equal(await repo.findByUserId("user-nobody"), null);
        });
      });

      it("stores the hash verbatim - the adapter must not re-hash or transform it", async () => {
        // The PHC string carries the algorithm, its parameters and the salt.
        // Any transformation makes every later verification fail.
        await withRepo(async (repo) => {
          const hash = fakeHash("verbatim");
          await repo.create({ userId: USER, passwordHash: hash });

          assert.equal((await repo.findByUserId(USER))?.passwordHash, hash);
        });
      });

      it("starts with a zero failure counter and no lockout", async () => {
        await withRepo(async (repo) => {
          await seed(repo);

          const credential = await repo.findByUserId(USER);
          assert.equal(credential?.failedLoginAttempts, 0);
          assert.equal(credential?.lockedUntil, undefined);
        });
      });

      it("stamps passwordUpdatedAt, createdAt and updatedAt", async () => {
        await withRepo(async (repo) => {
          const credential = await repo.create({
            userId: USER,
            passwordHash: fakeHash("x"),
          });

          for (const field of ["passwordUpdatedAt", "createdAt", "updatedAt"] as const) {
            assert.ok(
              typeof credential[field] === "string" && credential[field].length > 0,
              `${field} must be set`,
            );
          }
        });
      });
    });

    describe("recordFailedAttempt", () => {
      it("increments the counter and reports the remaining attempts", async () => {
        await withRepo(async (repo) => {
          await seed(repo);

          const state = await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });

          assert.equal(state.failedLoginAttempts, 1);
          assert.equal(state.remainingAttempts, THRESHOLD - 1);
          assert.equal(state.isLocked, false);
        });
      });

      it("locks at the threshold and reports zero remaining", async () => {
        await withRepo(async (repo) => {
          await seed(repo);

          let state = await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });

          for (let i = 1; i < THRESHOLD; i += 1) {
            state = await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });
          }

          assert.equal(state.failedLoginAttempts, THRESHOLD);
          assert.equal(state.isLocked, true);
          assert.equal(state.remainingAttempts, 0);
        });
      });

      it("never reports a negative remaining count", async () => {
        await withRepo(async (repo) => {
          await seed(repo);

          let state = await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });

          for (let i = 0; i < THRESHOLD + 3; i += 1) {
            state = await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });
          }

          assert.equal(state.remainingAttempts, 0);
        });
      });

      it("[concurrency] counts every overlapping failure exactly once", async () => {
        // Must be one statement. A read-modify-write under load undercounts
        // failures, which means the lockout never trips.
        await withRepo(async (repo) => {
          await seed(repo);

          await Promise.all(
            Array.from({ length: THRESHOLD }, () =>
              repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD }),
            ),
          );

          const credential = await repo.findByUserId(USER);
          assert.equal(credential?.failedLoginAttempts, THRESHOLD);
        });
      });
    });

    describe("resetFailedAttemptsIfAuthorized", () => {
      it("resets the counter when the guard holds", async () => {
        await withRepo(async (repo) => {
          const hash = await seed(repo);
          await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });

          const result = await repo.resetFailedAttemptsIfAuthorized({
            userId: USER,
            threshold: THRESHOLD,
            acceptableHashes: [hash],
          });

          assert.equal(result.status, "reset");
          assert.equal((await repo.findByUserId(USER))?.failedLoginAttempts, 0);
        });
      });

      it("reports not_found for an unknown user rather than throwing", async () => {
        await withRepo(async (repo) => {
          const result = await repo.resetFailedAttemptsIfAuthorized({
            userId: "user-nobody",
            threshold: THRESHOLD,
            acceptableHashes: [fakeHash("x")],
          });

          assert.equal(result.status, "not_found");
        });
      });

      it("reports password_changed when the stored hash is not acceptable", async () => {
        await withRepo(async (repo) => {
          await seed(repo, fakeHash("current"));

          const result = await repo.resetFailedAttemptsIfAuthorized({
            userId: USER,
            threshold: THRESHOLD,
            acceptableHashes: [fakeHash("stale")],
          });

          assert.equal(result.status, "password_changed");
        });
      });

      it("WILL NOT UNLOCK a locked credential, even with the correct password", async () => {
        // Policy Q4a: a correct password must never clear a lockout. The
        // guard has to live in the same statement as the write, because a
        // read-then-write would already have destroyed the counter.
        await withRepo(async (repo) => {
          const hash = await seed(repo);

          for (let i = 0; i < THRESHOLD; i += 1) {
            await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });
          }

          const result = await repo.resetFailedAttemptsIfAuthorized({
            userId: USER,
            threshold: THRESHOLD,
            acceptableHashes: [hash],
          });

          assert.equal(result.status, "locked");

          const credential = await repo.findByUserId(USER);
          assert.equal(
            credential?.failedLoginAttempts,
            THRESHOLD,
            "the lockout must survive - the counter must NOT be reset",
          );
        });
      });

      it("writes nothing at all when the guard fails", async () => {
        await withRepo(async (repo) => {
          await seed(repo, fakeHash("current"));
          await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });

          await repo.resetFailedAttemptsIfAuthorized({
            userId: USER,
            threshold: THRESHOLD,
            acceptableHashes: [fakeHash("stale")],
          });

          assert.equal(
            (await repo.findByUserId(USER))?.failedLoginAttempts,
            1,
            "a failed guard must leave the counter untouched",
          );
        });
      });

      it("[concurrency] THE LOCKOUT-ERASURE RACE: a late success must not clear a lock", async () => {
        // The exact scenario the port documents:
        //   1. a correct-password login starts verifying (~120ms of argon2);
        //   2. a concurrent final failure lands  -> counter hits threshold;
        //   3. the successful login resets to 0  -> LOCK ERASED.
        // Interleaving the last failure with the reset must end LOCKED.
        await withRepo(async (repo) => {
          const hash = await seed(repo);

          for (let i = 0; i < THRESHOLD - 1; i += 1) {
            await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });
          }

          await Promise.all([
            repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD }),
            repo.resetFailedAttemptsIfAuthorized({
              userId: USER,
              threshold: THRESHOLD,
              acceptableHashes: [hash],
            }),
          ]);

          const credential = await repo.findByUserId(USER);
          assert.equal(
            credential?.failedLoginAttempts,
            THRESHOLD,
            "the account must remain locked; the reset must not have won",
          );
        });
      });
    });

    describe("changePassword", () => {
      it("is a compare-and-set: it replaces the hash when the expectation holds", async () => {
        await withRepo(async (repo) => {
          const original = await seed(repo);
          const next = fakeHash("next");

          const updated = await repo.changePassword({
            userId: USER,
            expectedCurrentHash: original,
            newPasswordHash: next,
          });

          assert.equal(updated.passwordHash, next);
        });
      });

      it("refuses when the expected hash is stale", async () => {
        await withRepo(async (repo) => {
          await seed(repo, fakeHash("current"));

          await assert.rejects(() =>
            repo.changePassword({
              userId: USER,
              expectedCurrentHash: fakeHash("stale"),
              newPasswordHash: fakeHash("next"),
            }),
          );
        });
      });

      it("resets the failure counter, because the password is now new", async () => {
        await withRepo(async (repo) => {
          const original = await seed(repo);
          await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });

          const updated = await repo.changePassword({
            userId: USER,
            expectedCurrentHash: original,
            newPasswordHash: fakeHash("next"),
          });

          assert.equal(updated.failedLoginAttempts, 0);
        });
      });

      it("throws RecordNotFoundError for an unknown user", async () => {
        await withRepo(async (repo) => {
          await assert.rejects(
            () =>
              repo.changePassword({
                userId: "user-nobody",
                expectedCurrentHash: fakeHash("x"),
                newPasswordHash: fakeHash("y"),
              }),
            (err: unknown) => err instanceof RecordNotFoundError,
          );
        });
      });
    });

    describe("rehashPassword", () => {
      it("MUST NOT advance passwordUpdatedAt - a rehash is not a password change", async () => {
        // Stamping it would make every user look as though they had just
        // changed their password, corrupting password-age reporting and any
        // expiry policy built on it.
        await withRepo(async (repo) => {
          const original = await seed(repo);
          const before = (await repo.findByUserId(USER))?.passwordUpdatedAt;

          const updated = await repo.rehashPassword({
            userId: USER,
            expectedCurrentHash: original,
            newPasswordHash: fakeHash("stronger"),
          });

          assert.equal(updated.passwordHash, fakeHash("stronger"));
          assert.equal(
            updated.passwordUpdatedAt,
            before,
            "passwordUpdatedAt must be unchanged by a rehash",
          );
        });
      });
    });

    describe("clearLockout", () => {
      it("zeroes the counter", async () => {
        await withRepo(async (repo) => {
          await seed(repo);

          for (let i = 0; i < THRESHOLD; i += 1) {
            await repo.recordFailedAttempt({ userId: USER, threshold: THRESHOLD });
          }

          const cleared = await repo.clearLockout(USER);
          assert.equal(cleared.failedLoginAttempts, 0);
        });
      });

      it("throws RecordNotFoundError for an unknown user", async () => {
        await withRepo(async (repo) => {
          await assert.rejects(
            () => repo.clearLockout("user-nobody"),
            (err: unknown) => err instanceof RecordNotFoundError,
          );
        });
      });
    });
  });
};
