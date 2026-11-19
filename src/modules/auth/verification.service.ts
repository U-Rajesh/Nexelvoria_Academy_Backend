import type { AccountState } from "../../contracts/user.contract";
import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import { deriveAccountState } from "../students/account-state";
import type { StudentRepository } from "../students/student.repository";
import type { UserRepository } from "../users/user.repository";
import { maskDestination } from "./otp.delivery";
import type { OtpService } from "./otp.service";

/**
 * Email verification for a newly registered student.
 *
 * ===========================================================================
 * WHAT THIS SERVICE IS FOR.
 *
 * `otp.service.ts` deliberately knows nothing about students: a successful
 * `verify` there means only "this user presented a valid, unspent code".
 * THIS service owns the consequence - marking the email confirmed and
 * reporting the resulting lifecycle state - and it is the only place the two
 * concerns meet.
 *
 * Keeping them apart is what lets the same OTP machinery back a password
 * reset or 2FA later without dragging student profile logic along.
 * ===========================================================================
 *
 * ===========================================================================
 * THIS IS NOT A LOGIN, AND DELIBERATELY ISSUES NO SESSION.
 *
 * The frontend mock it replaces did something different and unsafe: its
 * `verifyEmailOtp` returned the full `StudentProfile` and `AuthContext`
 * called `setUser(res.data)`, so possessing a six-digit code was enough to
 * become that student - no password required.
 *
 * This service returns a minimal status payload and NO token, so a verified
 * student must still sign in with their password. `login` then applies its
 * own gates (a `pending` account is refused), which is exactly the control
 * BR-001 and BR-002 describe.
 *
 * It also returns no profile data. An unauthenticated caller who happens to
 * hold a valid code learns the account's state and nothing else - not the
 * address, date of birth or guardian contact the profile carries.
 * ===========================================================================
 */

/** Why a verification or a resend could not be completed. */
export type VerificationFailureReason =
  /** No such user, or the user has no student profile. */
  | "unknown_account"
  /** Already confirmed. Idempotent callers should treat this as fine. */
  | "already_verified"
  /** No unconsumed challenge exists - the student must request one. */
  | "no_active_challenge"
  /** The challenge exists but has expired. */
  | "expired"
  /** Too many wrong guesses on this challenge. */
  | "attempt_limit_reached"
  /** Wrong code, or one that is no longer live. */
  | "invalid_code"
  /** A resend was asked for too soon. */
  | "cooldown_active"
  /** The per-window resend allowance is spent. */
  | "send_limit_reached"
  /** Stored but not delivered. Retryable. */
  | "delivery_failed"
  /** A repository or the OTP store failed. Retryable. */
  | "verification_unavailable";

/**
 * What a successful verification reports.
 *
 * Carries no profile fields, no token and no password hash - see the header.
 */
export interface EmailVerifiedSummary {
  studentId: EntityId;
  isEmailVerified: true;
  /**
   * The lifecycle state AFTER this verification, derived rather than stored
   * (see `deriveAccountState`). Normally `pending_approval`: the email is
   * confirmed and BR-002 admin approval is what remains.
   *
   * Absent when the stored facts do not describe a nameable state.
   */
  accountState?: AccountState;
  /** True when the student still needs an admin decision (BR-002). */
  awaitingAdminApproval: boolean;
}

/** What a successful send reports. Mirrors the frontend's `{ sentTo }`. */
export interface ChallengeSentSummary {
  /** Masked, e.g. "a***v@example.com". Never the full address. */
  sentTo: string;
  expiresAt: IsoDateTime;
  resendAvailableAt: IsoDateTime;
}

export type VerificationResult<T> =
  | { outcome: "success"; data: T }
  | {
      outcome: "failure";
      reason: VerificationFailureReason;
      /** Present for `cooldown_active`. */
      retryAfterSeconds?: number;
      /** Present for `invalid_code`. */
      attemptsRemaining?: number;
    };

export interface VerificationServiceDeps {
  otp: OtpService;
  users: UserRepository;
  students: StudentRepository;
}

export interface VerificationService {
  /**
   * Issues (or re-issues) an email challenge for a student.
   *
   * Used both immediately after registration and by the resend endpoint -
   * one path, so the cooldown and window limits apply identically to both.
   */
  sendEmailChallenge(studentId: EntityId): Promise<VerificationResult<ChallengeSentSummary>>;

  /** Checks a presented code and, on success, marks the email confirmed. */
  verifyEmail(
    studentId: EntityId,
    code: unknown,
  ): Promise<VerificationResult<EmailVerifiedSummary>>;
}

const PURPOSE = "email_verification" as const;

