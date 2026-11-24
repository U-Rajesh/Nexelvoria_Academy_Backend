/**
 * Identity vocabulary shared by every module.
 *
 * Values are copied verbatim from the frontend's `src/types/user.types.ts`
 * and `src/types/auth.types.ts`. Note `super_admin` uses an underscore -
 * the folder is named `super-admin` but the wire value is `super_admin`.
 * Do not let these drift.
 */

import type { EntityId, IsoDateTime } from "./identifier.contract";

export const USER_ROLES = ["public", "student", "teacher", "admin", "super_admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "pending", "suspended", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Lifecycle of a student account, separate from `UserStatus`.
 * Source: frontend `AccountState`.
 */
export const ACCOUNT_STATES = [
  "pending_verification",
  "pending_approval",
  "approved",
  "rejected",
  "suspended",
  /**
   * Deactivated by staff.
   *
   * Added at the Student Login integration. Before it existed,
   * `deriveAccountState()` had to report `undefined` for a deactivated
   * account because the union could not express it - so the admin UI showed
   * no badge at all for those students. The derivation is now total.
   */
  "deactivated",
  "locked",
] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/**
 * Roles that may reach the admin surface.
 *
 * Authoritative source: the frontend guards `/admin/*` with
 * `allowedRoles={['admin', 'super_admin']}` - so super_admin inherits
 * every admin route. `/super-admin/*` is guarded by `['super_admin']`
 * alone. The backend authorization middleware must reproduce exactly
 * this, including the inheritance.
 */
export const ADMIN_ROLES = ["admin", "super_admin"] as const;
export const SUPER_ADMIN_ONLY = ["super_admin"] as const;

/** Every role that is staff rather than a learner or anonymous visitor. */
export const STAFF_ROLES = ["teacher", "admin", "super_admin"] as const;

/** Roles that require an authenticated session. `public` never does. */
export const AUTHENTICATED_ROLES = ["student", "teacher", "admin", "super_admin"] as const;

/**
 * The identity derived from a verified access token.
 *
 * Exactly the three claims a token carries about the caller - nothing more.
 * It is intentionally NOT `AuthenticatedUser`: an access token excludes
 * email and every other profile field, because a JWT payload is signed but
 * not encrypted and anything placed there is world-readable (see
 * token.service.ts). Email is not added to the token just to satisfy a
 * TypeScript interface.
 *
 * `sessionId` is the `sid` claim. It is carried so a future step can check
 * the session is still live - see "session validation" in
 * docs/auth-implementation-plan.md. Nothing validates it today.
 */
export interface AuthenticatedPrincipal {
  id: EntityId;
  role: UserRole;
  /** The `sid` claim: identifies the session this token was minted for. */
  sessionId: string;
  /**
   * Students only: the access tier resolved from the database on THIS
   * request (CL-001). "limited" students may use only allowlisted endpoints;
   * authorization denies everything else. Absent for other roles.
   */
  studentAccess?: "limited" | "approved";
}

/**
 * A richer authenticated caller, including profile fields.
 *
 * DEPRECATED AS A REQUEST TYPE, but deliberately left unchanged pending the
 * backend lead's decision. It cannot be populated from an access token
 * because `email` is not a claim. Either it is retired in favour of
 * `AuthenticatedPrincipal`, or it is repurposed as the shape of a
 * user record loaded from the database when an endpoint genuinely needs the
 * profile.
 *
 * Nothing in the codebase reads `.email` from a request identity today, so
 * retiring it is a one-line change in three files. See the Step 6D report.
 */
export interface AuthenticatedUser {
  id: EntityId;
  role: UserRole;
  email: string;
}

/**
 * Audit actor. Every mutating admin/super-admin endpoint records one,
 * because the frontend already renders an audit trail (`AuditLog`).
 * The actor is derived from the session server-side - it is NEVER accepted
 * from the request body, even though the mock frontend services pass an
 * `admin: { id, name }` argument.
 */
export interface AuditActor {
  id: EntityId;
  name: string;
  role: UserRole;
}

/** Result of an audited action, mirroring the frontend's AuditLog.result. */
export const AUDIT_RESULTS = ["SUCCESS", "FAILURE", "DENIED"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** Shape the frontend expects for an audit entry. */
export interface AuditLogEntry {
  id: EntityId;
  timestamp: IsoDateTime;
  actorId: EntityId;
  actorName: string;
  actorRole: string;
  action: string;
  targetEntity: string;
  details: string;
  ipAddress?: string;
  module?: string;
  result?: AuditResult;
  userAgent?: string;
}
