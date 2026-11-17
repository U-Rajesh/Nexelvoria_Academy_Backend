import type { EntityId } from "../../contracts/identifier.contract";
import { RepositoryError } from "../../repositories/repository.errors";
import type { SessionRevocationReason, SessionStatus } from "./session.types";

/**
 * Session-specific repository errors.
 *
 * Extends the shared `RepositoryError` so a service can still catch every
 * repository failure at once, and stays free of HTTP concepts for the same
 * reason as the rest of the repository layer - the mapping to a status code
 * belongs in the service.
 *
 * Mapping the future refresh service should apply:
 *   RecordNotFoundError   -> 401   (unknown session; reveal nothing)
 *   SessionNotActiveError -> 401   (revoked or expired)
 *   OptimisticLockError   -> 401   AND revoke the rotation family,
 *                                  because a stale hash means the token was
 *                                  already consumed - see §"reuse" in
 *                                  session.repository.ts
 */

/**
 * A session exists but may not be acted on, because it is revoked or
 * expired.
 *
 * Distinct from `RecordNotFoundError` on purpose: the repository knows the
 * difference, and the server log should record it. The CLIENT must still be
 * told nothing beyond a generic 401 - "revoked" versus "expired" versus
 * "unknown" is an oracle.
 */
export class SessionNotActiveError extends RepositoryError {
  readonly sessionId: EntityId;
  readonly status: Exclude<SessionStatus, "active">;
  /** Present only when the session was revoked rather than expired. */
  readonly revocationReason?: SessionRevocationReason;

  constructor(
    sessionId: EntityId,
    status: Exclude<SessionStatus, "active">,
    revocationReason?: SessionRevocationReason,
  ) {
    super(
      `Session ${sessionId} is ${status} and cannot be used` +
        (revocationReason === undefined ? "" : ` (revoked: ${revocationReason})`),
    );

    this.sessionId = sessionId;
    this.status = status;

    if (revocationReason !== undefined) {
      this.revocationReason = revocationReason;
    }
  }
}
