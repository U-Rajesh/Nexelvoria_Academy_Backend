import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { AuthenticatedPrincipal } from "../../contracts/user.contract";
import { requireAuthAllowingLimitedStudent, requireRoles } from "../../middleware/authorize.middleware";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";
import type { AccountService } from "./account.service";
import { createOtpRateLimiter } from "./auth.routes";
import type { SessionService } from "./session.service";

/**
 * Account security endpoints, mounted under /auth next to login:
 *
 *   POST   /auth/password/forgot             public    email OTP for a reset (AUTH-006)
 *   POST   /auth/password/reset              public    OTP + new password (AUTH-006)
 *   POST   /auth/password/change             signed in (AUTH-007)
 *   POST   /auth/logout                      signed in, ends THIS session server-side
 *   GET    /auth/sessions                    signed in, own active sessions (AUTH-009)
 *   DELETE /auth/sessions/:sessionId         signed in, ends one own session (AUTH-010)
 *   POST   /auth/sessions/end-others         signed in, ends every other own session (AUTH-010)
 *   GET    /auth/login-history               signed in, own history (AUTH-008)
 *   GET    /auth/users/:userId/login-history Super Admin only (AUTH-008)
 *
 * Self-service routes take the user and session from the verified token,
 * never from the request.
 */

const email = z.string().trim().toLowerCase().email().max(254);
const forgotSchema = z.object({ email }).strict();
const resetSchema = z
  .object({
    email,
    code: z.string().trim().regex(/^\d{6}$/, "The code is 6 digits"),
    newPassword: z.string().min(1).max(128),
  })
  .strict();
const changeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password").max(128),
    newPassword: z.string().min(1).max(128),
  })
  .strict();
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
// The repository answers a non-numeric (BIGINT) id with an empty history.
const userIdParams = z.object({ userId: z.string().trim().min(1).max(40) });
const sessionIdParams = z.object({ sessionId: z.string().trim().min(1).max(40) });

export interface AccountRoutesOptions {
  account: AccountService;
  sessions: SessionService;
  authenticate?: RequestHandler;
  /** Test hook; production uses the shared OTP limiter. */
  rateLimiter?: RequestHandler;
}

const principalOf = (req: Request): AuthenticatedPrincipal => {
  if (!req.principal) throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  return req.principal;
};

const handle =
  (work: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await work(req, res);
    } catch (err) {
      next(err);
    }
  };

const unavailable = () => ApiError.serviceUnavailable("Sessions could not be updated right now. Try again.", "SESSION_STORE_UNAVAILABLE");

export function createAccountRoutes(options: AccountRoutesOptions): Router {
  const router = Router();
  const limiter = options.rateLimiter ?? createOtpRateLimiter();
  const signedIn = options.authenticate ? [options.authenticate, requireAuthAllowingLimitedStudent] : [requireAuthAllowingLimitedStudent];
  const superAdmin = options.authenticate ? [options.authenticate, requireRoles(["super_admin"])] : [requireRoles(["super_admin"])];

  // ---- forgot / reset password (public, rate limited)
  router.post(
    "/password/forgot",
    limiter,
    handle(async (req, res) => {
      const { email: address } = forgotSchema.parse(req.body);
      await options.account.requestPasswordReset(address, req.ip);
      // Identical answer whether or not the email belongs to an account.
      sendSuccess(res, {
        status: HttpStatus.OK,
        data: { accepted: true },
        message: "If an account uses this email, a reset code has been sent to it. The code expires in 5 minutes.",
      });
    }),
  );
  router.post(
    "/password/reset",
    limiter,
    handle(async (req, res) => {
      const body = resetSchema.parse(req.body);
      await options.account.resetPassword(body.email, body.code, body.newPassword);
      sendSuccess(res, { data: { reset: true }, message: "Your password has been reset. Every session was signed out; sign in with the new password." });
    }),
  );

  // ---- signed in
  router.post(
    "/password/change",
    limiter,
    ...signedIn,
    handle(async (req, res) => {
      const body = changeSchema.parse(req.body);
      const result = await options.account.changePassword(principalOf(req), body.currentPassword, body.newPassword);
      sendSuccess(res, { data: result, message: "Password changed. Your other sessions were signed out." });
    }),
  );

  router.post(
    "/logout",
    ...signedIn,
    handle(async (req, res) => {
      const outcome = await options.sessions.logout(principalOf(req));
      if (outcome.outcome === "unavailable") throw unavailable();
      sendSuccess(res, { data: { loggedOut: true }, message: "Signed out." });
    }),
  );

  router.get(
    "/sessions",
    ...signedIn,
    handle(async (req, res) => {
      const result = await options.sessions.listMySessions(principalOf(req), { page: 1, pageSize: 100 });
      if (result.outcome !== "success") throw unavailable();
      sendSuccess(res, { data: result.data.items });
    }),
  );

  router.post(
    "/sessions/end-others",
    ...signedIn,
    handle(async (req, res) => {
      const result = await options.account.endOtherSessions(principalOf(req));
      sendSuccess(res, {
        data: result,
        message: result.sessionsEnded > 0 ? `${result.sessionsEnded} other session(s) signed out.` : "No other sessions were active.",
      });
    }),
  );

  router.delete(
    "/sessions/:sessionId",
    ...signedIn,
    handle(async (req, res) => {
      const { sessionId } = sessionIdParams.parse(req.params);
      const principal = principalOf(req);
      const outcome = await options.sessions.terminateSession(principal, sessionId);
      // Another user's session is indistinguishable from a missing one.
      if (outcome.outcome === "not_found") throw ApiError.notFound("Session not found.");
      if (outcome.outcome === "unavailable") throw unavailable();
      await options.account.recordSessionEnded(principal, sessionId);
      sendSuccess(res, { data: { sessionId, ended: true }, message: "Session signed out." });
    }),
  );

  router.get(
    "/login-history",
    ...signedIn,
    handle(async (req, res) => {
      const { limit } = historyQuery.parse(req.query);
      sendSuccess(res, { data: await options.account.loginHistory(principalOf(req).id, limit) });
    }),
  );

  router.get(
    "/users/:userId/login-history",
    ...superAdmin,
    handle(async (req, res) => {
      const { userId } = userIdParams.parse(req.params);
      const { limit } = historyQuery.parse(req.query);
      sendSuccess(res, { data: await options.account.loginHistory(userId, limit) });
    }),
  );

  return router;
}
