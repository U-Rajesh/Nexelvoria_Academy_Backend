import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { OtpChallengeRepository } from "../../src/modules/auth/otp.repository";
import { fakeHash, isoIn, type OtpHarnessFactory } from "./harness";

const USER = "user-1";
const PURPOSE = "email_verification" as const;

const challengeInput = (overrides: Record<string, unknown> = {}) => ({
  userId: USER,
  purpose: PURPOSE,
  codeHash: fakeHash("123456"),
  destination: "student@test.local",
  expiresAt: isoIn(600),
  createdAt: new Date().toISOString(),
  ...overrides,
});

/**
 * The `otpChallenges` port contract.
 *
 * This port carries the strictest requirements of the five, because the
 * one-time-use guarantee and the attempt ceiling are what make a six-digit
 * secret defensible at all. See `database-handoff.md` section 16.3.
 */
export const describeOtpRepositoryContract = (
  label: string,
  makeHarness: OtpHarnessFactory,
): void => {
  describe(`OtpChallengeRepository contract [${label}]`, () => {
    const withRepo = async (
      fn: (repo: OtpChallengeRepository) => Promise<void>,
    ): Promise<void> => {
      const harness = await makeHarness();

      try {
        await fn(harness.repo);
      } finally {
        await harness.cleanup?.();
      }
    };

    describe("create", () => {
      it("starts a challenge unconsumed with no attempts", async () => {
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());

          assert.equal(challenge.attempts, 0);
          assert.equal(challenge.consumedAt, undefined);
          assert.ok(typeof challenge.id === "string" && challenge.id.length > 0);
        });
      });

      it("stores createdAt EXACTLY as supplied, never a database default", async () => {
        // handoff 16.3 contract 3. The cooldown and send window are measured
        // from createdAt while expiry comes from expiresAt; if the adapter
        // stamped its own createdAt (GETUTCDATE()), the two would come from
        // different clocks and server skew would make them disagree.
        await withRepo(async (repo) => {
          const createdAt = "2026-11-18T10:00:00.000Z";

          const challenge = await repo.create(challengeInput({ createdAt }));

          assert.equal(
            challenge.createdAt,
            createdAt,
            "createdAt must be the application's value, not the database's",
          );
        });
      });

      it("never stores the passcode itself, only the hash it was given", async () => {
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());

          const serialised = JSON.stringify(challenge);
          assert.ok(!serialised.includes("123456"), "a stored row must not contain the code");
        });
      });
    });

    describe("findActiveByUser", () => {
      it("returns null when the user has no challenge", async () => {
        await withRepo(async (repo) => {
          assert.equal(await repo.findActiveByUser("user-nobody", PURPOSE), null);
        });
      });

      it("RETURNS AN EXPIRED CHALLENGE - it must not filter by expiry", async () => {
        // Deliberate. The service has to tell "your code expired" apart from
        // "you have no code", because the two need different user actions.
        // An adapter that filtered on expiry collapses that distinction.
        await withRepo(async (repo) => {
          await repo.create(challengeInput({ expiresAt: isoIn(-60) }));

          const found = await repo.findActiveByUser(USER, PURPOSE);
          assert.ok(found !== null, "an expired but unconsumed challenge must still be returned");
        });
      });

      it("does not return a consumed challenge", async () => {
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());
          await repo.consume(challenge.id, new Date().toISOString());

          assert.equal(await repo.findActiveByUser(USER, PURPOSE), null);
        });
      });

      it("returns the NEWEST unconsumed challenge after a resend", async () => {
        await withRepo(async (repo) => {
          await repo.create(challengeInput({ codeHash: fakeHash("old") }));
          const fresh = await repo.create(challengeInput({ codeHash: fakeHash("new") }));

          const found = await repo.findActiveByUser(USER, PURPOSE);
          assert.equal(found?.id, fresh.id, "a superseded code must not be the active one");
        });
      });

      it("is scoped to the user", async () => {
        await withRepo(async (repo) => {
          await repo.create(challengeInput());

          assert.equal(await repo.findActiveByUser("user-2", PURPOSE), null);
        });
      });
    });

    describe("incrementAttempts", () => {
      it("returns the POST-increment value", async () => {
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());

          assert.equal((await repo.incrementAttempts(challenge.id)).attempts, 1);
          assert.equal((await repo.incrementAttempts(challenge.id)).attempts, 2);
        });
      });

      it("[concurrency] counts every overlapping attempt exactly once", async () => {
        // handoff 16.3 contract 1. A read-modify-write lets two guesses both
        // read 4 and both write 5, handing an attacker a free try past the
        // ceiling. Required SQL: UPDATE ... SET attempts = attempts + 1.
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());

          await Promise.all(
            Array.from({ length: 5 }, () => repo.incrementAttempts(challenge.id)),
          );

          const after = await repo.findActiveByUser(USER, PURPOSE);
          assert.equal(after?.attempts, 5, "five overlapping increments must total five");
        });
      });
    });

    describe("consume", () => {
      it("returns true the first time", async () => {
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());

          assert.equal(await repo.consume(challenge.id, new Date().toISOString()), true);
        });
      });

      it("returns FALSE the second time, rather than throwing or silently succeeding", async () => {
        // handoff 16.3 contract 2. This boolean is the entire one-time-use
        // guarantee: with an unconditional UPDATE, two requests presenting
        // the same valid code both succeed and the caller applies its side
        // effect twice.
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());
          const now = new Date().toISOString();

          assert.equal(await repo.consume(challenge.id, now), true);
          assert.equal(await repo.consume(challenge.id, now), false);
        });
      });

      it("records the consumedAt it was given", async () => {
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());
          const now = "2026-11-18T10:05:00.000Z";

          await repo.consume(challenge.id, now);

          // Re-read through the only available path: a consumed challenge is
          // no longer "active", so assert via the second consume failing.
          assert.equal(await repo.consume(challenge.id, now), false);
        });
      });

      it("[concurrency] EXACTLY ONE of several overlapping consumes wins", async () => {
        // The decisive test for a SQL adapter. Required form:
        //   UPDATE ... SET consumedAt = @now
        //   WHERE id = @id AND consumedAt IS NULL;  SELECT @@ROWCOUNT;
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());
          const now = new Date().toISOString();

          const results = await Promise.all(
            Array.from({ length: 4 }, () => repo.consume(challenge.id, now)),
          );

          assert.equal(
            results.filter((won) => won).length,
            1,
            "exactly one caller may consume a challenge",
          );
        });
      });
    });

    describe("countIssuedSince", () => {
      it("counts challenges at or after the instant", async () => {
        await withRepo(async (repo) => {
          const base = new Date("2026-11-18T10:00:00.000Z").getTime();

          await repo.create(
            challengeInput({ createdAt: new Date(base - 60_000).toISOString() }),
          );
          await repo.create(challengeInput({ createdAt: new Date(base).toISOString() }));
          await repo.create(
            challengeInput({ createdAt: new Date(base + 60_000).toISOString() }),
          );

          assert.equal(
            await repo.countIssuedSince(USER, PURPOSE, new Date(base).toISOString()),
            2,
            "the one before the window must not be counted",
          );
        });
      });

      it("counts consumed and expired challenges too", async () => {
        // The control exists to stop a mailbox being flooded, and a
        // delivered message costs the same whether its code was used.
        await withRepo(async (repo) => {
          const since = isoIn(-3600);

          const first = await repo.create(challengeInput());
          await repo.consume(first.id, new Date().toISOString());
          await repo.create(challengeInput({ expiresAt: isoIn(-60) }));

          assert.equal(await repo.countIssuedSince(USER, PURPOSE, since), 2);
        });
      });

      it("is scoped to the user, so one user cannot exhaust another's allowance", async () => {
        await withRepo(async (repo) => {
          await repo.create(challengeInput());
          await repo.create(challengeInput());

          assert.equal(await repo.countIssuedSince("user-2", PURPOSE, isoIn(-3600)), 0);
        });
      });
    });

    describe("findLatestByUser", () => {
      it("returns the newest challenge even when it is consumed", async () => {
        // Distinct from findActiveByUser: after a successful verification
        // the latest challenge IS consumed, and the resend cooldown must
        // still be honoured against it.
        await withRepo(async (repo) => {
          const challenge = await repo.create(challengeInput());
          await repo.consume(challenge.id, new Date().toISOString());

          const latest = await repo.findLatestByUser(USER, PURPOSE);
          assert.equal(latest?.id, challenge.id);
        });
      });

      it("returns null when the user has never been issued one", async () => {
        await withRepo(async (repo) => {
          assert.equal(await repo.findLatestByUser("user-nobody", PURPOSE), null);
        });
      });
    });

    describe("purgeExpiredBefore", () => {
      it("removes only challenges that expired before the instant", async () => {
        await withRepo(async (repo) => {
          const base = new Date("2026-11-18T10:00:00.000Z").getTime();

          await repo.create(
            challengeInput({ expiresAt: new Date(base - 1000).toISOString() }),
          );
          await repo.create(
            challengeInput({ expiresAt: new Date(base + 60_000).toISOString() }),
          );

          assert.equal(await repo.purgeExpiredBefore(new Date(base).toISOString()), 1);
        });
      });

      it("is a no-op returning 0 when nothing qualifies", async () => {
        await withRepo(async (repo) => {
          await repo.create(challengeInput());

          assert.equal(await repo.purgeExpiredBefore(isoIn(-3600)), 0);
        });
      });
    });
  });
};
