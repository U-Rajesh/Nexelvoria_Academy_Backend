import {
  normalizePagination,
  type PaginatedResult,
  type PaginationQuery,
  toPaginatedResult,
} from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { AuthenticatedPrincipal } from "../../contracts/user.contract";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import type { SessionRepository } from "./session.repository";
import { type SessionView, toSessionView } from "./session.types";

/**
 * Session management: logout, logout-everywhere, list, terminate.
 *
 * Application services only - no HTTP, no status codes, no `ApiError`.
 *
 * ===========================================================================
 * EVERY OPERATION IS DRIVEN BY THE TRUSTED PRINCIPAL.
 *
 * `AuthenticatedPrincipal` is set only by `authenticate`, from a verified
 * access token whose session was validated against the store (Step 6F). The
 * `userId` used for every read and write comes from there and **never** from
 * a request body, query string or header. The only client-supplied value
 * accepted anywhere in this file is the *target* session id of
 * `terminateSession`, and that is checked by the repository rather than
 * trusted.
 *
 * None of these operations needs the raw refresh token, and none returns an
 * access or refresh token.
 * ===========================================================================
 *
 * ===========================================================================
 * OWNERSHIP IS ENFORCED IN THE WRITE, NOT BY A PRIOR READ.
 *
 * `revokeSession` matches on `sessionId` AND `userId` together and throws
 * `RecordNotFoundError` when either fails to match. So:
 *
 *  - there is no read-then-write window in which a session could change
 *    hands between the check and the revocation;
 *  - another user's session is indistinguishable from one that does not
 *    exist, so nothing is leaked about sessions the caller does not own.
 *
 * This is why no contract change was needed for this step. Had ownership
 * been checkable only by reading first, that race would have had to be
 * closed in the port.
 * ===========================================================================
 */

/**
 * Outcome of revoking a single session.
 *
 * `not_found` deliberately covers BOTH "no such session" and "belongs to
 * somebody else" - the distinction must never reach a client, or the
 * endpoint becomes a probe for other people's session ids.
 */
export type RevokeSessionOutcome =
  /**
   * The session is revoked. Returned whether this call did the revoking or
   * it was already revoked - the operation is idempotent, and the caller
   * only needs to know the end state.
   *
   * Deliberately carries no "was it already revoked" flag: `revokeSession`
   * returns the session AFTER revoking, so prior state cannot be derived
   * from it, and reporting it would cost an extra read that nothing
   * requires.
   */
  | { outcome: "success" }
  | { outcome: "not_found" }
  /** The write failed or its outcome could not be established. */
  | { outcome: "unavailable" };

/**
 * What a bulk revocation actually achieved. Deliberately not optimistic.
 *
 * ===========================================================================
 * WHAT `revokeAllForUser` DOES AND DOES NOT PROMISE.
 *
 * Its contract is "how many sessions this call newly revoked". That means it
 * revokes the sessions that were active WHEN IT RAN. It is **not a barrier**:
 * nothing stops a concurrent login from creating a new session a microsecond
 * later, and such a session is perfectly valid.
 *
 * So no field here may be read as "this user currently has no sessions".
 * `activeWhenLastChecked` is a point-in-time observation that may already be
 * stale by the time the caller reads it, and it is named to say so.
 *
 * Closing that window would need a barrier the repository does not provide -
 * for example a per-user "sessions blocked until" marker that login also
 * consults, or a transaction spanning both operations (Q-X1 / Q-CR6).
 * Neither exists, so none is claimed.
 * ===========================================================================
 */
export interface LogoutAllSummary {
  /** Newly revoked by this call, when the repository reported a count. */
  sessionsRevoked: number | "unknown";
  /**
   * Sessions still active at the moment a check was made.
   *
   * `"not_checked"` on the clean path: the repository returning normally
   * already means it revoked everything active at that instant, so no extra
   * read is taken. A number appears only when the service actually looked,
   * which it does after a failure.
   */
  activeWhenLastChecked: number | "unknown" | "not_checked";
}

/**
 * Outcome of revoking every session for a user.
 *
 * `success` is returned ONLY when nothing is known to remain active.
 * Anything less is `incomplete`, because the repository does not promise an
 * atomic multi-row revocation and this service will not claim one.
 */
