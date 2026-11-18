// Side-effect import: refuses to load in a production process.
import "./guard.dev";

import { Router, type RequestHandler } from "express";

import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import {
  createRegistrationService,
  type RegistrationServiceDeps,
} from "../src/modules/auth/registration.service";
import { createDevRegistrationController } from "./auth.dev.controller";

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

export interface DevAuthRoutesOptions {
  /** The three repositories the registration service writes through. */
  deps: RegistrationServiceDeps;
  /**
   * Overrides the rate limiter. Provided ONLY so a test can raise the limit
   * while exercising the other behaviours; local development always gets
   * the real one above.
   */
  rateLimiter?: RequestHandler;
}

export const createDevAuthRoutes = (options: DevAuthRoutesOptions): Router => {
  const controller = createDevRegistrationController(createRegistrationService(options.deps));
  const router = Router();

  // Limiter FIRST: an over-limit caller is rejected before the body is
  // validated and long before anything is hashed or written.
  router.post(
    "/register",
    options.rateLimiter ?? createRegistrationRateLimiter(),
    controller.register,
  );

  return router;
};
