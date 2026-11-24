import { decideStudentAccess } from "../students/student-access";
import type { StudentRepository } from "../students/student.repository";
import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type { UserRepository } from "../users/user.repository";
import type { User } from "../users/user.types";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import { OptimisticLockError } from "../../repositories/repository.errors";
import { SessionNotActiveError } from "./session.errors";
import type { SessionRepository } from "./session.repository";
import { getSessionStatus, type Session } from "./session.types";
import {
  REFRESH_TOKEN_BYTES,
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
} from "./token.service";

/**
 * The refresh application service.
 *
 * Exchanges an opaque refresh token for a new access token and a rotated
 * refresh token. Contains the business rules; knows nothing about HTTP.
 *
 * NO HTTP HERE, and deliberately no opinion on transport: **D4** (whether
 * the refresh token travels in a response body or an httpOnly cookie) is
 * unresolved, so the service returns the token to its caller and takes no
 * position. No endpoint may expose it until D4 is decided.
 *
 * ---------------------------------------------------------------------------
 * A REFRESH TOKEN IS NOT A JWT.
 *
 * It is 32 bytes of CSPRNG output, base64url encoded. It carries no claims,
 * is never parsed, and is never verified cryptographically. It is meaningful
 * only as a lookup key against the stored session, which is precisely what
 * makes revocation possible. Nothing here calls into `jsonwebtoken` for the
 * refresh token itself.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * LIFECYCLE
 *
 *   1. validate the token's shape (cheap, before any I/O)
 *   2. hash it and resolve it: active | consumed | unknown
 *        consumed -> REUSE: revoke the whole family, refuse
 *        unknown  -> refuse
 *   3. check the session is usable (not revoked, not expired)
 *   4. gate one: re-read the user - exists, active, current role
 *   5. rotate atomically (compare-and-set on the presented hash)
 *        lost CAS -> REUSE: revoke the family, refuse
 *   6. gate two: re-read the user again, immediately before signing
 *   7. sign the access token with the role from gate two
 *   8. return the new pair
 *
 * Steps 4 and 6 mirror the hardened login flow: the first avoids consuming a
 * token for a refresh that cannot succeed, the second is authoritative and
 * sits as close to signing as possible.
 * ---------------------------------------------------------------------------
 */

/**
 * Why a refresh was refused.
 *
 * INTERNAL vocabulary. Most of these must collapse into one generic 401
 * before reaching a client: the distinctions describe how a token failed,
 * and a client that can tell "unknown token" from "reused token" learns
 * whether it holds something that was ever valid.
 */
export type RefreshFailureReason =
  /** Malformed, unknown, revoked or expired - one reason for all of them. */
  | "invalid_refresh_token"
  /**
   * An already-rotated token was presented. The family has been revoked.
   * Separate from `invalid_refresh_token` for LOGGING and auditing only -
   * it must look identical to the client.
   */
  | "token_reuse_detected"
  /** The user no longer exists, or may not sign in. */
  | "user_not_authorized"
  /** A lookup, rotation or signing step could not be completed. */
  | "refresh_unavailable";

export interface RefreshSuccess {
  /** The authoritative user record, as read by the final gate. */
  user: User;

  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;

  /**
   * The rotated opaque refresh token, returned EXACTLY ONCE.
   *
   * The previous token is now consumed and can never be used again.
   * Transport is undecided - see **D4**.
   */
  refreshToken: string;
  refreshTokenExpiresAt: IsoDateTime;

  /** Unchanged by rotation: the session continues. */
  sessionId: EntityId;
}

/**
 * Whether the compensating cleanup for a failed refresh actually committed.
 *
 * INTERNAL. It must never be serialised into a response - a controller maps
 * every failure to one generic status. It is on the result so a caller
 * cannot ignore the distinction, and so metrics and alerting can act on it:
 * a `failed` cleanup after reuse detection is an incident, not a log line.
 *
 * Unlike the attempt counter removed from the login result, this carries no
 * account-existence signal: it describes OUR internal state, not the
 * account's, so including it is not an enumeration risk.
 */
