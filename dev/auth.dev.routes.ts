// Side-effect import: refuses to load in a production process.
import "./guard.dev";

import { Router, type RequestHandler } from "express";

import { validate } from "../src/middleware/validate.middleware";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import {
  emailOtpResendSchema,
  emailOtpVerifySchema,
  loginSchema,
} from "../src/modules/auth/auth.validation";
import type { LoginService } from "../src/modules/auth/login.service";
import {
  createRegistrationService,
  type RegistrationServiceDeps,
} from "../src/modules/auth/registration.service";
import type { VerificationService } from "../src/modules/auth/verification.service";
import {
  createDevLoginController,
  createDevRegistrationController,
  createDevVerificationController,
} from "./auth.dev.controller";

/**
 * DEVELOPMENT ONLY - the `/auth` router for the local registration harness.
 *
 *   POST /api/v1/auth/register   Student self-registration   public
 *
 * PUBLIC BY DESIGN, not by omission: api-contracts section 4 marks
 * `/auth/register` "Auth: No". `authenticate` is therefore deliberately
 * absent, and no security middleware is disabled to achieve that - every
 * layer `createApp()` installs (helmet, CORS, the general /api rate limit,
 * the body-size limit, the error pipeline) still applies to this route.
 *
 * NOT REGISTERED IN src/routes/index.ts. It is handed to `createApp` as
 * `extraV1Routes` by dev/server.dev.ts, which exists only here. The
 * production application mounts no registration route at all, because the
 * service's three writes are still not atomic (open-questions Q-X1).
 */

/**
 * The registration rate limit.
 *
 * Far tighter than the general 300-per-15-minutes `/api` limiter, which is a
 * blunt anti-scraping instrument rather than a control for an endpoint worth
 * abusing. Registration creates accounts and pays for an argon2id hash on
 * every attempt (~46 MiB, ~120ms), so it is both a spam target and a cheap
 * way to burn server CPU. Five per IP per fifteen minutes is ample for a
 * human filling in a four-section form.
 *
 * Exported so a test can assert the figure rather than hardcode it twice.
 */
export const REGISTRATION_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: "Too many registration attempts. Please try again in 15 minutes.",
} as const;

/**
 * Builds a FRESH limiter each call.
 *
 * Not a module-level singleton: `express-rate-limit` keeps its counters on
 * the instance, so a shared one would carry state between every app built in
 * a process - which would make two tests in one file affect each other.
 */
export const createRegistrationRateLimiter = (): RequestHandler =>
  createRateLimiter({ ...REGISTRATION_RATE_LIMIT });

/**
 * The OTP endpoint rate limit.
 *
 * Separate from, and looser than, the registration limiter. Registration
 * creates accounts and pays for an argon2id hash; verifying a code is cheap
 * and a student legitimately retries - mistyping a digit, pasting with a
 * stray space, asking for a resend. Thirty per IP per fifteen minutes allows
 * that without allowing a flood.
 *
 * THIS IS NOT THE GUESS LIMIT. Per-IP throttling cannot bound guessing,
 * because an attacker rotates addresses. The real control is the
 * five-attempt ceiling stored ON THE CHALLENGE (`OTP_MAX_VERIFY_ATTEMPTS`),
 * which no amount of IP rotation can reset. This limiter exists only to keep
 * the endpoint from being used as a cheap traffic sink.
 */
export const OTP_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: "Too many verification attempts. Please try again in 15 minutes.",
} as const;

/** A fresh limiter per call, for the reason given above `createRegistrationRateLimiter`. */
export const createOtpRateLimiter = (): RequestHandler =>
  createRateLimiter({ ...OTP_RATE_LIMIT });

/**
 * The login rate limit.
 *
 * Tighter than the OTP limiter: a sign-in form is the classic target for
 * credential stuffing, and each attempt pays for an argon2id verification
 * (~120ms, ~46 MiB), so an unthrottled endpoint is also a cheap way to burn
 * server CPU.
 *
 * THIS IS NOT THE LOCKOUT. Per-IP throttling cannot stop a distributed
 * attack. The real control is the per-credential lockout counted inside
 * `login.service.ts` (`maxFailedLoginAttempts`), which no amount of IP
 * rotation resets. This limiter only bounds the cost of the endpoint.
 */
