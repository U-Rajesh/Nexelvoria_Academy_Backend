import type { Request, Response } from "express";

import type { FieldIssue } from "../src/contracts/api.contract";
import type {
  LoginFailureReason,
  LoginService,
} from "../src/modules/auth/login.service";
import {
  issueVerificationTicket,
  verifyVerificationTicket,
} from "../src/modules/auth/token.service";
import type {
  RegistrationFailureReason,
  RegistrationService,
} from "../src/modules/auth/registration.service";
import type {
  VerificationFailureReason,
  VerificationService,
} from "../src/modules/auth/verification.service";
import type {
  EmailOtpResendBody,
  EmailOtpVerifyBody,
} from "../src/modules/auth/auth.validation";
import { ApiError } from "../src/utils/api-error";
import { HttpStatus } from "../src/utils/http-status";
import { sendSuccess } from "../src/utils/send";

/**
 * DEVELOPMENT ONLY - the HTTP adapter for the Student Registration service.
 *
 * It is an ADAPTER AND NOTHING ELSE: read the body, call `register` once,
 * translate the result into a status code. No validation (the service owns
 * it, and its schema is the control), no business rule, no repository, no
 * compensating write. `registration.service.ts` is used exactly as written.
 *
 * Why the mapping lives here and not in the service: the service is
 * deliberately HTTP-free and returns a `RegistrationFailureReason`. Turning
 * that into a status code is the edge's job - which is also why this file
 * can live outside `src/` without the service knowing anything about it.
 */

/**
 * Duplicate-identifier wording, copied from the frontend's existing mock
 * (`authService.registerStudent`) so the error banner reads identically
 * whether the mock or this endpoint answered.
 *
 * NOTE, knowingly: a 409 that names the field confirms an address is
 * registered, which is account enumeration. It is kept because it is the
 * CONFIRMED contract (api-contracts section 4: "409 CONFLICT - email or
 * mobile already registered") and the behaviour the frontend already has.
 * See auth-implementation-plan section 8.2; changing it is a contract
 * decision, not something this adapter should decide.
 */
const DUPLICATE_EMAIL_MESSAGE =
  "An account with this email address already exists. Please sign in or use another email.";

const DUPLICATE_MOBILE_MESSAGE =
  "An account with this mobile number already exists. Please sign in or use another mobile number.";

/**
 * The 201 message.
 *
 * Deliberately NOT the mock's "Please complete dual email and mobile OTP
 * verification": no OTP service exists, Q3 is unresolved, and this phase
 * implements none. Promising a step that cannot happen would be a lie in the
 * response body. The account really is left pending verification and
 * approval, which is what this says. `RegisterPage` renders its own toast and
 * never reads this field, so the wording costs the frontend nothing.
 */
const SUCCESS_MESSAGE =
  "Registration received. The account is pending verification and admin approval.";

/**
 * Sent for BOTH partial-state outcomes (`incomplete`, `profile_incomplete`).
 *
 * Generic on purpose. The client must not be told that its email and mobile
 * are now held by an unusable record - that is operator information, and the
 * service has already logged it with the user id. The two reasons are
 * distinguished in the LOG, never in the response.
 */
const PARTIAL_STATE_MESSAGE =
  "Registration could not be completed. Please contact support.";

const UNAVAILABLE_MESSAGE =
  "Registration is temporarily unavailable. Please try again shortly.";

/** Translates a service failure into the HTTP error the client receives. */
const toApiError = (
  reason: RegistrationFailureReason,
  issues: FieldIssue[] | undefined,
): ApiError => {
  switch (reason) {
    case "validation_failed":
      // `issues` is always present for this reason; the fallback exists so a
      // 422 can never go out with an empty `details` array.
      return ApiError.validation(
        issues ?? [{ field: "registration", message: "Registration input is invalid" }],
      );

    case "email_taken":
      return ApiError.conflict(DUPLICATE_EMAIL_MESSAGE);

    case "mobile_taken":
      return ApiError.conflict(DUPLICATE_MOBILE_MESSAGE);

    case "registration_unavailable":
      // 503, not 500: nothing is wrong with the request and a retry is
      // reasonable - a repository was unreachable before anything was written.
      return ApiError.serviceUnavailable(UNAVAILABLE_MESSAGE);

    case "incomplete":
    case "profile_incomplete":
      // 500. Partial state exists and an operator must resolve it. This is
      // the non-atomic failure mode Q-X1 has to close before any production
      // registration route can be mounted.
      return new ApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        PARTIAL_STATE_MESSAGE,
        "INTERNAL_SERVER_ERROR",
      );
  }
};