export type CleanupOutcome =
  /** Nothing needed cleaning up. */
  | "not_required"
  /** The revocation is confirmed written. */
  | "committed"
  /** The revocation failed, or its outcome could not be established. */
  | "failed";

export type RefreshResult =
  | { outcome: "success"; data: RefreshSuccess }
  | {
      outcome: "failure";
      reason: RefreshFailureReason;
      /** See `CleanupOutcome`. Never serialise this. */
      cleanup: CleanupOutcome;
    };

export interface RefreshServiceDeps {
  users: UserRepository;
  sessions: SessionRepository;
  /**
   * CL-001: when supplied, students are admitted by `decideStudentAccess`
   * (limited or approved), exactly as at sign-in. Without it, refresh keeps
   * the strict `active`-only rule for everyone.
   */
  students?: StudentRepository;
}

/**
 * The ONLY status permitted to refresh.
 *
 * An allow-list, not a deny-list, and that is the whole point: the previous
 * version listed the statuses that were blocked, so any status added to
 * `UserStatus` later - "archived", "locked", "pending_deletion" - would have
 * been permitted by default. Requiring equality with "active" fails closed,
 * so a new status is denied until someone deliberately allows it.
 */
const REQUIRED_STATUS: UserStatus = "active";

/**
 * Shape of a refresh token: base64url, and the exact length 32 random bytes
 * encode to. Checked before any I/O so a junk value costs no database work.
 */
