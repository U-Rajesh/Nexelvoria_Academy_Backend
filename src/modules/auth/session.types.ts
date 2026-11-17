import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";

/**
 * The session domain.
 *
 * A session is the server-side record that makes revocation possible. The
 * access token alone cannot be revoked - it is self-contained and valid
 * until `exp` - so everything that must be revocable (logout, "terminate
 * this session", suspension, refresh-token rotation) hangs off this record.
 *
 * Confirmed requirement: the frontend's `SessionItem` renders device,
 * browser, os, ipAddress, location, lastActive and isCurrent, and offers
 * "terminate" and "terminate all others". See docs/api-contracts.md §4 and
 * docs/auth-implementation-plan.md §2.6.
 *
 * NOTHING HERE IS A DATABASE SCHEMA. These are the fields the application
 * needs; how MS SQL Server stores them is the database team's decision, and
 * the questions are in docs/database-handoff.md. No table, column, key or
 * index is implied or assumed.
 */

/**
 * Why a session stopped being usable.
 *
 * Recorded rather than inferred, because the audit trail needs to say what
 * happened, and "revoked" alone cannot distinguish a user logging out from
 * a security response to a stolen token.
 */
export const SESSION_REVOCATION_REASONS = [
  /** The user logged out of this session. */
  "logout",
  /** The user (or an admin) terminated other sessions. */
  "logout_all",
  /**
   * An already-rotated refresh token was presented again. The standard
   * signal of a stolen token: the whole family is revoked.
   */
  "token_reuse_detected",
  /** Password changed or reset - every session is invalidated. */
  "password_changed",
  /** Account suspended or deactivated by staff. */
  "account_suspended",
  /** Role changed, so the role baked into existing tokens is stale. */
  "role_changed",
  /** Terminated by an administrator. */
  "admin_terminated",
  /**
   * The server could not finish issuing credentials for this session, so it
   * was discarded rather than left in an unusable state.
   *
   * Two cases: login created a session but could not sign an access token,
   * and refresh rotated (or may have rotated) but could not complete. Added
   * at Step 6I because the alternative was labelling an internal fault
   * `admin_terminated`, which would put a lie in the audit trail - the field
   * exists precisely so a revocation can be explained.
   */
  "issuance_failed",
] as const;

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

/**
 * A server-side session.
 *
 * `sessionId` is the value carried as the `sid` claim in every access token
 * minted for this session, which is what links a presented token back to a
 * revocable record.
 */
export interface Session {
  /** Also the `sid` claim. */
  sessionId: EntityId;
  userId: EntityId;

  /**
   * SHA-256 of the current refresh token, hex encoded.
   *
   * THE RAW REFRESH TOKEN IS NEVER STORED. It is returned to the client once
   * at issue time and never persisted, logged or echoed. Only this verifier
   * is kept, so a database disclosure does not hand over usable tokens
   * (see token.service.ts for why SHA-256 is correct for a 256-bit random
   * value, unlike a password).
   */
  refreshTokenHash: string;

  /**
   * Groups a session with its rotation ancestry.
   *
   * Rotation replaces the refresh token in place, so a family is normally
   * one session. The field exists so that detecting a reused token can
   * revoke everything derived from the same original login in one
   * operation, rather than only the row that happened to be presented.
   *
   * A new session starts a family whose id is its own `sessionId`.
   */
  familyId: EntityId;

  createdAt: IsoDateTime;
  /** Updated as the session is used; feeds the UI's "lastActive". */
  lastActiveAt: IsoDateTime;
  /** Absolute expiry, from the refresh-token lifetime at issue time. */
  expiresAt: IsoDateTime;

  /** Set once revoked. Absence means "not revoked". */
  revokedAt?: IsoDateTime;
  revocationReason?: SessionRevocationReason;

  // --- Optional client metadata -----------------------------------------
  // Confirmed fields from the frontend's `SessionItem`. All optional: they
  // are derived from request headers and a geo-IP lookup, both of which can
  // be absent or unreliable, and none of them may ever be trusted for an
  // authorization decision.
  device?: string;
  browser?: string;
  os?: string;
  ipAddress?: string;
  location?: string;
}

/**
 * What a caller supplies to open a session.
 *
 * `sessionId`, `familyId`, `createdAt` and `lastActiveAt` are omitted
 * because the persistence layer owns them - a service must never invent an
 * id, exactly as elsewhere in the repository layer.
 */
export interface CreateSessionInput {
  userId: EntityId;
  refreshTokenHash: string;
  expiresAt: IsoDateTime;
  /**
   * Continues an existing rotation family. Omit for a fresh login, and the
   * new session starts its own family.
   */
  familyId?: EntityId;
  device?: string;
  browser?: string;
  os?: string;
  ipAddress?: string;
  location?: string;
}

/** Input for an atomic refresh-token rotation. See the repository port. */
export interface RotateRefreshTokenInput {
  sessionId: EntityId;
  /**
   * The hash the caller believes is current.
   *
   * Makes rotation a compare-and-set rather than a blind write. Without it,
   * two concurrent refreshes would both succeed and the loser's token would
   * be silently valid - see "concurrency" in session.repository.ts.
   */
  expectedCurrentHash: string;
  newRefreshTokenHash: string;
  /** New absolute expiry, when the rotation extends the session. */
  expiresAt?: IsoDateTime;
}

/** Scoped revocation of one session. */
export interface RevokeSessionInput {
  sessionId: EntityId;
  /**
   * The owner, as resolved from the session - NOT from the request.
   *
   * Required so the operation is scoped by user as well as session id.
   * Without it, one user could terminate another user's session by guessing
   * or leaking a session id, and the only thing standing in the way would
   * be a service remembering to check. Cross-user isolation belongs here,
   * where it cannot be forgotten.
   */
  userId: EntityId;
  reason: SessionRevocationReason;
}