/**
 * Message used when the account was created but the verification email
 * could not be sent.
 *
 * Still a 201: the registration itself succeeded and the account exists.
 * Telling the student the truth - "you are registered, the code did not go
 * out, use resend" - is better than a 500 that implies nothing was saved and
 * invites them to submit the form again (which would now 409).
 */
const REGISTERED_BUT_UNSENT_MESSAGE =
  "Registration received, but the verification email could not be sent. " +
  "Please use the resend option on the next screen.";

/** The 201 message when a verification code really was issued. */
const REGISTERED_AND_SENT_MESSAGE =
  "Registration received. Enter the 6-digit code sent to your email address to continue; " +
  "your account then awaits admin approval.";

export const createDevRegistrationController = (
  service: RegistrationService,
  /**
   * Email verification. OPTIONAL, and that is deliberate.
   *
   * When absent, registration behaves exactly as it did before verification
   * existed: the account is created and no challenge is issued. That keeps
   * every caller that predates this parameter - including the 35 existing
   * endpoint tests - working unchanged, rather than forcing a test rewrite
   * to accommodate a new dependency.
   *
   * `dev/server.dev.ts` always supplies it, so the running harness performs
   * the full register-then-verify flow.
   */
  verification?: VerificationService,
) => ({
  /**
   * POST /api/v1/auth/register
   *
   * 201 { success, data: { tempStudentId, email, mobile }, message }
   *
   * The response carries the three confirmed fields and nothing else - no
   * password, no hash, no token, no stored record. `RegistrationSuccess` is
   * the whole payload, so there is no field to leak by accident.
   *
   * THE SHAPE IS FIXED BY DECISION D2 and must not grow. Whether a
   * verification code was sent is reported in `message`, NOT as a fourth
   * field: the contract test asserts the payload has exactly these three
   * keys, and the frontend already has everything it needs to reach the OTP
   * screen (`tempStudentId`).
   *
   * Throws rather than writing failures itself: Express 5 forwards a rejected
   * promise to `errorHandler`, which is the single place a failure body is
   * produced. That is what keeps this endpoint's error envelope identical to
   * every other endpoint's.
   */
  async register(req: Request, res: Response): Promise<void> {
    const result = await service.register(req.body);

    if (result.outcome === "failure") {
      throw toApiError(result.reason, result.issues);
    }

    // The account exists from here on. A verification failure must NOT undo
    // or hide that, so everything below only changes the message.
    let message = SUCCESS_MESSAGE;

    if (verification !== undefined) {
      const sent = await verification.sendEmailChallenge(result.data.tempStudentId);

      message =
        sent.outcome === "success"
          ? REGISTERED_AND_SENT_MESSAGE
          : REGISTERED_BUT_UNSENT_MESSAGE;
    }

    sendSuccess(res, {
      data: {
        ...result.data,

        /**
         * TRANSITIONAL CONTRACT.
         *
         * `tempStudentId` above is RETAINED for compatibility and is
         * deprecated: it is a real internal identifier, and it used to be
         * placed in a URL (`/verify-otp?studentId=...`). It is no longer
         * used for anything - the OTP endpoints accept only a ticket.
         *
         * `verificationTicket` is what the client should carry forward. It
         * is opaque, expires in 15 minutes and is purpose-scoped, so it
         * cannot authenticate anything.
         *
         * Issued HERE rather than in the registration service because a
         * ticket is a transport concern: `RegistrationSuccess` stays an
         * HTTP-free service type.
         */
        verificationTicket: issueVerificationTicket(result.data.tempStudentId).ticket,
      },
      message,
      status: HttpStatus.CREATED,
    });
  },
});

