import type { EntityId } from "../../contracts/identifier.contract";
import type {
  ChangePasswordInput,
  ConditionalResetInput,
  ConditionalResetResult,
  CreateCredentialInput,
  CredentialLockoutState,
  CredentialRecord,
  RecordFailedAttemptInput,
  RehashPasswordInput,
  ResetPasswordInput,
} from "./credential.types";

/**
 * The `credentials` repository PORT.
 *
 * Interface only - no SQL, no driver, no MS SQL Server concept, following
 * the Step 5 pattern. The database team implements it; the in-memory fake in
 * `tests/fakes/` satisfies it for tests.
 *
 * ===========================================================================
 * EXPOSURE RULE - a `CredentialRecord` never leaves the auth layer.
 *
 * It is not an API DTO. It must not be returned from a controller, placed in
 * a response body, put in an error, or logged. Callers that need lockout
 * information use `toCredentialSecurityView()`, which cannot carry a hash
 * because the hash is not in its type.
 *
 * `redact()` already strips keys matching /pass(word)?/ and /credential/, so
 * a record that reaches a log line has its hash replaced - but that is the
 * last line of defence, not permission to log one.
 * ===========================================================================
 *
 * ===========================================================================
 * LOOKUP IS BY USER ID ONLY - deliberately.
 *
 * There is no `findByEmail`. Resolving an identifier to a user is
 * `UserRepository`'s job; this port then answers "what is this user's
 * password hash". Two reasons:
 *
 *  1. The credential store stays ignorant of identity, so it holds no email
 *     and cannot become a second place to enumerate accounts.
 *  2. Login already needs the user record (for role and status), so the
 *     user lookup is not an extra cost.
 *
 * The login service therefore does: resolve identifier -> user, then
 * `findByUserId`. When no user matches, it must still spend the cost of a
 * verification - `verifyAgainstDummyHash()` in password.service.ts - or the
 * timing difference reveals which accounts exist.
 * ===========================================================================
 *
 * ===========================================================================
 * THREE SEPARATE WRITE PATHS FOR A PASSWORD - do not merge them.
 *
 * They differ in BOTH authorization and side effects, and collapsing them
 * into one method is what produced the unsafe unconditional rehash the
 * backend lead caught:
 *
 *            | authorization              | CAS | stamps        | clears
 *            |                            |     | passwordUpdatedAt | lockout
 *  change    | knows the current password  | YES | YES           | YES
 *  rehash    | just verified the password  | YES | NO            | NO
 *  reset     | single-use OTP reset grant   | NO  | YES           | YES
 *
 * `rehash` not stamping `passwordUpdatedAt` matters: it stores the SAME
 * password under stronger parameters, so stamping it would make every user
 * look as though they had just changed their password and would corrupt any
 * password-age or expiry policy (O7).
 *
 * `reset` having no compare-and-set is correct, not a weakness - the user
 * cannot know their current hash, which is the premise of a reset. Its
 * authorization lives in the SERVICE, which must hold a valid single-use
 * reset grant before calling it (§4.5 / O8). The repository cannot verify
 * that, which is exactly why this is its own method: the requirement is
 * visible at every call site.
 * ===========================================================================
 *
 * ===========================================================================
 * ATOMIC OPERATIONS vs ORDINARY READS AND WRITES.
 *
 * ORDINARY (a single row read or a plain update; no coordination needed):
 *   - findByUserId
 *   - create
 *   - resetPassword
 *   - clearLockout
 *
 * ATOMIC (must be ONE statement; a read-modify-write is a defect):
 *   - recordFailedAttempt - increment and conditionally lock. Doing this as
 *     SELECT-then-UPDATE loses attempts under concurrency: ten parallel
 *     guesses all read 0, all write 1, and the lockout never triggers. That
 *     turns a 5-attempt limit into an unlimited one, which is the whole
 *     point of the control.
 *   - resetFailedAttemptsIfAuthorized - a guarded reset. Zeroing the counter
 *     unconditionally was a defect: a successful login could erase a lockout
 *     that a concurrent fifth failure had just created, and because the
 *     evidence was destroyed no later re-read could detect it. The guard and
 *     the write must be ONE statement.
 *   - changePassword and rehashPassword - compare-and-set, guarded in the
 *     same statement (`WHERE user_id = @id AND password_hash = @expected`),
 *     so a write cannot land on a credential a concurrent request already
 *     replaced. Zero rows affected must be distinguished into "no such
 *     credential" and "hash mismatch" so the right error is thrown.
 *
 * Exact SQL shapes are in docs/database-handoff.md §15.3 (Q-CR3, Q-CR4).
 * ===========================================================================
 *
 * ===========================================================================
 * NO CROSS-REPOSITORY TRANSACTIONS - there is no unit of work yet.
 *
 * Several flows span this port and others, and today NOTHING makes them
 * atomic:
 *
 *   registration       -> users.create + credentials.create
 *   password change    -> credentials.changePassword
 *                         + sessions.revokeAllForUser("password_changed")
 *   password reset     -> credentials.resetPassword
 *                         + sessions.revokeAllForUser("password_changed")
 *   suspension / role  -> users.setStatus + sessions.revokeAllForUser
 *
 * A service must call these in sequence and handle partial failure itself.
 * The ordering that fails safest:
 *
 *   - Registration: create the user, then the credential. A user without a
 *     credential cannot log in (fails closed); a credential without a user
 *     is an orphan the login path can never reach.
 *   - Password change or reset: update the hash FIRST, then revoke sessions.
 *     If the revoke fails, the old password is already dead and the stale
 *     sessions expire on their own; the reverse order would leave the old
 *     password working with no sessions, which is worse.
 *
 * This is `Q-CR6`/`Q-X1` in docs/database-handoff.md and the single biggest
 * gap in the port design. Do not pretend a multi-repository call is atomic.
 * ===========================================================================
 */