/**
 * Outcome of revoking every session for a user.
 *
 * `success` means "every session that was active when this ran is revoked",
 * NOT "this user has no sessions" - see `LogoutAllSummary`.
 *
 * `incomplete` means sessions are known to remain, because the repository
 * does not promise an atomic multi-row revocation and this service will not
 * claim one.
 */
export type LogoutAllResult =
  | { outcome: "success"; summary: LogoutAllSummary }
  | { outcome: "incomplete"; summary: LogoutAllSummary }
  | { outcome: "unavailable" };

export type ListSessionsResult =
  | { outcome: "success"; data: PaginatedResult<SessionView> }
  | { outcome: "unavailable" };

export interface SessionServiceDeps {
  sessions: SessionRepository;
}

export interface SessionService {
  /** Revokes the session the caller is currently using. */
  logout(principal: AuthenticatedPrincipal): Promise<RevokeSessionOutcome>;

  /** Revokes every session for the caller, including the current one. */
  logoutEverywhere(principal: AuthenticatedPrincipal): Promise<LogoutAllResult>;

  /** Lists the caller's active sessions, newest activity first. */
  listMySessions(
    principal: AuthenticatedPrincipal,
    pagination?: Partial<PaginationQuery>,
  ): Promise<ListSessionsResult>;

  /** Revokes one of the caller's sessions by id. */
  terminateSession(
    principal: AuthenticatedPrincipal,
    targetSessionId: unknown,
  ): Promise<RevokeSessionOutcome>;
}

