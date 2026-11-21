import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { SessionRepository } from "../../src/modules/auth/session.repository";
import { getSessionStatus } from "../../src/modules/auth/session.types";
import { fakeHash, isoIn, type SessionHarnessFactory } from "./harness";

const USER = "user-1";

/**
 * The `sessions` port contract.
 *
 * Sessions are what make revocation real: `authenticate` validates one on
 * every request, so a defect here silently reinstates stolen tokens. The port
 * requires rotation to be a compare-and-set and revocation to be idempotent
 * with first-reason-wins.
 */
export const describeSessionRepositoryContract = (
  label: string,
  makeHarness: SessionHarnessFactory,
): void => {
  describe(`SessionRepository contract [${label}]`, () => {
    const withRepo = async (
      fn: (repo: SessionRepository) => Promise<void>,
    ): Promise<void> => {
      const harness = await makeHarness();

      try {
        await fn(harness.repo);
      } finally {
        await harness.cleanup?.();
      }
    };

    const open = async (repo: SessionRepository, hash = fakeHash("rt-1")) =>
      repo.create({ userId: USER, refreshTokenHash: hash, expiresAt: isoIn(7 * 24 * 3600) });

    describe("create and read", () => {
      it("returns null for an unknown session id", async () => {
        await withRepo(async (repo) => {
          assert.equal(await repo.findBySessionId("sess-nobody"), null);
        });
      });

      it("opens an active session with its own family", async () => {
        await withRepo(async (repo) => {
          const session = await open(repo);

          assert.ok(typeof session.sessionId === "string" && session.sessionId.length > 0);
          assert.ok(
            typeof session.familyId === "string" && session.familyId.length > 0,
            "a fresh login must start a rotation family",
          );
          assert.equal(session.revokedAt, undefined);
          assert.equal(getSessionStatus(session), "active");
        });
      });

      it("continues an existing family when one is supplied", async () => {
        await withRepo(async (repo) => {
          const first = await open(repo);

          const continued = await repo.create({
            userId: USER,
            refreshTokenHash: fakeHash("rt-2"),
            expiresAt: isoIn(3600),
            familyId: first.familyId,
          });

          assert.equal(continued.familyId, first.familyId);
        });
      });

      it("stores no refresh token in plaintext, only the hash given", async () => {
        await withRepo(async (repo) => {
          const session = await open(repo, fakeHash("secret-token"));

          assert.equal(session.refreshTokenHash, fakeHash("secret-token"));
          assert.ok(!JSON.stringify(session).includes("secret-token"));
        });
      });

      it("reports an expired session as not active", async () => {
        await withRepo(async (repo) => {
          const session = await repo.create({
            userId: USER,
            refreshTokenHash: fakeHash("rt-old"),
            expiresAt: isoIn(-60),
          });

          assert.notEqual(getSessionStatus(session), "active");
        });
      });
    });

    describe("rotateRefreshToken", () => {
      it("replaces the hash when the expectation holds", async () => {
        await withRepo(async (repo) => {
          const session = await open(repo);

          const rotated = await repo.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: session.refreshTokenHash,
            newRefreshTokenHash: fakeHash("rt-2"),
          });

          assert.equal(rotated.refreshTokenHash, fakeHash("rt-2"));
          assert.equal(rotated.sessionId, session.sessionId, "the session continues");
          assert.equal(rotated.familyId, session.familyId, "the family continues");
        });
      });

      it("refuses a rotation presenting a stale hash", async () => {
        await withRepo(async (repo) => {
          const session = await open(repo);

          await assert.rejects(
            () =>
              repo.rotateRefreshToken({
                sessionId: session.sessionId,
                expectedCurrentHash: fakeHash("never-was-current"),
                newRefreshTokenHash: fakeHash("rt-2"),
              }),
            "a blind write would leave the loser's token silently valid",
          );
        });
      });

      it("[concurrency] EXACTLY ONE of two overlapping rotations succeeds", async () => {
        // The port's own words: otherwise "two refreshes arriving together
        // both read the same current hash and both write, leaving two live
        // refresh tokens for one session and making reuse detection
        // meaningless". The loser must fail (the service treats that like a
        // reused token and revokes the family).
        await withRepo(async (repo) => {
          const session = await open(repo);

          const results = await Promise.allSettled([
            repo.rotateRefreshToken({
              sessionId: session.sessionId,
              expectedCurrentHash: session.refreshTokenHash,
              newRefreshTokenHash: fakeHash("rt-A"),
            }),
            repo.rotateRefreshToken({
              sessionId: session.sessionId,
              expectedCurrentHash: session.refreshTokenHash,
              newRefreshTokenHash: fakeHash("rt-B"),
            }),
          ]);

          const won = results.filter((r) => r.status === "fulfilled").length;
          assert.equal(won, 1, "only one rotation may win a compare-and-set");
        });
      });

      it("the superseded hash no longer resolves to a usable token", async () => {
        await withRepo(async (repo) => {
          const session = await open(repo);

          await repo.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: session.refreshTokenHash,
            newRefreshTokenHash: fakeHash("rt-2"),
          });

          // Reuse detection depends on the OLD hash being recognisable as
          // consumed rather than simply unknown.
          const lookup = await repo.resolveRefreshToken(session.refreshTokenHash);
          assert.notEqual(
            lookup.status,
            "active",
            "a rotated-away token must never resolve as active",
          );
        });
      });
    });

    describe("revokeSession", () => {
      it("revokes an active session", async () => {
        await withRepo(async (repo) => {
          const session = await open(repo);

          const revoked = await repo.revokeSession({
            sessionId: session.sessionId,
            userId: USER,
            reason: "logout",
          });

          assert.ok(revoked.revokedAt !== undefined);
          assert.equal(revoked.revocationReason, "logout");
          assert.notEqual(getSessionStatus(revoked), "active");
        });
      });

      it("IS IDEMPOTENT - revoking twice is not an error", async () => {
        // Logout can be retried and two tabs can log out at once.
        await withRepo(async (repo) => {
          const session = await open(repo);

          await repo.revokeSession({
            sessionId: session.sessionId,
            userId: USER,
            reason: "logout",
          });

          await assert.doesNotReject(() =>
            repo.revokeSession({
              sessionId: session.sessionId,
              userId: USER,
              reason: "logout",
            }),
          );
        });
      });

      it("THE FIRST REASON WINS - a later logout must not overwrite token_reuse_detected", async () => {
        // The earlier reason is the security-relevant one. Overwriting it
        // loses the only record that a token was replayed.
        await withRepo(async (repo) => {
          const session = await open(repo);

          await repo.revokeSession({
            sessionId: session.sessionId,
            userId: USER,
            reason: "token_reuse_detected",
          });

          const after = await repo.revokeSession({
            sessionId: session.sessionId,
            userId: USER,
            reason: "logout",
          });

          assert.equal(
            after.revocationReason,
            "token_reuse_detected",
            "the first, security-relevant reason must survive",
          );
        });
      });

      it("is scoped by user: another user's id must not revoke this session", async () => {
        // Cross-user isolation lives in the repository so a service cannot
        // forget it.
        await withRepo(async (repo) => {
          const session = await open(repo);

          await assert.rejects(() =>
            repo.revokeSession({
              sessionId: session.sessionId,
              userId: "user-someone-else",
              reason: "logout",
            }),
          );

          const still = await repo.findBySessionId(session.sessionId);
          assert.equal(getSessionStatus(still!), "active", "the session must be untouched");
        });
      });
    });

    describe("revokeAllForUser", () => {
      it("revokes every active session and reports how many", async () => {
        await withRepo(async (repo) => {
          await open(repo, fakeHash("rt-1"));
          await open(repo, fakeHash("rt-2"));
          await open(repo, fakeHash("rt-3"));

          const count = await repo.revokeAllForUser({ userId: USER, reason: "logout_all" });

          assert.equal(count, 3);
        });
      });

      it("does not touch another user's sessions", async () => {
        await withRepo(async (repo) => {
          await open(repo);
          const other = await repo.create({
            userId: "user-2",
            refreshTokenHash: fakeHash("rt-other"),
            expiresAt: isoIn(3600),
          });

          await repo.revokeAllForUser({ userId: USER, reason: "logout_all" });

          const survivor = await repo.findBySessionId(other.sessionId);
          assert.equal(getSessionStatus(survivor!), "active");
        });
      });

      it("returns 0 rather than throwing when there is nothing to revoke", async () => {
        await withRepo(async (repo) => {
          assert.equal(
            await repo.revokeAllForUser({ userId: "user-nobody", reason: "logout_all" }),
            0,
          );
        });
      });
    });

    describe("updateLastActiveAt", () => {
      it("is fire-and-forget: it returns nothing and must not throw for a live session", async () => {
        // It runs on potentially every authenticated request, so it must be
        // the cheapest possible write and losing a race on it is harmless.
        await withRepo(async (repo) => {
          const session = await open(repo);

          const result = await repo.updateLastActiveAt(
            session.sessionId,
            new Date().toISOString(),
          );

          assert.equal(result, undefined);
        });
      });
    });

    describe("listSessionsForUser", () => {
      it("lists the user's sessions and nobody else's", async () => {
        await withRepo(async (repo) => {
          await open(repo, fakeHash("rt-1"));
          await open(repo, fakeHash("rt-2"));
          await repo.create({
            userId: "user-2",
            refreshTokenHash: fakeHash("rt-other"),
            expiresAt: isoIn(3600),
          });

          const sessions = await repo.listSessionsForUser(USER);

          assert.equal(sessions.length, 2);
          assert.ok(sessions.every((s) => s.userId === USER));
        });
      });

      it("exposes no plaintext token material", async () => {
        await withRepo(async (repo) => {
          await open(repo, fakeHash("super-secret"));

          const sessions = await repo.listSessionsForUser(USER);
          assert.ok(!JSON.stringify(sessions).includes("super-secret"));
        });
      });
    });
  });
};