export interface CredentialRepository {
  /**
   * Reads a user's credential. ORDINARY read.
   *
   * `null` means no credential exists for that user - which is NOT the same
   * as a wrong password, and the login service must not conflate them: it
   * still has to spend a dummy verification so the response time does not
   * reveal that the account has no credential.
   *
   * The returned record CONTAINS THE HASH. Treat it as secret: it may be
   * passed to `verifyPassword()` and nowhere else.
   */
  findByUserId(userId: EntityId): Promise<CredentialRecord | null>;

  /**
   * Creates a credential. ORDINARY write.
   *
   * Takes a hash, never a password. One credential per user.
   *
   * @throws DuplicateRecordError when the user already has one.
   */
  create(input: CreateCredentialInput): Promise<CredentialRecord>;

  /**
   * A user changes their own password. ATOMIC compare-and-set.
   *
   * As one unit: replaces the hash, stamps `passwordUpdatedAt`, resets
   * `failedLoginAttempts`, clears `lockedUntil`.
   *
   * Does NOT revoke sessions - different repository, no unit of work. The
   * caller must follow with
   * `sessions.revokeAllForUser({ reason: "password_changed" })`.
   *
   * @throws RecordNotFoundError when the user has no credential.
   * @throws OptimisticLockError when `expectedCurrentHash` no longer matches,
   *         meaning a concurrent request already changed the password. The
   *         caller must NOT retry blindly - the user's input was verified
   *         against a password that is no longer current.
   */
  changePassword(input: ChangePasswordInput): Promise<CredentialRecord>;

  /**
   * Upgrades the stored hash of the SAME password. ATOMIC compare-and-set.
   *
   * Called right after a successful verification when `needsRehash()` says
   * the stored parameters are below current policy.
   *
   * Replaces ONLY the hash. Does not stamp `passwordUpdatedAt` and does not
   * touch lockout state - this is a storage upgrade, not a password change.
   *
   * @throws RecordNotFoundError when the user has no credential.
   * @throws OptimisticLockError when `expectedCurrentHash` no longer matches.
   *         The correct response is to ABANDON the rehash, not retry: the
   *         password has been changed by someone else, and writing anyway
   *         would reinstate the old password over the new one.
   */
  rehashPassword(input: RehashPasswordInput): Promise<CredentialRecord>;

