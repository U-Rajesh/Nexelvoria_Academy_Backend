import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type {
  CreateSessionInput,
  ListSessionsOptions,
  RefreshTokenLookup,
  RevokeAllForUserInput,
  RevokeSessionFamilyInput,
  RevokeSessionInput,
  RotateRefreshTokenInput,
  Session,
} from "./session.types";

/**
 * The `sessions` repository PORT.
 *
 * Interface only - no SQL, no driver, no MS SQL Server concept, following
 * the Step 5 pattern. The database team implements it; the in-memory fake
 * in `tests/fakes/` satisfies it for tests.
 *
 * ===========================================================================
 * READ-STATE CONVENTION
 *
 * `findBySessionId` returns the row REGARDLESS of whether it is revoked or
 * expired, and the caller decides. Authentication needs to distinguish "no
 * such session" from "revoked" from "expired" in its logs, which a bare
 * `null` cannot express. `null` therefore means strictly "no such row".
 *
 * Use `isSessionUsable()` from session.types.ts to decide whether a returned
 * row may be acted on - one definition, so authentication, refresh and
 * listing cannot drift apart on what counts as live.
 *
 * `findByRefreshTokenHash` matches ONLY a session's CURRENT hash. It does
 * not and cannot recognise a rotated-away token, because rotation replaces
 * that hash. Recognising a consumed token is `resolveRefreshToken`'s job -
 * see below.
 * ===========================================================================
 *
 * ===========================================================================
 * REFRESH-TOKEN REUSE DETECTION
 *
 * Rotation replaces `Session.refreshTokenHash`. The previous hash therefore
 * disappears from the session row, and a lookup by it would be
 * indistinguishable from a token that never existed - so a stolen token,
 * replayed after the legitimate client has rotated, would look like an
 * ordinary bad request. That silence is the problem: replay of a rotated
 * token is the clearest signal of refresh-token theft there is.
 *
 * So every rotation RECORDS the hash it consumed as a `ConsumedRefreshToken`,
 * carrying its session, family and owner. `resolveRefreshToken` then returns
 * one of three states, and the caller branches on them:
 *
 *   active   -> matches a session's current hash. The only case that proceeds.
 *   consumed -> already rotated away. NEVER usable again. Treat as theft.
 *   unknown  -> matches nothing: forgery, typo, or a purged old token.
 *
 * THE REQUIRED RESPONSE TO `consumed` (for the future refresh service, which
 * does not exist yet):
 *
 *   1. Do NOT issue tokens.
 *   2. `revokeSessionFamily({ familyId: consumed.familyId,
 *                             reason: "token_reuse_detected" })`
 *      - the whole family, not just the presented row, because which of the
 *        two holders is the attacker is unknowable.
 *   3. Write an audit entry against `consumed.userId`.
 *   4. Return a generic 401. Never tell the client that reuse was detected.
 *
 * A stale `expectedCurrentHash` on `rotateRefreshToken` means the same thing
 * and gets the same response - see "concurrency" below.
 *
 * HONEST LIMITATION: a legitimate client that double-submits a refresh (a
 * retry, two tabs) is indistinguishable from an attacker replaying a stolen
 * token, so it will be logged out of the whole family. That is the standard
 * trade-off (OAuth 2.0 Security BCP) and it favours safety. If it proves
 * disruptive in practice, the usual mitigation is a short grace window in
 * which re-presenting the just-consumed token returns the SAME newly issued
 * token rather than revoking. That is a refresh-service decision and is
 * deliberately NOT implemented here.
 * ===========================================================================
 *
 * ===========================================================================
 * RETENTION AND CLEANUP
 *
 * `ConsumedRefreshToken.purgeAfter` is set to the expiry the consumed token
 * already had. Past that point the token would be rejected on expiry grounds
 * regardless, so keeping its hash adds storage without adding detection.
 *
 * Volume to plan for: with a 15-minute access token and a 30-day remembered
 * refresh lifetime, one long-lived session can rotate ~2,900 times, so the
 * consumed history is far larger than the session table. It therefore needs
 * a real cleanup job, not best intentions:
 *
 *   - Call `purgeConsumedRefreshTokens(now)` on a schedule (hourly is ample).
 *     Owner of that schedule is an open question for deployment.
 *   - Index on the hash for the lookup, and on `purgeAfter` for the purge.
 *   - Purging is safe at any time: a purged token degrades from "consumed"
 *     to "unknown", which still denies access. Detection is lost, access is
 *     not granted.
 *
 * Raised for the database team in docs/database-handoff.md.
 * ===========================================================================
 *
 * ===========================================================================
 * ATOMICITY AND CONCURRENCY - requirements on the adapter.
 *
 * ROTATION MUST BE ATOMIC. `rotateRefreshToken` performs four things that
 * must happen as ONE unit: check the session is active, compare the stored
 * hash against `expectedCurrentHash`, write the new hash, and record the old
 * hash as consumed. In SQL that means a single conditional UPDATE guarded on
 * the old hash (plus the consumed-token insert in the same transaction), not
 * SELECT-then-UPDATE. Otherwise two refreshes arriving together both read
 * the same current hash and both write, leaving two live refresh tokens for
 * one session and making reuse detection meaningless.
 *
 * The loser of a concurrent rotation gets `OptimisticLockError`, and the
 * service treats that exactly like `consumed`: revoke the family. Both mean
 * "the hash I was given is no longer current".
 *
 * REVOCATION MUST BE IDEMPOTENT. Revoking an already-revoked session is not
 * an error: logout can be retried and two tabs can log out at once. The
 * first reason recorded wins; a later revoke must not overwrite
 * `token_reuse_detected` with `logout`, because the earlier reason is the
 * security-relevant one.
 *
 * `updateLastActiveAt` is deliberately fire-and-forget (`Promise<void>`, no
 * returned row). It runs on potentially every authenticated request, so it
 * must be the cheapest possible write, and losing a race on it is harmless -
 * the field is informational.
 * ===========================================================================
 */
