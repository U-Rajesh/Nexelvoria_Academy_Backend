import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionNotActiveError } from "../src/modules/auth/session.errors";
import type { Session } from "../src/modules/auth/session.types";
import { isSessionUsable } from "../src/modules/auth/session.types";
import { generateRefreshToken, hashRefreshToken } from "../src/modules/auth/token.service";
import {
  OptimisticLockError,
  RecordNotFoundError,
} from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";

/**
 * Step 6E security corrections.
 *
 * Two defects the backend lead identified:
 *
 *  1. Rotation replaced the refresh-token hash, so a replayed (already
 *     rotated) token was indistinguishable from one that never existed -
 *     while the port documented that reuse could be recognised. Code and
 *     documentation disagreed, and reuse detection was impossible.
 *
 *  2. Rotation checked only session existence and the current hash, not
 *     whether the session was still active - so a revoked or expired
 *     session could be rotated, and supplying a future `expiresAt` would
 *     silently resurrect a dead one.
 */

const USER_A = "user-a";

const future = (minutes = 60): string => new Date(Date.now() + minutes * 60_000).toISOString();
const past = (minutes = 60): string => new Date(Date.now() - minutes * 60_000).toISOString();

describe("refresh-token rotation security", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  /** Opens an active session and returns the raw token (never stored). */
  const open = async (
    userId = USER_A,
    overrides: { familyId?: string; expiresAt?: string } = {},
  ): Promise<{ session: Session; rawToken: string }> => {
    const generated = generateRefreshToken();

    const session = await h.sessions.create({
      userId,
      refreshTokenHash: generated.tokenHash,
      expiresAt: overrides.expiresAt ?? generated.expiresAt,
      ...(overrides.familyId === undefined ? {} : { familyId: overrides.familyId }),
    });

    return { session, rawToken: generated.token };
  };

  describe("issue 1 — reuse detection", () => {
    it("rotates successfully the first time", async () => {
      const { session, rawToken } = await open();
      const next = generateRefreshToken();

      const rotated = await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: hashRefreshToken(rawToken),
        newRefreshTokenHash: next.tokenHash,
        expiresAt: next.expiresAt,
      });

      assert.equal(rotated.refreshTokenHash, next.tokenHash);
      assert.equal(rotated.sessionId, session.sessionId);
      assert.equal(rotated.familyId, session.familyId, "family identity is preserved");
      assert.equal(rotated.revokedAt, undefined);
    });

    it("classifies an active, a consumed and an unknown token distinctly", async () => {
      const { session, rawToken } = await open();
      const next = generateRefreshToken();
      const oldHash = hashRefreshToken(rawToken);

      assert.equal((await h.sessions.resolveRefreshToken(oldHash)).status, "active");

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: oldHash,
        newRefreshTokenHash: next.tokenHash,
      });

      // THE FIX: previously this returned "unknown", so a replay was silent.
      assert.equal((await h.sessions.resolveRefreshToken(oldHash)).status, "consumed");
      assert.equal((await h.sessions.resolveRefreshToken(next.tokenHash)).status, "active");
      assert.equal(
        (await h.sessions.resolveRefreshToken(generateRefreshToken().tokenHash)).status,
        "unknown",
      );
      assert.equal((await h.sessions.resolveRefreshToken("")).status, "unknown");
    });

    it("associates a consumed token with its session, family and owner", async () => {
      const { session, rawToken } = await open();
      const oldHash = hashRefreshToken(rawToken);

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: oldHash,
        newRefreshTokenHash: generateRefreshToken().tokenHash,
      });

      const lookup = await h.sessions.resolveRefreshToken(oldHash);
      if (lookup.status !== "consumed") {
        assert.fail(`expected consumed, got ${lookup.status}`);
      }

      assert.equal(lookup.consumed.sessionId, session.sessionId);
      assert.equal(lookup.consumed.familyId, session.familyId);
      assert.equal(lookup.consumed.userId, USER_A);
      assert.ok(lookup.consumed.consumedAt);
      assert.ok(lookup.consumed.purgeAfter);
    });

    it("recognises a token consumed several generations ago", async () => {
      // Keeping only the previous hash would miss this: a replay need not be
      // of the immediately preceding token.
      const { session, rawToken } = await open();

      let currentHash = hashRefreshToken(rawToken);
      const retired: string[] = [];

      for (let i = 0; i < 4; i += 1) {
        const next = generateRefreshToken();
        await h.sessions.rotateRefreshToken({
          sessionId: session.sessionId,
          expectedCurrentHash: currentHash,
          newRefreshTokenHash: next.tokenHash,
        });
        retired.push(currentHash);
        currentHash = next.tokenHash;
      }

      assert.equal(retired.length, 4);

      for (const old of retired) {
        assert.equal(
          (await h.sessions.resolveRefreshToken(old)).status,
          "consumed",
          "every retired generation stays detectable",
        );
      }

      assert.equal((await h.sessions.resolveRefreshToken(currentHash)).status, "active");
    });

    it("an old token can never rotate again", async () => {
      const { session, rawToken } = await open();
      const legitimate = generateRefreshToken();
      const oldHash = hashRefreshToken(rawToken);

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: oldHash,
        newRefreshTokenHash: legitimate.tokenHash,
      });

      const attacker = generateRefreshToken();

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: oldHash,
            newRefreshTokenHash: attacker.tokenHash,
          }),
        OptimisticLockError,
        "a consumed token must never become usable again",
      );

      const current = await h.sessions.findBySessionId(session.sessionId);
      assert.equal(current?.refreshTokenHash, legitimate.tokenHash, "state is untouched");
      assert.equal(
        (await h.sessions.resolveRefreshToken(attacker.tokenHash)).status,
        "unknown",
        "the attacker's token was never installed",
      );
    });

    it("an old token cannot resolve a session for authentication", async () => {
      const { session, rawToken } = await open();
      const next = generateRefreshToken();

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: hashRefreshToken(rawToken),
        newRefreshTokenHash: next.tokenHash,
      });

      // findByRefreshTokenHash matches only the CURRENT hash.
      assert.equal(await h.sessions.findByRefreshTokenHash(hashRefreshToken(rawToken)), null);
      assert.ok(await h.sessions.findByRefreshTokenHash(next.tokenHash));
    });

    it("supports the documented family revocation after reuse", async () => {
      // Models what a future refresh service must do. No refresh service or
      // endpoint exists; this only proves the primitives support it.
      const root = await open();
      await open(USER_A, { familyId: root.session.familyId });

      const stolenHash = hashRefreshToken(root.rawToken);
      const next = generateRefreshToken();

      await h.sessions.rotateRefreshToken({
        sessionId: root.session.sessionId,
        expectedCurrentHash: stolenHash,
        newRefreshTokenHash: next.tokenHash,
      });

      const lookup = await h.sessions.resolveRefreshToken(stolenHash);
      if (lookup.status !== "consumed") {
        assert.fail("expected the replayed token to be recognised");
      }

      const revokedCount = await h.sessions.revokeSessionFamily({
        familyId: lookup.consumed.familyId,
        reason: "token_reuse_detected",
      });

      assert.equal(revokedCount, 2, "the whole family goes, not just the presented row");

      const after = await h.sessions.findBySessionId(root.session.sessionId);
      assert.equal(after?.revocationReason, "token_reuse_detected");
      assert.equal(isSessionUsable(after as Session), false);

      // The token the attacker just obtained is dead as well.
      const post = await h.sessions.resolveRefreshToken(next.tokenHash);
      assert.equal(post.status, "active", "still the current hash");
      if (post.status === "active") {
        assert.equal(isSessionUsable(post.session), false, "but the session is revoked");
      }
    });

    it("concurrent rotation: exactly one wins, the loser is rejected", async () => {
      const { session, rawToken } = await open();
      const sharedHash = hashRefreshToken(rawToken);

      const a = generateRefreshToken();
      const b = generateRefreshToken();

      const results = await Promise.allSettled([
        h.sessions.rotateRefreshToken({
          sessionId: session.sessionId,
          expectedCurrentHash: sharedHash,
          newRefreshTokenHash: a.tokenHash,
        }),
        h.sessions.rotateRefreshToken({
          sessionId: session.sessionId,
          expectedCurrentHash: sharedHash,
          newRefreshTokenHash: b.tokenHash,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 1, "exactly one rotation may succeed");
      assert.equal(rejected.length, 1, "the loser must be rejected, never silently accepted");

      const loser = rejected[0];
      if (loser?.status === "rejected") {
        assert.ok(
          loser.reason instanceof OptimisticLockError,
          "the loser gets OptimisticLockError, handled exactly like reuse",
        );
      }

      const current = await h.sessions.findBySessionId(session.sessionId);
      const installed = [a.tokenHash, b.tokenHash].filter(
        (hash) => current?.refreshTokenHash === hash,
      );

      assert.equal(installed.length, 1, "only one new hash is installed");
      assert.equal(
        (await h.sessions.resolveRefreshToken(sharedHash)).status,
        "consumed",
        "the shared original is consumed exactly once",
      );
    });
  });

  describe("issue 2 — rotation rejects inactive sessions", () => {
    it("rejects a revoked session with SessionNotActiveError", async () => {
      const { session, rawToken } = await open();

      await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: hashRefreshToken(rawToken),
            newRefreshTokenHash: generateRefreshToken().tokenHash,
          }),
        (err: unknown) => {
          assert.ok(err instanceof SessionNotActiveError);
          assert.equal(err.status, "revoked");
          assert.equal(err.revocationReason, "logout");
          return true;
        },
      );
    });

    it("rejects an expired session with SessionNotActiveError", async () => {
      const { session, rawToken } = await open(USER_A, { expiresAt: past(1) });

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: hashRefreshToken(rawToken),
            newRefreshTokenHash: generateRefreshToken().tokenHash,
          }),
        (err: unknown) => {
          assert.ok(err instanceof SessionNotActiveError);
          assert.equal(err.status, "expired");
          assert.equal(err.revocationReason, undefined);
          return true;
        },
      );
    });

    it("rejects an unknown session with RecordNotFoundError", async () => {
      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: "session-nope",
            expectedCurrentHash: "irrelevant",
            newRefreshTokenHash: generateRefreshToken().tokenHash,
          }),
        RecordNotFoundError,
      );
    });

    it("rejects an incorrect current hash on an active session", async () => {
      const { session } = await open();

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: hashRefreshToken("some-other-token"),
            newRefreshTokenHash: generateRefreshToken().tokenHash,
          }),
        OptimisticLockError,
      );
    });

    it("cannot resurrect an expired session with a future expiry", async () => {
      // The vulnerability this closes: the active check now runs before any
      // write, so a new expiresAt cannot revive a dead session.
      const { session, rawToken } = await open(USER_A, { expiresAt: past(1) });

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: hashRefreshToken(rawToken),
            newRefreshTokenHash: generateRefreshToken().tokenHash,
            expiresAt: future(60 * 24 * 30),
          }),
        SessionNotActiveError,
      );

      const after = await h.sessions.findBySessionId(session.sessionId);
      assert.equal(after?.expiresAt, session.expiresAt, "expiry must be unchanged");
      assert.equal(isSessionUsable(after as Session), false, "still dead");
    });

    it("cannot clear revocation by rotating", async () => {
      const { session, rawToken } = await open();

      await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "token_reuse_detected",
      });

      const next = generateRefreshToken();

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: hashRefreshToken(rawToken),
            newRefreshTokenHash: next.tokenHash,
            expiresAt: future(60 * 24),
          }),
        SessionNotActiveError,
      );

      const after = await h.sessions.findBySessionId(session.sessionId);
      assert.ok(after?.revokedAt, "revokedAt must survive");
      assert.equal(after?.revocationReason, "token_reuse_detected");
      assert.equal(
        after?.refreshTokenHash,
        hashRefreshToken(rawToken),
        "the hash must not have been replaced",
      );
      assert.equal(
        (await h.sessions.resolveRefreshToken(next.tokenHash)).status,
        "unknown",
        "the new token was never installed",
      );
    });

    it("reports session state in preference to a hash mismatch", async () => {
      // A revoked session must report its real state rather than a
      // misleading "wrong token" - the server log needs the truth.
      const { session } = await open();

      await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "account_suspended",
      });

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: "a-deliberately-wrong-hash",
            newRefreshTokenHash: generateRefreshToken().tokenHash,
          }),
        SessionNotActiveError,
      );
    });

    it("records no consumed token when rotation is rejected", async () => {
      const { session, rawToken } = await open();

      await h.sessions.revokeSession({
        sessionId: session.sessionId,
        userId: USER_A,
        reason: "logout",
      });

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: hashRefreshToken(rawToken),
            newRefreshTokenHash: generateRefreshToken().tokenHash,
          }),
        SessionNotActiveError,
      );

      assert.equal(h.sessions.consumedCount, 0, "a failed rotation must consume nothing");
    });
  });

  describe("consumed-token retention and cleanup", () => {
    it("sets purgeAfter to the retired token's own expiry", async () => {
      const { session, rawToken } = await open();
      const oldHash = hashRefreshToken(rawToken);

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: oldHash,
        newRefreshTokenHash: generateRefreshToken().tokenHash,
      });

      const lookup = await h.sessions.resolveRefreshToken(oldHash);
      if (lookup.status !== "consumed") {
        assert.fail("expected a consumed record");
      }

      assert.equal(lookup.consumed.purgeAfter, session.expiresAt);
    });

    it("purges only records past the cutoff", async () => {
      const { session, rawToken } = await open(USER_A, { expiresAt: future(1) });
      const oldHash = hashRefreshToken(rawToken);

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: oldHash,
        newRefreshTokenHash: generateRefreshToken().tokenHash,
      });

      assert.equal(h.sessions.consumedCount, 1);
      assert.equal(await h.sessions.purgeConsumedRefreshTokens(past(1)), 0, "nothing due yet");
      assert.equal(h.sessions.consumedCount, 1);

      assert.equal(await h.sessions.purgeConsumedRefreshTokens(future(120)), 1);
      assert.equal(h.sessions.consumedCount, 0);
    });

    it("a purged record degrades to unknown, never to usable", async () => {
      const { session, rawToken } = await open(USER_A, { expiresAt: future(1) });
      const oldHash = hashRefreshToken(rawToken);
      const installed = generateRefreshToken();

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: oldHash,
        newRefreshTokenHash: installed.tokenHash,
      });

      await h.sessions.purgeConsumedRefreshTokens(future(120));

      // Detection is lost; access is still denied.
      assert.equal((await h.sessions.resolveRefreshToken(oldHash)).status, "unknown");
      assert.equal(await h.sessions.findByRefreshTokenHash(oldHash), null);

      await assert.rejects(
        () =>
          h.sessions.rotateRefreshToken({
            sessionId: session.sessionId,
            expectedCurrentHash: oldHash,
            newRefreshTokenHash: generateRefreshToken().tokenHash,
          }),
        OptimisticLockError,
        "a purged old token is still unusable",
      );
    });

    it("stores no raw refresh token in consumed history", async () => {
      const { session, rawToken } = await open();
      const next = generateRefreshToken();
      const oldHash = hashRefreshToken(rawToken);

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: oldHash,
        newRefreshTokenHash: next.tokenHash,
      });

      const lookup = await h.sessions.resolveRefreshToken(oldHash);
      const serialised = JSON.stringify(lookup);

      assert.equal(serialised.includes(rawToken), false, "raw token must never be retained");
      assert.equal(serialised.includes(next.token), false);
      assert.ok(serialised.includes(oldHash), "only the verifier is kept");
    });

    it("reset() clears consumed history", async () => {
      const { session, rawToken } = await open();

      await h.sessions.rotateRefreshToken({
        sessionId: session.sessionId,
        expectedCurrentHash: hashRefreshToken(rawToken),
        newRefreshTokenHash: generateRefreshToken().tokenHash,
      });

      assert.equal(h.sessions.consumedCount, 1);
      h.reset();
      assert.equal(h.sessions.consumedCount, 0);
    });
  });
});
