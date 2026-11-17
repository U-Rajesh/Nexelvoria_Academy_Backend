import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  ADMIN_ROLES,
  AUTHENTICATED_ROLES,
  SUPER_ADMIN_ONLY,
  type UserRole,
} from "../contracts/user.contract";
import { ApiError } from "../utils/api-error";
import { logger } from "../utils/logger";

/**
 * Authorization scaffolding.
 *
 * AUTHENTICATION IS NOT IMPLEMENTED YET. Nothing in this file inspects a
 * token, and nothing populates `req.user` - that is the authentication
 * middleware's job in a later step, once Q13 (token strategy) is decided.
 *
 * These guards therefore deny every request today. That is deliberate and
 * correct: a guard that defaults to "allow" while authentication is missing
 * is an open door. The guards FAIL CLOSED.
 *
 * Two rules that must never be relaxed:
 *
 *  1. Identity comes only from `req.user`, which only the authentication
 *     middleware may set. A role or user id arriving in a request body,
 *     query string or header is attacker-controlled and is ignored here.
 *     The mock frontend passes `admin: { id, name }` as an argument; the
 *     real API must derive the actor from the session instead.
 *
 *  2. 401 means "not authenticated", 403 means "authenticated but not
 *     permitted". The frontend's response interceptor treats 401 as a
 *     session problem, so returning 401 for a role mismatch would log the
 *     user out instead of showing them a permission error.
 */

/**
 * Requires an authenticated caller, without checking the role.
 *
 * Returns 401 until authentication exists.
 */
export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user === undefined) {
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
    const user = req.user;

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
