import { createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";

import { env } from "../../config/env";
import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import { maskDestination, type OtpDeliveryPort } from "./otp.delivery";
import type { OtpChallengeRepository } from "./otp.repository";
import type { OtpPurpose } from "./otp.types";

/**
 * One-time passcode issue and verification.
 *
 * Application service only - no HTTP, no status codes, no `ApiError`. A
 * caller maps the returned reasons onto responses, exactly as
 * `registration.service.ts` is mapped by its controller.
 *
 * ===========================================================================
 * WHAT THIS SERVICE IS RESPONSIBLE FOR, AND WHAT IT IS NOT.
 *
 * IT OWNS: generating a passcode with a CSPRNG, hashing it under a server
 * key, storing the challenge, enforcing expiry, resend cooldown, resend
 * window limit and verification attempt ceiling, and comparing a presented
 * code in constant time.
 *
 * IT DOES NOT KNOW WHAT A STUDENT IS. It never touches `StudentRepository`,
 * never sets `isEmailVerified`, and never moves an account to
 * `pending_approval`. A successful `verify` means ONE thing: "this user
 * presented a valid, unexpired, unspent code for this purpose." Applying the
 * consequence is the caller's job.
 *
 * That split is deliberate. Verification and account state are different
 * decisions with different owners - the `accountState` mapping is still an
 * unconfirmed business rule - and folding them together here would make the
 * OTP flow impossible to reuse for password reset or 2FA later.
 * ===========================================================================
 */

// --- policy ----------------------------------------------------------------

/** Digits in a passcode. Six is what the frontend's OTP inputs expect. */
export const OTP_CODE_LENGTH = 6;

/**
 * How long a passcode stays valid. FIVE minutes.
 *
 * Long enough to find the mail, switch windows and type it; short enough
 * that a code read from an unattended screen is usually already dead.
 *
 * Five rather than ten is the approved policy, and it stands independently
 * of where challenges are stored: a shorter window is strictly safer, and
 * the only cost is that a student who leaves the tab for six minutes presses
 * Resend - which the 60-second cooldown allows almost immediately.
 *
 * A future SQL Server adapter should derive any row lifetime from THIS
 * constant rather than hard-coding a duration, so the application's expiry
 * check and the storage layer can never disagree.
 */
export const OTP_TTL_SECONDS = 5 * 60;

/**
 * Failed verification attempts allowed per challenge.
 *
 * With 10^6 codes, five guesses give a 1-in-200,000 chance per challenge.
 * The ceiling is what makes a six-digit secret defensible at all - without
 * it, the search space is small enough to exhaust.
 */
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

/** Minimum gap between two sends to the same user. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Sends allowed per user per window, cooldown aside. */
export const OTP_MAX_SENDS_PER_WINDOW = 5;

/** The window the send limit is measured over. */
export const OTP_SEND_WINDOW_SECONDS = 15 * 60;

// --- code generation and hashing -------------------------------------------

/**
 * The key passcode hashes are computed under.
 *
 * WHY A KEYED HMAC RATHER THAN A PLAIN DIGEST. A six-digit code has only
 * 10^6 possible values, so `sha256(code)` is reversible by brute force in
 * milliseconds: anyone who reads the challenge table learns every live
 * passcode. An HMAC under a key the database does not contain makes a stolen
 * table useless on its own.
 *
 * WHY NOT ARGON2, which the password service uses: argon2 is deliberately
 * slow (~120 ms, 46 MiB) to defend a long-lived secret against offline
 * attack. A passcode lives ten minutes behind a five-attempt ceiling, so the
 * threat argon2 answers does not apply, and paying its cost on every verify
 * and resend would be a self-inflicted denial of service.
 *
 * WHY DERIVED FROM JWT_SECRET RATHER THAN A NEW VARIABLE. Adding a required
 * `OTP_PEPPER` would make every existing production deployment fail to start
 * until it was set. HKDF with a distinct `info` label gives cryptographic
 * domain separation from token signing - the two keys cannot be used to
 * attack each other - with no new configuration. Set a dedicated variable
 * later if key rotation needs to be independent; `hashOtpCode` is the only
 * place that would change.
 *
 * A rotated `JWT_SECRET` invalidates every in-flight passcode. That is
 * correct, and the same already happens to access tokens.
 */
const OTP_PEPPER: Buffer = Buffer.from(
  hkdfSync("sha256", env.JWT_SECRET, "nexelvoria-otp-pepper", "otp-pepper-v1", 32),
);

/**
 * Generates a cryptographically random passcode.
 *
 * `randomInt` is used instead of `randomBytes` plus a modulo, because
 * `% 1000000` over raw bytes is biased: some codes become measurably more
 * likely, which shrinks the effective search space. `randomInt` draws
 * uniformly from the range.
 *
 * `Math.random()` would be unacceptable here - it is not a CSPRNG and its
 * output is predictable from previous values.
 *
 * Zero-padded, so "000123" is a real code and the space is the full 10^6.
 */
export const generateOtpCode = (): string =>
  String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, "0");