export interface SessionRepository {
  /**
   * Opens a session.
   *
   * The adapter assigns `sessionId`, `createdAt` and `lastActiveAt`, and
   * sets `familyId` to the new `sessionId` when the input omits it.
   */
  create(input: CreateSessionInput): Promise<Session>;

  /**
   * Looks up by session id - the `sid` claim from an access token.
   *
   * Returns revoked and expired rows too; see the read-state convention.
   * `null` means no such session.
   */
  findBySessionId(sessionId: EntityId): Promise<Session | null>;

  /**
   * Looks up a session by its CURRENT refresh-token hash.
   *
   * Returns revoked and expired sessions (their current hash still matches),
   * but never a rotated-away hash - that is `resolveRefreshToken`'s job.
   * The caller hashes the presented token and passes the hash; the raw token
   * must never reach the repository.
   */
  findByRefreshTokenHash(refreshTokenHash: string): Promise<Session | null>;

  /**
   * Classifies a presented refresh-token hash as active, consumed or
   * unknown.
   *
   * This is the lookup a refresh endpoint should use, because it is the only
   * one that can tell a replayed token from an unrecognised one. See
   * "reuse detection" above for the required handling of `consumed`.
   */
  resolveRefreshToken(refreshTokenHash: string): Promise<RefreshTokenLookup>;

  /**
   * Atomically rotates the refresh token.
   *
   * Rejects, in this order:
   *   - unknown session            -> RecordNotFoundError
   *   - revoked or expired session -> SessionNotActiveError
   *   - stale expectedCurrentHash  -> OptimisticLockError
   *
   * ROTATION NEVER REACTIVATES A SESSION. A revoked session stays revoked
   * and an expired session stays expired: the active check happens before
   * any write, so neither `revokedAt` nor `expiresAt` can be cleared or
   * extended by rotating. Without that check, passing a future `expiresAt`
   * would silently resurrect a dead session.
   *
   * On success the previous hash is recorded as a `ConsumedRefreshToken`, so
   * replaying it is detectable, and it can never be used again.
   *
   * @throws RecordNotFoundError   when the session does not exist.
   * @throws SessionNotActiveError when it is revoked or expired.
   * @throws OptimisticLockError   when the stored hash no longer matches -
   *         treat as probable token reuse and revoke the family.
   */
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<Session>;

  /**
   * Records activity. Cheap, fire-and-forget, no row returned.
   *
   * Silently does nothing for an unknown, revoked or expired session: this
   * is a best-effort timestamp, not an authorization decision, and it must
   * never fail a request.
   */
  updateLastActiveAt(sessionId: EntityId, lastActiveAt: IsoDateTime): Promise<void>;

  /**
   * Revokes one session, scoped by owner.
   *
   * Scoping by `userId` as well as `sessionId` is what enforces cross-user
   * isolation at the port: a session id belonging to someone else simply
   * does not match.
   *
   * Idempotent - revoking an already-revoked session succeeds and keeps the
   * original reason.
   *
   * @throws RecordNotFoundError when no session matches BOTH ids.
   */
  revokeSession(input: RevokeSessionInput): Promise<Session>;

  /**
   * Revokes every session for a user, optionally sparing one.
   *
   * Backs "terminate all other sessions" (spare the caller's), and the
   * security responses that must drop every session: password change,
   * suspension, role change.
   *
   * @returns how many sessions this call newly revoked.
   */
  revokeAllForUser(input: RevokeAllForUserInput): Promise<number>;

  /**
   * Revokes an entire rotation family.
   *
   * The required response to detected refresh-token reuse: everything
   * descended from the same original login goes, not just the row that was
   * presented.
   *
   * @returns how many sessions this call newly revoked.
   */
  revokeSessionFamily(input: RevokeSessionFamilyInput): Promise<number>;

  /**
   * Lists a user's sessions, most recently active first.
   *
   * Defaults to active sessions only, which is what the frontend's session
   * list shows. The caller maps these onto `SessionItem`, including the
   * `isCurrent` flag - which the repository cannot know, because "current"
   * is a property of the request, not of the row.
   */
  listSessionsForUser(userId: EntityId, options?: ListSessionsOptions): Promise<Session[]>;

  /**
   * Deletes consumed-token records whose `purgeAfter` has passed.
   *
   * Required maintenance, not an optimisation - see "retention" above.
   * Safe to run at any time: a purged record degrades a token from
   * "consumed" to "unknown", which still denies access.
   *
   * @returns how many records were removed.
   */
  purgeConsumedRefreshTokens(before: IsoDateTime): Promise<number>;
}