export const createSessionService = (deps: SessionServiceDeps): SessionService => {
  /**
   * Revokes one session owned by the principal.
   *
   * Shared by `logout` and `terminateSession`: they differ only in where the
   * session id comes from, and both must enforce ownership identically.
   *
   * `revokeSession` is documented idempotent, so the retry below is safe,
   * and a confirmation read resolves the case where the write landed but the
   * call reported an error. Nothing is reported as successful unless it was
   * observed - a failure returns `unavailable`.
   */
  const revokeOwnedSession = async (
    userId: EntityId,
    sessionId: EntityId,
    operation: "logout" | "terminate",
  ): Promise<RevokeSessionOutcome> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await deps.sessions.revokeSession({
          sessionId,
          userId,
          reason: "logout",
        });

        logger.info(`${operation} succeeded`, { userId, sessionId });

        return { outcome: "success" };
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          // No session matches BOTH ids: unknown, or someone else's. The
          // caller is told neither. Not retried - it will not change.
          logger.warn(`${operation} refused: no such session for this user`, {
            userId,
            sessionId,
          });

          return { outcome: "not_found" };
        }

        logger.error(`${operation} attempt failed`, {
          userId,
          sessionId,
          attempt,
          // Error CLASS only - never the message. Driver exceptions embed
          // credentials, hosts and connection strings in their text.
          errorType: describeError(err),
        });

        // The write may have landed despite the error.
        try {
          const session = await deps.sessions.findBySessionId(sessionId);

          if (session !== null && session.userId === userId && session.revokedAt !== undefined) {
            return { outcome: "success" };
          }
        } catch {
          // Cannot confirm; fall through to the retry, then to unavailable.
        }
      }
    }

    logger.error(`${operation} FAILED: the session could not be revoked and may remain active`, {
      userId,
      sessionId,
    });

    return { outcome: "unavailable" };
  };

  return {
    async logout(principal: AuthenticatedPrincipal): Promise<RevokeSessionOutcome> {
      // Both ids come from the verified token. Nothing is read from the
      // request, and the raw refresh token is not needed.
      return revokeOwnedSession(principal.id, principal.sessionId, "logout");
    },

    async logoutEverywhere(principal: AuthenticatedPrincipal): Promise<LogoutAllResult> {
      // No `exceptSessionId`: logging out everywhere includes the session
      // making the request.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const revoked = await deps.sessions.revokeAllForUser({
            userId: principal.id,
            reason: "logout_all",
          });

          logger.info("logout everywhere succeeded", {
            userId: principal.id,
            sessionsRevoked: revoked,
          });

          // The repository returning normally means every session active at
          // that instant is revoked - that is its contract. No extra read is
          // taken, so nothing is CLAIMED about the current state: a
          // concurrent login may already have created a new session.
          return {
            outcome: "success",
            summary: { sessionsRevoked: revoked, activeWhenLastChecked: "not_checked" },
          };
        } catch (err) {
          logger.error("logout everywhere attempt failed", {
            userId: principal.id,
            attempt,
            // Error CLASS only - never the message. Driver exceptions embed
          // credentials, hosts and connection strings in their text.
          errorType: describeError(err),
          });

          // A bulk revocation is NOT promised to be atomic, so a failure may
          // have revoked some sessions and not others. Establish what is
          // actually left rather than guessing.
          try {
            const remaining = await deps.sessions.listSessionsForUser(principal.id);

            if (remaining.length === 0) {
              // Everything is gone, even though the call reported an error.
              return {
                outcome: "success",
                summary: { sessionsRevoked: "unknown", activeWhenLastChecked: 0 },
              };
            }

            if (attempt === 2) {
              logger.error(
                "logout everywhere INCOMPLETE: some sessions remain active and are still usable",
                { userId: principal.id, remainingActive: remaining.length },
              );

              return {
                outcome: "incomplete",
                summary: {
                  sessionsRevoked: "unknown",
                  activeWhenLastChecked: remaining.length,
                },
              };
            }
          } catch {
            // Cannot establish the remaining state; try again, then give up.
          }
        }
      }

      logger.error("logout everywhere FAILED: the outcome could not be established", {
        userId: principal.id,
      });

      return { outcome: "unavailable" };
    },

    async listMySessions(
      principal: AuthenticatedPrincipal,
      pagination: Partial<PaginationQuery> = {},
    ): Promise<ListSessionsResult> {
      // `Math.trunc`/`Math.max` alone let NaN and Infinity through, which
      // put `pageSize: NaN` and `totalPages: NaN` in the response - and
      // those serialise to `null`. The shared normaliser clamps every input
      // to safe integers within the contract's bounds.
      const { page, pageSize } = normalizePagination(pagination);

      let sessions;

      try {
        // Scoped to the principal's own id. Defaults to active sessions
        // only, which is what the confirmed UI shows.
        sessions = await deps.sessions.listSessionsForUser(principal.id);
      } catch (err) {
        logger.error("could not list sessions", {
          userId: principal.id,
          // Error CLASS only - never the message. Driver exceptions embed
          // credentials, hosts and connection strings in their text.
          errorType: describeError(err),
        });

        return { outcome: "unavailable" };
      }

      // Paginated in the service rather than the repository: a user has a
      // handful of devices, not thousands, so slicing here avoids widening
      // the port for no benefit. It uses the existing `PaginatedResult`
      // contract, so the shape the frontend expects is unchanged.
      const start = (page - 1) * pageSize;

      const view = sessions
        .slice(start, start + pageSize)
        // The projection is what keeps `refreshTokenHash` and `familyId` out
        // of the response: they are not in `SessionView` at all.
        .map((session) => toSessionView(session, principal.sessionId));

      return {
        outcome: "success",
        data: toPaginatedResult(view, sessions.length, { page, pageSize }),
      };
    },

    async terminateSession(
      principal: AuthenticatedPrincipal,
      targetSessionId: unknown,
    ): Promise<RevokeSessionOutcome> {
      // The ONLY client-supplied value in this service. It is never trusted:
      // the owner is taken from the principal and the repository matches on
      // both, so a session id belonging to someone else simply does not
      // match and reports `not_found`.
      if (typeof targetSessionId !== "string" || targetSessionId.trim() === "") {
        logger.warn("terminate refused: malformed session id", { userId: principal.id });
        return { outcome: "not_found" };
      }

      // Terminating the CURRENT session is permitted: the confirmed frontend
      // lists it with `isCurrent` alongside the others, and refusing would
      // mean the one session a user can definitely prove they own is the one
      // they cannot end. It is equivalent to logout, which is why both paths
      // record the same `logout` reason.
      return revokeOwnedSession(principal.id, targetSessionId.trim(), "terminate");
    },
  };
};
