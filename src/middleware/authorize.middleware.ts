import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  ADMIN_ROLES,
  AUTHENTICATED_ROLES,
  SUPER_ADMIN_ONLY,
  type UserRole,
} from "../contracts/user.contract";
import type { EntityId } from "../contracts/identifier.contract";
import { ApiError } from "../utils/api-error";
import { logger } from "../utils/logger";

/**
 * Authorization scaffolding.
 *
 * Nothing in this file inspects a token. Identity is established by
 * `authenticate` (Step 6D), which sets `req.principal` from a verified
 * access token; these guards only decide whether that identity is allowed.
 *
 * With no identity on the request the guards deny. That is deliberate: a
 * guard that defaults to "allow" when authentication did not run is an open
 * door. The guards FAIL CLOSED.
 *
 * Two rules that must never be relaxed:
 *
 *  1. Identity comes only from the request properties that `authenticate`
 *     sets. A role or user id arriving in a request body, query string or
 *     header is attacker-controlled and is ignored here.
 *     The mock frontend passes `admin: { id, name }` as an argument; the
 *     real API must derive the actor from the session instead.
 *
 *  2. 401 means "not authenticated", 403 means "authenticated but not
 *     permitted". The frontend's response interceptor treats 401 as a
 *     session problem, so returning 401 for a role mismatch would log the
 *     user out instead of showing them a permission error.
 */

/** The only two fields a guard needs in order to make a decision. */
interface Actor {
  id: EntityId;
  role: UserRole;
}

/**
 * Reads the identity off the request.
 *
 * `req.principal` is the SOLE authorization identity, set only by
 * `authenticate` after a verified access token. Decided by the backend lead
 * at Step 6E; the previous `req.user` fallback has been removed.
 *
 * `req.user` is still declared on the Request type (see
 * contracts/express.contract.ts) so existing and in-flight code keeps
 * compiling, but it NO LONGER GRANTS ACCESS. Rather than fail silently -
 * the worst outcome, because it looks like a mysterious 403 - a request
 * carrying `req.user` without a principal is logged loudly and denied.
 *
 * Returns undefined when no principal is present, which is what makes the
 * guards fail closed.
 */
const resolveActor = (req: Request): Actor | undefined => {
  if (req.principal !== undefined) {
    return { id: req.principal.id, role: req.principal.role };
  }

  if (req.user !== undefined) {
    logger.error(
      "req.user is set but req.principal is not: identity IGNORED and request denied. " +
        "Authorization reads req.principal only, which `authenticate` populates from a " +
        "verified access token.",
      {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl.split("?")[0] ?? req.originalUrl,
      },
    );
  }

  return undefined;
};

/**
 * Requires an authenticated caller, without checking the role.
 */
export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (resolveActor(req) === undefined) {
    next(
      ApiError.unauthorized(
        "Authentication required",
        "UNAUTHENTICATED",
      ),
    );
    return;
  }

  next();
};

/**
 * Requires the caller to hold one of `allowed`.
 *
 * Role inheritance is expressed by the allow-list itself, exactly as the
 * frontend's route guards do it: pass `ADMIN_ROLES` and both `admin` and
 * `super_admin` are accepted.
 */
export const requireRoles = (allowed: readonly UserRole[]): RequestHandler => {
  if (allowed.length === 0) {
    // A guard that allows nothing is always a programming mistake, and it
    // would silently 403 every request. Fail at startup instead.
    throw new Error("requireRoles() needs at least one role");
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = resolveActor(req);

    // Fail closed: no identity means denied, never "skip the check".
    if (user === undefined) {
      next(ApiError.unauthorized("Authentication required", "UNAUTHENTICATED"));
      return;
    }

    if (!allowed.includes(user.role)) {
      // Logged because repeated denials are a useful security signal.
      logger.warn("authorization denied", {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        userId: user.id,
        role: user.role,
        requiredRoles: allowed.join(","),
      });

      next(
        ApiError.forbidden(
          "You do not have access to this resource",
          "INSUFFICIENT_ROLE",
        ),
      );
      return;
    }

    next();
  };
};

/**
 * Ready-made guards for the four role tiers the frontend defines.
 *
 * Source of truth is `src/routes/AppRoutes.tsx`:
 *   /student/*     -> ['student']
 *   /teacher/*     -> ['teacher']
 *   /admin/*       -> ['admin', 'super_admin']   <- inheritance
 *   /super-admin/* -> ['super_admin']
 */

/** Any signed-in user, any role. */
export const requireAuthenticated = requireRoles(AUTHENTICATED_ROLES);

/** Students only. An admin is NOT a student and is denied. */
export const requireStudent = requireRoles(["student"]);

/** Teachers only. */
export const requireTeacher = requireRoles(["teacher"]);

/** Admin surface: `admin` and `super_admin` (inheritance). */
export const requireAdmin = requireRoles(ADMIN_ROLES);

/** Super-admin surface: `super_admin` only. `admin` is denied. */
export const requireSuperAdmin = requireRoles(SUPER_ADMIN_ONLY);

/**
 * NOT IMPLEMENTED - fine-grained permissions.
 *
 * `AdminProfile.permissions[]` and `GlobalRole.permissions[]` exist in the
 * frontend, but which model actually authorises a request is unresolved
 * (docs/open-questions.md Q10). Implementing a guess now would have to be
 * unpicked from every route later, so this is intentionally absent rather
 * than stubbed. Role tiers above are enough for every endpoint designed in
 * docs/api-contracts.md.
 */