/** Bulk revocation for one user, optionally sparing the current session. */
export interface RevokeAllForUserInput {
  userId: EntityId;
  reason: SessionRevocationReason;
  /**
   * Left active. This is how "terminate all other sessions" works: the
   * caller's own session survives.
   */
  exceptSessionId?: EntityId;
}

/** Bulk revocation of a rotation family, for reuse detection. */
export interface RevokeSessionFamilyInput {
  familyId: EntityId;
  reason: SessionRevocationReason;
}

/**
 * A refresh-token verifier that has already been rotated away.
 *
 * WHY THIS EXISTS. Rotation replaces `Session.refreshTokenHash`, so after a
 * rotation the previous hash is gone from the session row and a lookup by it
 * would be indistinguishable from a token that never existed. Without a
 * record of consumed hashes, a stolen-and-replayed refresh token looks merely
 * "unknown" and the theft is invisible - which is the single most important
 * signal a refresh endpoint has.
 *
 * Keeping the consumed hash is what turns that silence into a detectable
 * event. The RAW token is still never stored: this is the same SHA-256
 * verifier, and it is useless to an attacker who steals the store.
 *
 * A consumed token is NEVER usable again. It exists only to be recognised.
 */
export interface ConsumedRefreshToken {
  /** SHA-256 verifier of the token that was rotated away. Never the token. */
  refreshTokenHash: string;
  /** The session it belonged to. */
  sessionId: EntityId;
  /** The rotation family to revoke if this token is ever presented again. */
  familyId: EntityId;
  /** The owner, so a reuse event can be attributed and audited. */
  userId: EntityId;
  consumedAt: IsoDateTime;
  /**
   * When the record may be purged.
   *
   * Set to the expiry the token already had: once a token is past its own
   * expiry it would be rejected on expiry grounds anyway, so retaining its
   * hash beyond that point adds storage without adding detection. See
   * "retention" in session.repository.ts.
   */
  purgeAfter: IsoDateTime;
}

/**
 * The three possible meanings of a presented refresh token.
 *
 * A discriminated union rather than a nullable session, because the refresh
 * service must treat "consumed" very differently from "unknown": the first
 * is evidence of theft and triggers family revocation, the second is just a
 * bad request.
 */
export type RefreshTokenLookup =
  /** Matches a session's CURRENT hash. The only case that may proceed. */
  | { status: "active"; session: Session }
  /**
   * Matches a hash that was already rotated away. Never usable. The service
   * must revoke the whole family - see session.repository.ts.
   */
  | { status: "consumed"; consumed: ConsumedRefreshToken }
  /** Matches nothing. Could be a forgery, a typo, or a purged old token. */
  | { status: "unknown" };

/**
 * The ONLY session shape that may leave the authentication layer.
 *
 * A `Session` carries `refreshTokenHash` - a credential verifier - and
 * `familyId`, an internal rotation detail. Neither belongs in a response, so
 * this projection exists and is **structurally incapable** of carrying them:
 * they are not in the type, so a controller cannot leak one by forgetting to
 * strip a field.
 *
 * Fields mirror the frontend's confirmed `SessionItem` (device, browser, os,
 * ipAddress, location, lastActive, isCurrent) so the UI can render it
 * directly.
 */
export interface SessionView {
  /** The session id. Safe to expose: it is already the token's `sid`. */
  id: EntityId;

  /**
   * True for the session the caller is making this request with.
   *
   * Not stored - it is a property of the REQUEST, derived by comparing the
   * row against the authenticated principal's `sessionId`.
   */
  isCurrent: boolean;

  device?: string;
  browser?: string;
  os?: string;
  ipAddress?: string;
  location?: string;

  createdAt: IsoDateTime;
  lastActiveAt: IsoDateTime;
}

/**
 * Projects a session into the safe view.
 *
 * `currentSessionId` comes from the trusted principal, never from the client.
 */
export const toSessionView = (
  session: Session,
  currentSessionId: EntityId,
): SessionView => ({
  id: session.sessionId,
  isCurrent: session.sessionId === currentSessionId,
  ...(session.device === undefined ? {} : { device: session.device }),
  ...(session.browser === undefined ? {} : { browser: session.browser }),
  ...(session.os === undefined ? {} : { os: session.os }),
  ...(session.ipAddress === undefined ? {} : { ipAddress: session.ipAddress }),
  ...(session.location === undefined ? {} : { location: session.location }),
  createdAt: session.createdAt,
  lastActiveAt: session.lastActiveAt,
});

/** Options for listing a user's sessions. */
export interface ListSessionsOptions {
  /** Include revoked rows. Default false - the UI shows active sessions. */
  includeRevoked?: boolean;
  /** Include expired rows. Default false. */
  includeExpired?: boolean;
}

/** Derived lifecycle state. Never stored - always computed from the row. */
export type SessionStatus = "active" | "revoked" | "expired";

/**
 * Computes a session's state.
 *
 * Revocation takes precedence over expiry: a session revoked for
 * `token_reuse_detected` should report as revoked even after its natural
 * expiry has passed, because that is the security-relevant fact.
 */
export const getSessionStatus = (session: Session, now: Date = new Date()): SessionStatus => {
  if (session.revokedAt !== undefined) {
    return "revoked";
  }

  return Date.parse(session.expiresAt) <= now.getTime() ? "expired" : "active";
};

/**
 * True when a session may still be used.
 *
 * The single definition of "usable", so authentication, refresh and session
 * listing cannot drift apart on what counts as live.
 */
export const isSessionUsable = (session: Session, now: Date = new Date()): boolean =>
  getSessionStatus(session, now) === "active";