const REFRESH_TOKEN_LENGTH = Math.ceil((REFRESH_TOKEN_BYTES * 4) / 3);
const REFRESH_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${REFRESH_TOKEN_LENGTH}}$`);

export interface RefreshService {
  refresh(presentedToken: unknown): Promise<RefreshResult>;
}

export const createRefreshService = (deps: RefreshServiceDeps): RefreshService => {
  const fail = (
    reason: RefreshFailureReason,
    cleanup: CleanupOutcome = "not_required",
  ): RefreshResult => ({ outcome: "failure", reason, cleanup });

  /**
   * Confirms whether one session is revoked.
   *
   * A read AFTER an unconditional write, used only to establish what
   * happened - it gates nothing, so this is not a read-then-write sequence.
   * It also resolves the timeout-that-committed case: the call can report an
   * error while the revocation actually landed.
   */
  const isSessionRevoked = async (sessionId: EntityId): Promise<boolean | "unknown"> => {
    try {
      const session = await deps.sessions.findBySessionId(sessionId);

      if (session === null) {
        // Gone entirely: it cannot be used, which is the property we wanted.
        return true;
      }

      return session.revokedAt !== undefined;
    } catch {
      return "unknown";
    }
  };

  /**
   * Revokes one session and REPORTS whether that actually committed.
   *
   * `revokeSession` is documented idempotent, so a retry is safe. The
   * sequence is: attempt, then on error confirm by reading, then one retry,
   * then confirm again. Nothing here is claimed to succeed - the caller gets
   * `failed` when the outcome cannot be established.
   */
  const attemptRevokeSession = async (
    sessionId: EntityId,
    userId: EntityId,
  ): Promise<CleanupOutcome> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await deps.sessions.revokeSession({
          sessionId,
          userId,
          reason: "issuance_failed",
        });

        return "committed";
      } catch (err) {
        logger.error("session cleanup attempt failed", {
          userId,
          sessionId,
          attempt,
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        // The write may have landed despite the error.
        const revoked = await isSessionRevoked(sessionId);

        if (revoked === true) {
          return "committed";
        }
      }
    }

    // Deliberately loud: a session may be left listed as active.
    logger.error(
      "SESSION CLEANUP FAILED: the session could not be revoked and may remain listed as active",
      { userId, sessionId },
    );

    return "failed";
  };

  /**
   * Revokes a rotation family after detected reuse, and reports whether it
   * committed.
   *
   * `revokeSessionFamily` revokes only sessions that are not already
   * revoked and returns a count, so it is idempotent and safe to retry.
   *
   * A failure here is the most serious cleanup failure in the system: the
   * response to suspected token theft did not take effect, so whichever
   * holder is the attacker keeps their access until the sessions expire.
   */
  const attemptRevokeFamily = async (
    familyId: EntityId,
    userId: EntityId,
  ): Promise<CleanupOutcome> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const revoked = await deps.sessions.revokeSessionFamily({
          familyId,
          reason: "token_reuse_detected",
        });

        logger.error("refresh token reuse detected: session family revoked", {
          userId,
          familyId,
          sessionsRevoked: revoked,
        });

        return "committed";
      } catch (err) {
        logger.error("family revocation attempt failed", {
          userId,
          familyId,
          attempt,
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        // Confirm by checking no ACTIVE session remains in the family.
        try {
          const active = await deps.sessions.listSessionsForUser(userId);

          if (!active.some((session) => session.familyId === familyId)) {
            return "committed";
          }
        } catch {
          // Cannot confirm; fall through to the retry or to `failed`.
        }
      }
    }

    // The loudest log in the module: a theft response did not take effect.
    logger.error(
      "SECURITY: refresh token reuse detected but the session family could NOT be revoked. " +
        "Sessions in this family remain usable until they expire and require manual revocation.",
      { userId, familyId },
    );

    return "failed";
  };

  /**
   * Re-reads the user and confirms they may still hold a session.
   *
   * Done by the refresh service itself rather than relying on sessions being
   * revoked when a user is suspended. That coordination is required (§16.3)
   * but is not implemented anywhere yet - the modules that change status and
   * role do not exist - so refresh would otherwise keep minting tokens for a
   * suspended account for as long as the refresh token lived.
   */
  const authorizeUser = async (
    userId: EntityId,
  ): Promise<{ ok: true; user: User } | { ok: false; reason: RefreshFailureReason }> => {
    let user: User | null;

    try {
      user = await deps.users.findById(userId);
    } catch (err) {
      logger.error("refresh refused: user state could not be read", {
        userId,
        // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
      });

      return { ok: false, reason: "refresh_unavailable" };
    }

    if (user === null) {
      logger.warn("refresh refused: user no longer exists", { userId });
      return { ok: false, reason: "user_not_authorized" };
    }

    if (user.role === "student" && deps.students !== undefined) {
      let student;
      try {
        student = await deps.students.findById(userId);
      } catch (err) {
        logger.error("refresh refused: student state could not be read", { userId, errorType: describeError(err) });
        return { ok: false, reason: "refresh_unavailable" };
      }
      const decision = decideStudentAccess({
        status: user.status,
        student: student === null ? null : { adminApprovalStatus: student.adminApprovalStatus, isEmailVerified: student.isEmailVerified },
      });
      if (!decision.allowed) {
        logger.warn("refresh refused: student account not permitted", { userId, reason: decision.reason });
        return { ok: false, reason: "user_not_authorized" };
      }
      return { ok: true, user };
    }

    if (user.status !== REQUIRED_STATUS) {
      // Covers every non-active status, including any added in future.
      logger.warn("refresh refused: account status is not active", {
        userId,
        status: user.status,
      });

      return { ok: false, reason: "user_not_authorized" };
    }

    return { ok: true, user };
  };

  return {
    async refresh(presentedToken: unknown): Promise<RefreshResult> {
      // --- 1. shape ------------------------------------------------------
      // Validated before any I/O. The token is never logged, here or below.
      if (typeof presentedToken !== "string" || !REFRESH_TOKEN_PATTERN.test(presentedToken)) {
        logger.debug("refresh refused: malformed refresh token");
        return fail("invalid_refresh_token");
      }

      const presentedHash = hashRefreshToken(presentedToken);

      // --- 2. resolve ----------------------------------------------------
      let lookup: Awaited<ReturnType<SessionRepository["resolveRefreshToken"]>>;

      try {
        lookup = await deps.sessions.resolveRefreshToken(presentedHash);
      } catch (err) {
        logger.error("refresh refused: token lookup failed", {
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        return fail("refresh_unavailable");
      }

      if (lookup.status === "unknown") {
        // A forgery, a typo, or a consumed token whose record has been
        // purged. Indistinguishable to the client.
        logger.warn("refresh refused: unknown refresh token");
        return fail("invalid_refresh_token");
      }

      if (lookup.status === "consumed") {
        // --- 3. REUSE ---------------------------------------------------
        // An already-rotated token was presented. Whichever of the two
        // holders is the attacker is unknowable, so the entire family goes
        // and nothing is issued.
        const cleanup = await attemptRevokeFamily(
          lookup.consumed.familyId,
          lookup.consumed.userId,
        );

        return fail("token_reuse_detected", cleanup);
      }

      const session: Session = lookup.session;
      const status = getSessionStatus(session);

      if (status !== "active") {
        // Revoked (logout, suspension, earlier reuse) or expired. The token
        // matched a real session, but the session may not be used.
        logger.warn("refresh refused: session is not active", {
          userId: session.userId,
          sessionStatus: status,
          revocationReason: session.revocationReason,
        });

        return fail("invalid_refresh_token");
      }

      // --- 4. gate one: user authorization -------------------------------
      // Before consuming the token, so a doomed refresh does not burn it.
      const preGate = await authorizeUser(session.userId);

      if (!preGate.ok) {
        return fail(preGate.reason);
      }

      // --- 5. rotate -----------------------------------------------------
      const next = generateRefreshToken();

      let rotated: Session;

      try {
        rotated = await deps.sessions.rotateRefreshToken({
          sessionId: session.sessionId,
          // Compare-and-set on the hash we actually resolved. One atomic
          // statement in the adapter: the consumed record is written and
          // the new hash installed together.
          expectedCurrentHash: presentedHash,
          newRefreshTokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
        });
      } catch (err) {
        if (err instanceof OptimisticLockError) {
          // The hash is no longer current, which means a concurrent request
          // consumed it first. Same meaning as `consumed`, same response:
          // revoke the family. This is the branch that makes two
          // simultaneous refreshes safe - exactly one can win.
          const cleanup = await attemptRevokeFamily(session.familyId, session.userId);
          return fail("token_reuse_detected", cleanup);
        }

        if (err instanceof SessionNotActiveError) {
          // Revoked or expired between the check above and the write.
          logger.warn("refresh refused: session became inactive during rotation", {
            userId: session.userId,
            sessionStatus: err.status,
          });

          return fail("invalid_refresh_token");
        }

        // Anything else leaves the outcome UNCERTAIN: a timeout may have
        // committed. Discarding the session converts an ambiguous state
        // into a deterministic one, and avoids the client's next refresh
        // looking like token theft in the audit trail.
        logger.error("refresh failed: rotation outcome is uncertain, discarding the session", {
          userId: session.userId,
          sessionId: session.sessionId,
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        const cleanup = await attemptRevokeSession(session.sessionId, session.userId);
        return fail("refresh_unavailable", cleanup);
      }

      // --- 6. gate two: authoritative, immediately before signing --------
      const finalGate = await authorizeUser(rotated.userId);

      if (!finalGate.ok) {
        // The token has already rotated, so the caller cannot be left with
        // a usable credential: discard the session.
        const cleanup = await attemptRevokeSession(rotated.sessionId, rotated.userId);
        return fail(finalGate.reason, cleanup);
      }

      // --- 7. sign -------------------------------------------------------
      try {
        const issued = issueAccessToken({
          userId: finalGate.user.id,
          // The CURRENT role, from the final read - never a client-supplied
          // value, and never the role captured when the session began.
          role: finalGate.user.role,
          sessionId: rotated.sessionId,
        });

        logger.info("refresh succeeded", {
          userId: finalGate.user.id,
          role: finalGate.user.role,
          sessionId: rotated.sessionId,
        });

        return {
          outcome: "success",
          data: {
            user: finalGate.user,
            accessToken: issued.token,
            expiresIn: issued.expiresIn,
            refreshToken: next.token,
            refreshTokenExpiresAt: next.expiresAt,
            sessionId: rotated.sessionId,
          },
        };
      } catch (err) {
        // The rotation committed but the caller will never receive the new
        // token, so the session is unreachable. Discard it rather than leave
        // a live row nobody can use.
        logger.error("refresh failed: could not issue an access token", {
          userId: rotated.userId,
          sessionId: rotated.sessionId,
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        const cleanup = await attemptRevokeSession(rotated.sessionId, rotated.userId);
        return fail("refresh_unavailable", cleanup);
      }
    },
  };

};
