import { Router, type RequestHandler } from "express";

import { validate } from "../../middleware/validate.middleware";
import { createRateLimiter } from "../../middleware/rate-limit.middleware";
import {
  emailOtpResendSchema,
  emailOtpVerifySchema,
  loginSchema,
} from "./auth.validation";
import {
  createRegistrationService,
} from "./registration.service";
import type { StudentRegistrationRepository } from "./registration.repository";
import type { UserRepository } from "../users/user.repository";
import type { CredentialRepository } from "./credential.repository";
import type { StudentRepository } from "../students/student.repository";
import type { LoginService } from "./login.service";
import type { VerificationService } from "./verification.service";
import {
  createLoginController,
  createRegistrationController,
  createVerificationController,
} from "./auth.controller";

export const REGISTRATION_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: "Too many registration attempts. Please try again in 15 minutes.",
} as const;

export const createRegistrationRateLimiter = (): RequestHandler =>
  createRateLimiter({ ...REGISTRATION_RATE_LIMIT });

export const LOGIN_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many sign-in attempts. Please try again in 15 minutes.",
} as const;

export const createLoginRateLimiter = (): RequestHandler =>
  createRateLimiter({ ...LOGIN_RATE_LIMIT });

export const OTP_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: "Too many verification attempts. Please try again in 15 minutes.",
} as const;

export const createOtpRateLimiter = (): RequestHandler =>
  createRateLimiter({ ...OTP_RATE_LIMIT });

export interface AuthRoutesOptions {
  studentRegistration?: StudentRegistrationRepository;
  login?: LoginService;
  verification?: VerificationService;
  rateLimiter?: RequestHandler;
  loginRateLimiter?: RequestHandler;
  otpRateLimiter?: RequestHandler;
}

export const createAuthRoutes = (options: AuthRoutesOptions): Router => {
  const router = Router();

  if (options.studentRegistration !== undefined) {
    const service = createRegistrationService({
      registration: options.studentRegistration,
      get users(): UserRepository {
        throw new Error("Sequential users fallback is not supported on production registration.");
      },
      get credentials(): CredentialRepository {
        throw new Error("Sequential credentials fallback is not supported on production registration.");
      },
      get students(): StudentRepository {
        throw new Error("Sequential students fallback is not supported on production registration.");
      },
    });

    const controller = createRegistrationController(service, options.verification);

    router.post(
      "/register",
      options.rateLimiter ?? createRegistrationRateLimiter(),
      controller.register,
    );
  }

  if (options.login !== undefined) {
    const loginController = createLoginController(options.login);

    router.post(
      "/login",
      options.loginRateLimiter ?? createLoginRateLimiter(),
      validate({ body: loginSchema }),
      loginController.login,
    );
  }

  if (options.verification !== undefined) {
    const verificationController = createVerificationController(options.verification);

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
