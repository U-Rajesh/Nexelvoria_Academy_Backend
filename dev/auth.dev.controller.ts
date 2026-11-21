import type { Request, Response } from "express";

import type { FieldIssue } from "../src/contracts/api.contract";
import type {
  RegistrationFailureReason,
  RegistrationService,
} from "../src/modules/auth/registration.service";
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

export const createDevRegistrationController = (service: RegistrationService) => ({
  /**
   * POST /api/v1/auth/register
   *
   * 201 { success, data: { tempStudentId, email, mobile }, message }
   *
   * The response carries the three confirmed fields and nothing else - no
   * password, no hash, no token, no stored record. `RegistrationSuccess` is
   * the whole payload, so there is no field to leak by accident.
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

    sendSuccess(res, {
      data: result.data,
      message: SUCCESS_MESSAGE,
      status: HttpStatus.CREATED,
    });
  },
});

export type DevRegistrationController = ReturnType<typeof createDevRegistrationController>;