  /**
   * Sets a password without knowing the old one. ORDINARY write.
   *
   * The forgot-password flow. As one unit: replaces the hash, stamps
   * `passwordUpdatedAt`, resets `failedLoginAttempts`, clears `lockedUntil`.
   * The counter reset is not a convenience - a successful password reset is
   * the confirmed self-service unlock path, and the frontend's lockout
   * message tells the user to use it.
   *
   * AUTHORIZATION IS THE CALLER'S RESPONSIBILITY. There is no
   * compare-and-set here, so this method will overwrite whatever is stored.
   * The service MUST hold a valid single-use reset grant (issued after OTP
   * verification) before calling it, and must consume that grant in the same
   * flow. Calling this without one is a full account takeover.
   *
   * Does NOT revoke sessions; the caller must follow with
   * `sessions.revokeAllForUser({ reason: "password_changed" })`.
   *
   * @throws RecordNotFoundError when the user has no credential.
   */
  resetPassword(input: ResetPasswordInput): Promise<CredentialRecord>;

  /**
   * Increments the failure counter and locks at the threshold. ATOMIC.
   *
   * Must be one statement - see the atomicity note above; a read-modify-write
   * here silently defeats the lockout under concurrent guessing.
   *
   * Returns the resulting state so the caller can report "N attempts
   * remaining" (confirmed UX) without a second read.
   *
   * Lockout is counter-based and permanent until explicitly cleared; nothing
   * here sets `lockedUntil`. See the policy note on `isCredentialLocked`
   * and open question O4.
   *
   * @throws RecordNotFoundError when the user has no credential.
   */
  recordFailedAttempt(input: RecordFailedAttemptInput): Promise<CredentialLockoutState>;

  /**
   * Resets the failure counter after a successful verification, but ONLY if
   * the credential is still authorised for it. ATOMIC.
   *
   * ===========================================================================
   * THE RACE THIS CLOSES.
   *
   * The previous `resetFailedAttempts` was an ordinary, unconditional write.
   * With the counter at four, this could happen:
   *
   *   1. a correct-password login starts verifying (~120ms of argon2);
   *   2. a concurrent fifth failure lands -> counter 5 -> LOCKED;
   *   3. the successful login resets the counter to 0 -> LOCK ERASED;
   *   4. every later re-read sees a clean counter and finds nothing wrong.
   *
   * Re-reading could not help, because the write destroyed the evidence. The
   * guard therefore has to live in the same statement as the write.
   * ===========================================================================
   *
   * The guard, all evaluated together:
   *   - a credential exists for the user;
   *   - it is NOT locked (counter below `threshold`, and no future
   *     `lockedUntil`);
   *   - the stored hash is one of `acceptableHashes`.
   *
   * On success the counter becomes 0. On any failed condition NOTHING is
   * written - in particular a lockout is left intact, because a correct
   * password must never unlock an account (policy Q4a).
   *
   * REQUIRED SQL SEMANTICS. One guarded UPDATE, never SELECT-then-UPDATE:
   *
   *   UPDATE credentials
   *      SET failed_login_attempts = 0
   *    OUTPUT inserted.*
   *    WHERE user_id = @userId
   *      AND failed_login_attempts < @threshold
   *      AND (locked_until IS NULL OR locked_until <= SYSUTCDATETIME())
   *      AND password_hash IN (@hash1, @hash2);
   *
   * A row in `OUTPUT` means `reset`. Zero rows affected means the guard
   * failed, and only THEN may the adapter issue a single SELECT to classify
   * the refusal as `locked`, `password_changed` or `not_found`. That read
   * reports; it does not decide, so this is not read-then-write - the
   * decision was already made atomically by the WHERE clause, and the login
   * is refused either way.
   *
   * Returns a result rather than throwing: every branch is an expected state
   * the caller must handle, and a refused reset must never be mistaken for a
   * reason to continue.
   */
  resetFailedAttemptsIfAuthorized(input: ConditionalResetInput): Promise<ConditionalResetResult>;

  /**
   * Clears a lockout: zeroes the counter AND removes `lockedUntil`.
   * ORDINARY write.
   *
   * Backs the confirmed admin endpoint `POST /students/:id/unlock`. An
   * audited administrative action, which is why it is explicit rather than a
   * flag on another method.
   *
   * Idempotent - unlocking an unlocked credential succeeds.
   *
   * @throws RecordNotFoundError when the user has no credential.
   */
  clearLockout(userId: EntityId): Promise<CredentialRecord>;
}
