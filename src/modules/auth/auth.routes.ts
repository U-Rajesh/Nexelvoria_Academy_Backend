import { Router, type RequestHandler } from "express";

import { requireAuthenticated } from "../../middleware/authorize.middleware";
import { createLoginRateLimiter } from "../../middleware/rate-limit.middleware";
import type { UserRepository } from "../users/user.repository";
import { createAuthController } from "./auth.controller";
import type { CredentialRepository } from "./credential.repository";
import { createLoginService } from "./login.service";
import { createRefreshService } from "./refresh.service";
import type { SessionRepository } from "./session.repository";
import { createSessionService } from "./session.service";

/**
 * Authentication routes, mounted at /auth (src/routes/index.ts).
 *
 *   POST /auth/login     loginRateLimiter -> controller           (public)
 *   POST /auth/refresh   controller                                (public; refresh token in body)
 *   POST /auth/logout    authenticate -> requireAuthenticated -> controller
 *   GET  /auth/me        authenticate -> requireAuthenticated -> controller
 *
 * The app-wide middleware (request id, logging, helmet, CORS, the general
 * /api rate limiter, JSON body parser) runs before all of these.
 *
 * Repositories are read through the `deps` object at REQUEST time, never at
 * construction: with no database adapters registered the app must still
 * boot and serve /health, and these routes must then answer 503 rather
 * than crash.
 */
export interface AuthRoutesDeps {
  readonly users: UserRepository;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  /** The shared `createAuthenticate` instance from src/routes/index.ts. */
  authenticate: RequestHandler;
  /** Lockout threshold (env.MAX_FAILED_LOGIN_ATTEMPTS, decision D4). */
  maxFailedLoginAttempts: number;
  /** Override for tests; defaults to a fresh 10-per-15-minutes limiter. */
  loginRateLimiter?: RequestHandler;
}

export const createAuthRoutes = (deps: AuthRoutesDeps): Router => {
  const login = createLoginService({
    get users() {
      return deps.users;
    },
    get credentials() {
      return deps.credentials;
    },
    get sessions() {
      return deps.sessions;
    },
    maxFailedLoginAttempts: deps.maxFailedLoginAttempts,
  });

  const refresh = createRefreshService({
    get users() {
      return deps.users;
    },
    get sessions() {
      return deps.sessions;
    },
  });

  const sessions = createSessionService({
    get sessions() {
      return deps.sessions;
    },
  });

  const controller = createAuthController({
    login,
    refresh,
    sessions,
    findUserById: (id) => deps.users.findById(id),
  });

  const loginLimiter = deps.loginRateLimiter ?? createLoginRateLimiter();
  const router = Router();

  router.post("/login", loginLimiter, controller.login);
  router.post("/refresh", controller.refresh);
  router.post("/logout", deps.authenticate, requireAuthenticated, controller.logout);
  router.get("/me", deps.authenticate, requireAuthenticated, controller.me);

  return router;
};