export const createVerificationService = (
  deps: VerificationServiceDeps,
): VerificationService => {
  const fail = <T>(
    reason: VerificationFailureReason,
    extra?: { retryAfterSeconds?: number; attemptsRemaining?: number },
  ): VerificationResult<T> => ({
    outcome: "failure",
    reason,
    ...(extra?.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extra.retryAfterSeconds }),
    ...(extra?.attemptsRemaining === undefined
      ? {}
      : { attemptsRemaining: extra.attemptsRemaining }),
  });

  return {
    async sendEmailChallenge(
      studentId: EntityId,
    ): Promise<VerificationResult<ChallengeSentSummary>> {
      // The destination is read from the USER RECORD, never taken from the
      // request. A caller-supplied address would turn this into an open
      // relay: anyone could have a code for someone else's account sent to
      // an address they control.
      let user;

      try {
        user = await deps.users.findById(studentId);
      } catch (err) {
        logger.error("email challenge refused: user lookup failed", {
          studentId,
          errorType: describeError(err),
        });

        return fail("verification_unavailable");
      }

      if (user === null) {
        // Same answer as a user who exists but has no profile, so this
        // cannot be used to probe which ids are real.
        return fail("unknown_account");
      }

      let student;

      try {
        student = await deps.students.findById(studentId);
      } catch (err) {
        logger.error("email challenge refused: student lookup failed", {
          studentId,
          errorType: describeError(err),
        });

        return fail("verification_unavailable");
      }

      if (student === null) {
        return fail("unknown_account");
      }

      if (student.isEmailVerified) {
        // Refusing is deliberate: sending a code for an address that is
        // already confirmed is a free way to mail someone repeatedly.
        return fail("already_verified");
      }

      const issued = await deps.otp.issue({
        userId: studentId,
        purpose: PURPOSE,
        destination: user.email,
      });

      if (issued.outcome === "failure") {
        return fail(
          issued.reason === "cooldown_active"
            ? "cooldown_active"
            : issued.reason === "send_limit_reached"
              ? "send_limit_reached"
              : issued.reason === "delivery_failed"
                ? "delivery_failed"
                : "verification_unavailable",
          issued.retryAfterSeconds === undefined
            ? undefined
            : { retryAfterSeconds: issued.retryAfterSeconds },
        );
      }

      return {
        outcome: "success",
        data: {
          sentTo: issued.data.maskedDestination,
          expiresAt: issued.data.expiresAt,
          resendAvailableAt: issued.data.resendAvailableAt,
        },
      };
    },

    async verifyEmail(
      studentId: EntityId,
      code: unknown,
    ): Promise<VerificationResult<EmailVerifiedSummary>> {
      let student;

      try {
        student = await deps.students.findById(studentId);
      } catch (err) {
        logger.error("email verification refused: student lookup failed", {
          studentId,
          errorType: describeError(err),
        });

        return fail("verification_unavailable");
      }

      if (student === null) {
        return fail("unknown_account");
      }

      if (student.isEmailVerified) {
        return fail("already_verified");
      }

      const checked = await deps.otp.verify({ userId: studentId, purpose: PURPOSE, code });

      if (checked.outcome === "failure") {
        return fail(
          checked.reason === "otp_unavailable" ? "verification_unavailable" : checked.reason,
          checked.attemptsRemaining === undefined
            ? undefined
            : { attemptsRemaining: checked.attemptsRemaining },
        );
      }

      // The code was correct AND the challenge is now spent. Apply the
      // consequence.
      //
      // ORDER: the challenge is consumed first (inside `otp.verify`), so a
      // failure here cannot leave a reusable code behind. The cost is that
      // this failure mode needs a fresh code - correct, because the
      // alternative is a code that stays valid after being accepted once.
      let updated;

      try {
        updated = await deps.students.markVerified(studentId, "email");
      } catch (err) {
        logger.error(
          "EMAIL VERIFIED BUT NOT RECORDED: the code was correct and the challenge is now " +
            "spent, yet the student could not be marked verified. The student must request a " +
            "new code and retry. No transaction spans the OTP store and the student record " +
            "(open-questions Q-X1).",
          { studentId, errorType: describeError(err) },
        );

        return fail("verification_unavailable");
      }

      logger.info("student email verified", {
        studentId,
        to: maskDestination(updated.email),
      });

      const accountState = deriveAccountState({
        status: updated.status,
        isEmailVerified: updated.isEmailVerified,
        adminApprovalStatus: updated.adminApprovalStatus,
      });

      return {
        outcome: "success",
        data: {
          studentId,
          isEmailVerified: true,
          ...(accountState === undefined ? {} : { accountState }),
          awaitingAdminApproval: updated.adminApprovalStatus === "pending",
        },
      };
    },
  };
};
