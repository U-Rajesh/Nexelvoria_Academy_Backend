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
 * The authenticated caller, attached to the request by the (future) auth
 * middleware. Declared here so modules can depend on the shape before
 * authentication is implemented in a later step.
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