export type DevRegistrationController = ReturnType<typeof createDevRegistrationController>;

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * Translates a verification failure into an HTTP error.
 *
 * NOTE WHAT IS AND IS NOT DISTINGUISHED. `unknown_account` deliberately
 * produces the SAME 404 wording whether the id is unknown, belongs to a user
 * with no student profile, or is simply malformed-but-bounded. These
 * endpoints are public, so a response that separated those cases would let
 * an attacker enumerate which registration ids exist.
 *
 * What IS revealed is `attemptsRemaining` on a wrong code and the retry delay
 * on a cooldown. Both are public policy, both are things the student needs in
 * order to act, and neither says anything about the code itself.
 */
const toVerificationApiError = (
  reason: VerificationFailureReason,
  extra: { retryAfterSeconds?: number; attemptsRemaining?: number },
): ApiError => {
  switch (reason) {
    case "unknown_account":
      return ApiError.notFound("We could not find that registration. Please register again.");

    case "already_verified":
      // 409, not 400: the request was well formed, it just conflicts with
      // the current state. The frontend can send the student on to sign in.
      return ApiError.conflict("This email address is already verified. Please sign in.");

    case "no_active_challenge":
      return new ApiError(
        HttpStatus.BAD_REQUEST,
        "No verification code is outstanding. Please request a new one.",
        "BAD_REQUEST",
      );

    case "expired":
      return new ApiError(
        HttpStatus.BAD_REQUEST,
        "That verification code has expired. Please request a new one.",
        "BAD_REQUEST",
      );

    case "attempt_limit_reached":
      // 429: the client has exhausted an allowance and must back off, which
      // is what 429 means. 403 would imply the code could never work.
      return new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        "Too many incorrect attempts. Please request a new verification code.",
        "TOO_MANY_REQUESTS",
      );

    case "invalid_code": {
      const remaining = extra.attemptsRemaining;

      return new ApiError(
        HttpStatus.BAD_REQUEST,
        remaining === undefined || remaining <= 0
          ? "That code is not correct. Please request a new verification code."
          : `That code is not correct. ${String(remaining)} attempt(s) remaining.`,
        "BAD_REQUEST",
      );
    }

    case "cooldown_active": {
      const wait = extra.retryAfterSeconds;

      return new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        wait === undefined
          ? "A code was sent recently. Please wait before requesting another."
          : `A code was sent recently. Please wait ${String(wait)} second(s) before requesting another.`,
        "TOO_MANY_REQUESTS",
      );
    }

    case "send_limit_reached":
      return new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        "Too many verification emails requested. Please try again later.",
        "TOO_MANY_REQUESTS",
      );

    case "delivery_failed":
      // 503: nothing is wrong with the request and a retry is reasonable.
      return ApiError.serviceUnavailable(
        "The verification email could not be sent. Please try again shortly.",
      );

    case "verification_unavailable":
      return ApiError.serviceUnavailable(
        "Verification is temporarily unavailable. Please try again shortly.",
      );
  }
};

/**
 * Turns a verification ticket into the user id it was issued for, or throws.
 *
 * The ONLY way these endpoints learn which account a code belongs to. A
 * client-supplied `studentId` is no longer accepted, so a real identifier
 * never crosses the wire and none can appear in a URL.
 *
 * An unusable ticket is a 401 rather than a 422: the body was well formed,
 * what failed is the proof of control. The four rejection reasons collapse
 * into one message - "expired" is the only one worth distinguishing to a
 * user, and saying "bad signature" would only help someone forging one.
 */
const resolveTicket = (ticket: string): string => {
  const verified = verifyVerificationTicket(ticket);

  if (!verified.valid) {
    throw ApiError.unauthorized(
      verified.reason === "expired"
        ? "Your verification session has expired. Please sign in again to continue."
        : "That verification session is not valid. Please sign in again to continue.",
      "UNAUTHORIZED",
    );
  }

  return verified.userId;
};

