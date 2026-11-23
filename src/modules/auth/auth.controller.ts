import type { Request, Response } from "express";

import type { FieldIssue } from "../../contracts/api.contract";
import type {
  LoginFailureReason,
  LoginService,
} from "./login.service";
import type {
  RegistrationFailureReason,
  RegistrationService,
} from "./registration.service";
import type {
  VerificationFailureReason,
  VerificationService,
} from "./verification.service";
import type {
  EmailOtpResendBody,
  EmailOtpVerifyBody,
} from "./auth.validation";
import {
  issueVerificationTicket,
  verifyVerificationTicket,
} from "./token.service";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";

const DUPLICATE_EMAIL_MESSAGE =
  "An account with this email address already exists. Please sign in or use another email.";

const DUPLICATE_MOBILE_MESSAGE =
  "An account with this mobile number already exists. Please sign in or use another mobile number.";

const DUPLICATE_IDENTIFIER_MESSAGE =
  "An account with these details already exists. Please sign in, or use a different " +
  "email address and mobile number.";

const SUCCESS_MESSAGE =
  "Registration received. The account is pending verification and admin approval.";

const REGISTERED_AND_SENT_MESSAGE =
  "Registration received. Enter the 6-digit code sent to your email address to continue; " +
  "your account then awaits admin approval.";

const REGISTERED_BUT_UNSENT_MESSAGE =
  "Registration received, but the verification email could not be sent. " +
  "Please use the resend option on the next screen.";

const PARTIAL_STATE_MESSAGE =
  "Registration could not be completed. Please contact support.";

const UNAVAILABLE_MESSAGE =
  "Registration is temporarily unavailable. Please try again shortly.";

const toRegistrationApiError = (
  reason: RegistrationFailureReason,
  issues: FieldIssue[] | undefined,
): ApiError => {
  switch (reason) {
    case "validation_failed":
      return ApiError.validation(
        issues ?? [{ field: "registration", message: "Registration input is invalid" }],
      );

    case "email_taken":
      return ApiError.conflict(DUPLICATE_EMAIL_MESSAGE);

    case "mobile_taken":
      return ApiError.conflict(DUPLICATE_MOBILE_MESSAGE);

    case "identifier_taken":
      return ApiError.conflict(DUPLICATE_IDENTIFIER_MESSAGE);

    case "registration_unavailable":
      return ApiError.serviceUnavailable(UNAVAILABLE_MESSAGE);

    case "incomplete":
    case "profile_incomplete":
      return new ApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        PARTIAL_STATE_MESSAGE,
        "INTERNAL_SERVER_ERROR",
      );
  }
};

export const createRegistrationController = (
  service: RegistrationService,
  verification?: VerificationService,
) => ({
  /**
   * POST /api/v1/auth/register
   *
   * 201 { success, data: { tempStudentId, email, mobile, verificationTicket }, message }
   */
  register: async (req: Request, res: Response): Promise<void> => {
    const result = await service.register(req.body);

    if (result.outcome === "failure") {
      throw toRegistrationApiError(result.reason, result.issues);
    }

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
        tempStudentId: result.data.tempStudentId,
        email: result.data.email,
        mobile: result.data.mobile,
        verificationTicket: issueVerificationTicket(result.data.tempStudentId).ticket,
      },
      message,
      status: HttpStatus.CREATED,
    });
  },
});

export type RegistrationController = ReturnType<typeof createRegistrationController>;

// ---------------------------------------------------------------------------
// Login Controller
// ---------------------------------------------------------------------------

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
      return new ApiError(
        HttpStatus.FORBIDDEN,
        "This account is not active yet. Please contact the admissions team if you believe " +
          "it should be.",
        "ACCOUNT_PENDING",
      );

    case "account_pending_verification":
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

export const createLoginController = (service: LoginService) => ({
  /**
   * POST /api/v1/auth/login
   *
   * 200 { success, data: { token, expiresIn, user }, message }
   */
  login: async (req: Request, res: Response): Promise<void> => {
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

export type LoginController = ReturnType<typeof createLoginController>;

// ---------------------------------------------------------------------------
// Email OTP Verification Controller
// ---------------------------------------------------------------------------

const toVerificationApiError = (
  reason: VerificationFailureReason,
  extra: { retryAfterSeconds?: number; attemptsRemaining?: number },
): ApiError => {
  switch (reason) {
    case "unknown_account":
      return ApiError.notFound("We could not find that registration. Please register again.");

    case "already_verified":
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
      return ApiError.serviceUnavailable(
        "The verification email could not be sent. Please try again shortly.",
      );

    case "verification_unavailable":
      return ApiError.serviceUnavailable(
        "Verification is temporarily unavailable. Please try again shortly.",
      );
  }
};

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

export const createVerificationController = (service: VerificationService) => ({
  /**
   * POST /api/v1/auth/otp/email/verify
   */
  verifyEmail: async (req: Request, res: Response): Promise<void> => {
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
   */
  resendEmail: async (req: Request, res: Response): Promise<void> => {
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

export type VerificationController = ReturnType<typeof createVerificationController>;