/** The stored representation of a passcode. Never reversible to the code. */
export const hashOtpCode = (code: string): string =>
  createHmac("sha256", OTP_PEPPER).update(code, "utf8").digest("hex");

/**
 * Constant-time comparison of a presented code against a stored hash.
 *
 * `===` on the hex strings would exit at the first differing character, and
 * the timing difference is measurable over many requests. `timingSafeEqual`
 * always compares the full buffer.
 *
 * The length guard is not redundant: `timingSafeEqual` THROWS on mismatched
 * lengths, so a malformed stored value would crash the request instead of
 * failing the comparison.
 */
export const matchesOtpHash = (code: string, storedHash: string): boolean => {
  const computed = Buffer.from(hashOtpCode(code), "utf8");
  const stored = Buffer.from(storedHash, "utf8");

  if (computed.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(computed, stored);
};

/** True for a well-formed passcode: exactly six ASCII digits. */
export const isWellFormedOtpCode = (value: unknown): value is string =>
  typeof value === "string" && new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`).test(value);

// --- results ---------------------------------------------------------------

/** Why a passcode could not be issued. INTERNAL; a caller maps these. */
export type OtpIssueFailureReason =
  /** A code was sent too recently. `retryAfterSeconds` says when to retry. */
  | "cooldown_active"
  /** The per-window send allowance is spent. */
  | "send_limit_reached"
  /** Stored, but the provider would not deliver it. Retryable. */
  | "delivery_failed"
  /** A repository failed. Retryable. */
  | "otp_unavailable";

export interface OtpIssueSuccess {
  /** When the code dies. Safe to show the student. */
  expiresAt: IsoDateTime;
  /** When a resend becomes allowed. Drives the UI's countdown. */
  resendAvailableAt: IsoDateTime;
  /** Masked destination, for display ("a***v@example.com"). */
  maskedDestination: string;
}

export type OtpIssueResult =
  | { outcome: "success"; data: OtpIssueSuccess }
  | {
      outcome: "failure";
      reason: OtpIssueFailureReason;
      /** Present for `cooldown_active` only. */
      retryAfterSeconds?: number;
    };

/** Why a verification failed. */
export type OtpVerifyFailureReason =
  /** No unconsumed challenge exists. The student must request one. */
  | "no_active_challenge"
  /** The challenge exists but its lifetime has passed. */
  | "expired"
  /** Too many wrong guesses. A new code is required. */
  | "attempt_limit_reached"
  /** Wrong code, or a code that is no longer the live one. */
  | "invalid_code"
  /** A repository failed. Retryable. */
  | "otp_unavailable";

export type OtpVerifyResult =
  | { outcome: "success" }
  | {
      outcome: "failure";
      reason: OtpVerifyFailureReason;
      /**
       * Guesses left on this challenge. Present for `invalid_code` only.
       *
       * Safe to show: the ceiling is public policy, and telling a student
       * "2 attempts remaining" prevents the confusion of a silent lockout.
       * It reveals nothing about the code itself.
       */
      attemptsRemaining?: number;
    };

// --- service ---------------------------------------------------------------

export interface OtpServiceDeps {
  challenges: OtpChallengeRepository;
  /** Email today. See `otp.types.ts` on Q3 and BR-014. */
  delivery: OtpDeliveryPort;
  /**
   * Injected clock, so expiry, cooldown and window tests do not sleep.
   * Defaults to the real one.
   */
  now?: () => Date;
}

export interface OtpIssueInput {
  userId: EntityId;
  purpose: OtpPurpose;
  /** Where to send it - resolved by the caller from the user record. */
  destination: string;
}

export interface OtpVerifyInput {
  userId: EntityId;
  purpose: OtpPurpose;
  /** The code as the student typed it. */
  code: unknown;
}

export interface OtpService {
  issue(input: OtpIssueInput): Promise<OtpIssueResult>;
  verify(input: OtpVerifyInput): Promise<OtpVerifyResult>;
}

export const createOtpService = (deps: OtpServiceDeps): OtpService => {
  const clock = deps.now ?? ((): Date => new Date());

  const secondsBetween = (from: Date, to: Date): number =>
    Math.ceil((to.getTime() - from.getTime()) / 1000);

  return {
    async issue(input: OtpIssueInput): Promise<OtpIssueResult> {
      const now = clock();
      const masked = maskDestination(input.destination);

      // --- 1. cooldown -------------------------------------------------
      // Checked before the window limit so a user who is merely impatient
      // is told to wait rather than told their allowance is gone.
      let latest;

      try {
        latest = await deps.challenges.findLatestByUser(input.userId, input.purpose);
      } catch (err) {
        logger.error("otp issue refused: could not read the latest challenge", {
          userId: input.userId,
          purpose: input.purpose,
          errorType: describeError(err),
        });

        return { outcome: "failure", reason: "otp_unavailable" };
      }

      if (latest !== null) {
        const earliestNextSend = new Date(
          new Date(latest.createdAt).getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000,
        );

        if (earliestNextSend > now) {
          return {
            outcome: "failure",
            reason: "cooldown_active",
            retryAfterSeconds: secondsBetween(now, earliestNextSend),
          };
        }
      }

      // --- 2. window allowance -----------------------------------------
      try {
        const since = new Date(
          now.getTime() - OTP_SEND_WINDOW_SECONDS * 1000,
        ).toISOString();

        const issued = await deps.challenges.countIssuedSince(
          input.userId,
          input.purpose,
          since,
        );

        if (issued >= OTP_MAX_SENDS_PER_WINDOW) {
          logger.warn("otp issue refused: send limit reached", {
            userId: input.userId,
            purpose: input.purpose,
            issued,
          });

          return { outcome: "failure", reason: "send_limit_reached" };
        }
      } catch (err) {
        logger.error("otp issue refused: could not count recent challenges", {
          userId: input.userId,
          purpose: input.purpose,
          errorType: describeError(err),
        });

        return { outcome: "failure", reason: "otp_unavailable" };
      }

      // --- 3. generate and STORE, then send ----------------------------
      // Order matters. Storing first means a delivery failure leaves an
      // unusable challenge, which is harmless. Sending first would risk
      // delivering a code that was never stored - the student would hold a
      // valid-looking passcode that can never verify.
      const code = generateOtpCode();
      const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000).toISOString();

      let challengeId: EntityId;

      try {
        const challenge = await deps.challenges.create({
          userId: input.userId,
          purpose: input.purpose,
          codeHash: hashOtpCode(code),
          destination: input.destination,
          expiresAt,
          // Same clock as `expiresAt` - see CreateOtpChallengeInput.
          createdAt: now.toISOString(),
        });

        challengeId = challenge.id;
      } catch (err) {
        logger.error("otp issue refused: challenge could not be stored", {
          userId: input.userId,
          purpose: input.purpose,
          errorType: describeError(err),
        });

        return { outcome: "failure", reason: "otp_unavailable" };
      }

      // --- 4. deliver ---------------------------------------------------
      let delivery;

      try {
        delivery = await deps.delivery.send({
          destination: input.destination,
          code,
          purpose: input.purpose,
          expiresInSeconds: OTP_TTL_SECONDS,
        });
      } catch (err) {
        // An adapter that throws is treated as a failed delivery, not a
        // crash: a provider outage must not take the request down.
        delivery = { delivered: false as const, reason: describeError(err) };
      }

      if (!delivery.delivered) {
        // Spend the challenge. The student never received this code, so
        // leaving it live would occupy the single active slot and block the
        // retry they are about to make.
        try {
          await deps.challenges.consume(challengeId, now.toISOString());
        } catch (err) {
          // Nothing more to do - it will expire on its own.
          logger.error("otp cleanup failed after a delivery failure", {
            challengeId,
            errorType: describeError(err),
          });
        }

        logger.error("otp issue failed: delivery was refused", {
          userId: input.userId,
          purpose: input.purpose,
          to: masked,
          channel: deps.delivery.channel,
          reason: delivery.reason,
        });

        return { outcome: "failure", reason: "delivery_failed" };
      }

      // Metadata only. The code is NOT logged - the development delivery
      // adapter is the single place that ever prints it.
      logger.info("otp issued", {
        userId: input.userId,
        purpose: input.purpose,
        to: masked,
        channel: deps.delivery.channel,
        expiresAt,
      });

      return {
        outcome: "success",
        data: {
          expiresAt,
          resendAvailableAt: new Date(
            now.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000,
          ).toISOString(),
          maskedDestination: masked,
        },
      };
    },

    async verify(input: OtpVerifyInput): Promise<OtpVerifyResult> {
      const now = clock();

      let challenge;

      try {
        challenge = await deps.challenges.findActiveByUser(input.userId, input.purpose);
      } catch (err) {
        logger.error("otp verification refused: could not read the challenge", {
          userId: input.userId,
          purpose: input.purpose,
          errorType: describeError(err),
        });

        return { outcome: "failure", reason: "otp_unavailable" };
      }

      if (challenge === null) {
        return { outcome: "failure", reason: "no_active_challenge" };
      }

      // --- expiry, before any comparison -------------------------------
      if (new Date(challenge.expiresAt) <= now) {
        logger.warn("otp verification refused: challenge expired", {
          userId: input.userId,
          purpose: input.purpose,
        });

        return { outcome: "failure", reason: "expired" };
      }

      // --- attempt ceiling ---------------------------------------------
      if (challenge.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        logger.warn("otp verification refused: attempt limit reached", {
          userId: input.userId,
          purpose: input.purpose,
          attempts: challenge.attempts,
        });

        return { outcome: "failure", reason: "attempt_limit_reached" };
      }

      // --- compare ------------------------------------------------------
      // A malformed code is treated as a wrong guess and COSTS AN ATTEMPT,
      // rather than being rejected for free. Free rejections would let an
      // attacker probe the endpoint's behaviour without consuming the
      // allowance that makes the short code safe. The cost is that a third
      // party who knows a user id can burn that user's attempts; the
      // account is never locked by it - a new code can always be requested.
      const presented = isWellFormedOtpCode(input.code) ? input.code : null;
      const correct = presented !== null && matchesOtpHash(presented, challenge.codeHash);

      if (!correct) {
        let attempts = challenge.attempts + 1;

        try {
          const updated = await deps.challenges.incrementAttempts(challenge.id);
          // Trust the stored value over the local guess: under concurrency
          // the database's post-increment count is authoritative.
          attempts = updated.attempts;
        } catch (err) {
          logger.error("otp attempt count could not be recorded", {
            challengeId: challenge.id,
            errorType: describeError(err),
          });
        }

        logger.warn("otp verification failed: incorrect code", {
          userId: input.userId,
          purpose: input.purpose,
          attempts,
          wellFormed: presented !== null,
        });

        return {
          outcome: "failure",
          reason: "invalid_code",
          attemptsRemaining: Math.max(0, OTP_MAX_VERIFY_ATTEMPTS - attempts),
        };
      }

      // --- spend it -----------------------------------------------------
      // The conditional consume is what enforces one-TIME use. If it reports
      // false, a concurrent request presenting the same valid code consumed
      // the challenge first, and THIS request must not also report success -
      // otherwise the caller would apply its side effect twice.
      let consumed: boolean;

      try {
        consumed = await deps.challenges.consume(challenge.id, now.toISOString());
      } catch (err) {
        logger.error("otp verification refused: challenge could not be consumed", {
          challengeId: challenge.id,
          errorType: describeError(err),
        });

        return { outcome: "failure", reason: "otp_unavailable" };
      }

      if (!consumed) {
        // Reported as `invalid_code` rather than its own reason: from the
        // client's side this code genuinely no longer works, and the right
        // action - request a new one - is the same.
        logger.warn("otp verification lost a race: the challenge was already consumed", {
          challengeId: challenge.id,
          userId: input.userId,
        });

        return { outcome: "failure", reason: "invalid_code", attemptsRemaining: 0 };
      }

      logger.info("otp verified", { userId: input.userId, purpose: input.purpose });

      return { outcome: "success" };
    },
  };
};