export const createDevVerificationController = (service: VerificationService) => ({
  /**
   * POST /api/v1/auth/otp/email/verify
   *
   * 200 { success, data: { studentId, isEmailVerified, accountState?,
   *                        awaitingAdminApproval }, message }
   *
   * ISSUES NO TOKEN AND RETURNS NO PROFILE, by design. The mock this replaces
   * returned the whole `StudentProfile` and the frontend called
   * `setUser(...)` with it, which made a six-digit code sufficient to become
   * that student without a password. A verified student must still sign in.
   */
  async verifyEmail(req: Request, res: Response): Promise<void> {
    const { ticket, otp } = req.body as EmailOtpVerifyBody;
    const studentId = resolveTicket(ticket);

    const result = await service.verifyEmail(studentId, otp);

    if (result.outcome === "failure") {
      throw toVerificationApiError(result.reason, {
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
        ...(result.attemptsRemaining === undefined
          ? {}
          : { attemptsRemaining: result.attemptsRemaining }),
      });
    }

    sendSuccess(res, {
      data: result.data,
      message: result.data.awaitingAdminApproval
        ? "Email verified. Your registration is now awaiting admin approval."
        : "Email verified.",
    });
  },

  /**
   * POST /api/v1/auth/otp/email/resend
   *
   * 200 { success, data: { sentTo, expiresAt, resendAvailableAt }, message }
   *
   * `sentTo` is MASKED ("a***v@example.com"). The endpoint is public, so
   * echoing the full address would turn a known registration id into an
   * email-address disclosure. Masked is still enough for the student to
   * recognise their own inbox, which is the only reason the field exists.
   */
  async resendEmail(req: Request, res: Response): Promise<void> {
    const { ticket } = req.body as EmailOtpResendBody;
    const studentId = resolveTicket(ticket);

    const result = await service.sendEmailChallenge(studentId);

    if (result.outcome === "failure") {
      throw toVerificationApiError(result.reason, {
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
      });
    }

    sendSuccess(res, {
      data: result.data,
      message: `A new 6-digit code has been sent to ${result.data.sentTo}.`,
    });
  },
});

export type DevVerificationController = ReturnType<typeof createDevVerificationController>;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Translates a login failure into an HTTP error.
 *
 * ===========================================================================
 * TWO DELIBERATE COMPROMISES, BOTH RECORDED RATHER THAN HIDDEN.
 *
 * 1. `invalid_credentials` and `password_changed_concurrently` collapse into
 *    ONE generic 401. The login service already refuses to distinguish "no
 *    such user" from "wrong password" (see `LoginFailureReason`), and this
 *    keeps that property at the edge: a response that separated them would
 *    be an account-existence oracle.
 *
 * 2. The three account-state refusals return **FORBIDDEN**, not the
 *    `ACCOUNT_LOCKED` / `ACCOUNT_PENDING` codes api-contracts section 4
 *    documents - because those codes are NOT members of `API_ERROR_CODES`,
 *    which is a closed set whose own comment says adding a member is an API
 *    change that must be announced.
 *
 *    The consequence, which the backend lead needs to decide before a
 *    PRODUCTION login route exists: the frontend renders a different screen
 *    per account state, and with one `FORBIDDEN` code it cannot tell
 *    "awaiting approval" from "locked out". The `message` differs, but a UI
 *    should branch on a code, not on prose. Adding the two codes is a
 *    one-line contract change; making it unilaterally inside a dev harness
 *    is not this file's call.
 * ===========================================================================
 */