export const LOGIN_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many sign-in attempts. Please try again in 15 minutes.",
} as const;

/** A fresh limiter per call, for the reason given above. */
export const createLoginRateLimiter = (): RequestHandler =>
  createRateLimiter({ ...LOGIN_RATE_LIMIT });

export interface DevAuthRoutesOptions {
  /** The three repositories the registration service writes through. */
  deps: RegistrationServiceDeps;
  /**
   * Email verification. OPTIONAL.
   *
   * Supplied: registration issues a code and the two OTP routes below are
   * mounted. Omitted: neither happens, and this router behaves exactly as it
   * did before verification existed - which is what keeps the pre-existing
   * endpoint tests valid without being rewritten.
   */
  verification?: VerificationService;
  /**
   * Login. OPTIONAL, like `verification`: omitted, no `/login` route is
   * mounted and the pre-existing registration tests see the router exactly
   * as it was.
   *
   * Supplied only by the development harness. The production application
   * still mounts NO auth routes at all (`src/routes/index.ts`).
   */
  login?: LoginService;
  /**
   * Overrides the rate limiter. Provided ONLY so a test can raise the limit
   * while exercising the other behaviours; local development always gets
   * the real one above.
   */
  rateLimiter?: RequestHandler;
  /** Overrides the OTP limiter, for the same reason. */
  otpRateLimiter?: RequestHandler;
  /** Overrides the login limiter, for the same reason. */
  loginRateLimiter?: RequestHandler;
}

export const createDevAuthRoutes = (options: DevAuthRoutesOptions): Router => {
  const controller = createDevRegistrationController(
    createRegistrationService(options.deps),
    options.verification,
  );
  const router = Router();

  // Limiter FIRST: an over-limit caller is rejected before the body is
  // validated and long before anything is hashed or written.
  router.post(
    "/register",
    options.rateLimiter ?? createRegistrationRateLimiter(),
    controller.register,
  );

  if (options.login !== undefined) {
    const loginController = createDevLoginController(options.login);

    // api-contracts section 4 #1. Public by definition - a caller has no
    // session yet. Validation runs AFTER the limiter so a flood is rejected
    // before any parsing, and before argon2 is ever reached.
    router.post(
      "/login",
      options.loginRateLimiter ?? createLoginRateLimiter(),
      validate({ body: loginSchema }),
      loginController.login,
    );
  }

  if (options.verification !== undefined) {
    const verificationController = createDevVerificationController(options.verification);

    // Paths follow docs/api-contracts.md section 4 (#3 and #6) exactly, so
    // the frontend does not have to learn a second set of URLs later.
    //
    // PUBLIC, like /register: a student verifying an email has no session
    // yet, and api-contracts marks both "Auth: No". The controls are the
    // limiter here, the per-challenge attempt ceiling, and the fact that
    // neither endpoint returns profile data or a token.
    //
    // MOBILE AND DUAL-OTP ROUTES ARE ABSENT BY DECISION, not oversight.
    // api-contracts lists /auth/otp/mobile/verify, /auth/otp/mobile/resend
    // and /auth/otp/verify-dual, but mobile OTP is descoped: BR-014 disables
    // SMS and that was confirmed as the approved scope. Mounting them would
    // mean either inventing an SMS provider or shipping endpoints that
    // cannot work.
    router.post(
      "/otp/email/verify",
      options.otpRateLimiter ?? createOtpRateLimiter(),
      validate({ body: emailOtpVerifySchema }),
      verificationController.verifyEmail,
    );

    router.post(
      "/otp/email/resend",
      options.otpRateLimiter ?? createOtpRateLimiter(),
      validate({ body: emailOtpResendSchema }),
      verificationController.resendEmail,
    );
  }

  return router;
};
