import rateLimit, { type Options } from "express-rate-limit";
import type { RequestHandler } from "express";

import { env } from "../config/env";
import { ApiError } from "../utils/api-error";
import { logger } from "../utils/logger";

/**
 * Rate limiting.
 *
 * Limits are per client IP, held in this process's memory. That is correct
 * for a single instance and is the honest limitation to know about: with
 * two or more instances behind a load balancer, each keeps its own counter,
 * so the effective limit multiplies by the instance count. Moving to a
 * shared store (Redis) is the fix, and it is a store swap rather than a
 * rewrite - see the note in docs/architecture.md.
 *
 * Accurate client IPs depend on `app.set("trust proxy", ...)` matching the
 * real number of proxies in front of the process. Set too high, a client
 * can spoof `X-Forwarded-For` and evade the limit; too low and every client
 * shares the proxy's IP, so one user's traffic throttles everyone.
 */

interface LimiterConfig {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per IP within the window. */
  limit: number;
  /** Message sent when the limit is exceeded. */
  message: string;
}

/**
 * Builds a limiter that reports failures through our normal error pipeline,
 * so a 429 body looks like every other error response.
 */
export const createRateLimiter = (config: LimiterConfig): RequestHandler => {
  const options: Partial<Options> = {
    windowMs: config.windowMs,
    limit: config.limit,

    // Modern `RateLimit-*` headers; the deprecated `X-RateLimit-*` set is off.
    standardHeaders: "draft-7",
    legacyHeaders: false,

    handler: (req, _res, next) => {
      logger.warn("rate limit exceeded", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
      });

      next(ApiError.tooManyRequests(config.message));
    },
  };

  return rateLimit(options);
};

/**
 * General API limiter, applied to everything under /api.
 * Generous by design - it is a blunt instrument against runaway clients and
 * scraping, not a security control for sensitive actions.
 */
export const apiRateLimiter = createRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  limit: env.RATE_LIMIT_MAX,
  message: "Too many requests. Please try again later.",
});

/**
 * ---------------------------------------------------------------------------
 * Stricter limiters DESIGNED for the authentication endpoints.
 *
 * These are exported but deliberately NOT mounted: the routes they protect
 * (login, OTP, password reset) do not exist yet, and Step 4 does not
 * implement authentication. When those endpoints are built, attach the
 * matching limiter in that module's routes file.
 *
 * Why much tighter than the general limit: these endpoints are the ones
 * worth brute-forcing. A 6-digit OTP is 1,000,000 combinations - trivially
 * guessable at 300 requests per 15 minutes, which is why the general
 * limiter is not sufficient protection for them.
 * ---------------------------------------------------------------------------
 */

/** Login: slows credential stuffing. Pair with per-account lockout. */
export const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many login attempts. Please try again in 15 minutes.",
});

/** OTP verification: the tightest limit, because the secret is only 6 digits. */
export const otpVerifyRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: "Too many verification attempts. Please request a new code.",
});

/** OTP resend: prevents using us to spam someone else's inbox or phone. */
export const otpResendRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: "Too many code requests. Please try again later.",
});

/** Password reset request: limits account enumeration and mail spam. */
export const passwordResetRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: "Too many password reset requests. Please try again later.",
});

/**
 * Public certificate verification: anonymous and keyed by a guessable
 * pattern (NEX-2026-FSD-0042), so it is an enumeration target.
 * See docs/api-contracts.md section 13.2.
 */
export const publicVerifyRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: "Too many verification requests. Please try again later.",
});

/**
 * IP-keyed limits alone are not enough for login and OTP: an attacker with
 * many IPs spreads the load. These must be paired with per-account controls
 * (`SystemConfig.security.maxFailedLogins`, `StudentProfile.lockedUntil`)
 * when the auth module is built. Noted as a known limitation.
 */