const toLoginApiError = (
  reason: LoginFailureReason,
  verificationTicket?: string,
): ApiError => {
  switch (reason) {
    case "invalid_credentials":
    case "password_changed_concurrently":
      return ApiError.unauthorized(
        "Those sign-in details are not correct.",
        "UNAUTHORIZED",
      );

    case "account_locked":
      return new ApiError(
        HttpStatus.FORBIDDEN,
        "This account is temporarily locked after repeated failed sign-in attempts. " +
          "Please reset your password.",
        "ACCOUNT_LOCKED",
      );

    case "account_pending":
      // The CATCH-ALL case, covering two situations: the reason could not
      // be established, and the account is verified and already decided but
      // not yet activated.
      //
      // The wording prescribes NO step, deliberately. An earlier version
      // said "verify your email, then wait for approval", which is wrong for
      // an already-approved student waiting only on activation.
      return new ApiError(
        HttpStatus.FORBIDDEN,
        "This account is not active yet. Please contact the admissions team if you believe " +
          "it should be.",
        "ACCOUNT_PENDING",
      );

    case "account_pending_verification":
      // The ticket travels WITH the refusal so the client can go straight to
      // the verification screen - see ApiFailure.verificationTicket.
      return new ApiError(
        HttpStatus.FORBIDDEN,
        "Please verify your email address to continue. Enter the 6-digit code we sent you.",
        "ACCOUNT_PENDING_VERIFICATION",
        undefined,
        verificationTicket,
      );

    case "account_pending_approval":
      return new ApiError(
        HttpStatus.FORBIDDEN,
        "Your email is verified and your registration is awaiting administrator approval.",
        "ACCOUNT_PENDING_APPROVAL",
      );

    case "account_suspended":
      return new ApiError(
        HttpStatus.FORBIDDEN,
        "This account has been suspended. Please contact support.",
        "ACCOUNT_SUSPENDED",
      );

    case "account_deactivated":
      return new ApiError(
        HttpStatus.FORBIDDEN,
        "This account has been deactivated. Please contact support.",
        "ACCOUNT_DEACTIVATED",
      );

    case "authentication_unavailable":
      return ApiError.serviceUnavailable(
        "Sign-in is temporarily unavailable. Please try again shortly.",
      );
  }
};

export const createDevLoginController = (service: LoginService) => ({
  /**
   * POST /api/v1/auth/login
   *
   * 200 { success, data: { token, expiresIn, user }, message }
   *
   * ===========================================================================
   * THE REFRESH TOKEN IS DELIBERATELY NOT RETURNED.
   *
   * `LoginSuccess` carries one, and `login.service.ts` states in capitals
   * that **no HTTP endpoint may return it until decision D4 is made**: the
   * frontend keeps its access token in `localStorage`, readable by any XSS on
   * the origin, and putting a long-lived refresh token in the same place is a
   * materially worse exposure than a 15-minute access token. The alternative
   * is an httpOnly, Secure, SameSite cookie, which needs CSRF protection and
   * frontend work nobody has scheduled.
   *
   * So this endpoint honours that prohibition. api-contracts section 4 lists
   * `refreshToken?` as OPTIONAL, so omitting it is contract-compliant rather
   * than a deviation. The token is still generated and stored server-side -
   * the session exists and can be rotated - it simply never crosses the wire,
   * which means `/auth/refresh` cannot work yet either. That is the known
   * cost of leaving D4 open.
   * ===========================================================================
   *
   * The business logic is untouched: this is an adapter over
   * `createLoginService` exactly as written - same lockout counting, same
   * status gates, same generic refusals.
   */
  async login(req: Request, res: Response): Promise<void> {
    // Client metadata is recorded on the session for the "active sessions"
    // view. It is NEVER used for authorization - see `LoginClientContext`.
    const result = await service.login(req.body, {
      ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
      ...(req.get("user-agent") === undefined ? {} : { browser: req.get("user-agent") as string }),
    });

    if (result.outcome === "failure") {
      throw toLoginApiError(result.reason, result.verificationTicket);
    }

    sendSuccess(res, {
      data: {
        token: result.data.accessToken,
        expiresIn: result.data.expiresIn,
        user: result.data.user,
      },
      message: "Signed in.",
    });
  },
});

export type DevLoginController = ReturnType<typeof createDevLoginController>;
