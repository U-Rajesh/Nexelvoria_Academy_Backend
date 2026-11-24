import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";

/**
 * The credential domain: everything needed to verify a password, and
 * nothing else.
 *
 * WHY THIS IS SEPARATE FROM `User`. `UserRepository` deliberately exposes no
 * password field, so an ordinary user query cannot select a hash into a
 * response or a log line. Keeping credentials in their own record and behind
 * their own port preserves that: the only code that can reach a password
 * hash is code that asked for a credential explicitly.
 *
 * WHAT THIS DELIBERATELY DOES NOT HOLD:
 *  - No identity fields. No email, name, role or status - those live on
 *    `User` and duplicating them would create two sources of truth.
 *  - No plaintext password, ever, in any field or any form.
 *  - No sessions or refresh tokens; those are `session.types.ts`.
 *  - No two-factor secrets. 2FA is only half-specified in the frontend (the
 *    settings screen exists, but no login challenge does - see
 *    docs/auth-implementation-plan.md §2.7 / O5), so modelling it now would
 *    be guessing. It gets its own record when that is resolved.
 *  - No OTP challenges; those are a separate, short-lived concern.
 *
 * EXPOSURE RULE: a `CredentialRecord` must never leave the authentication
 * layer. It is not an API DTO, it is never returned from a controller, and
 * it is never logged. Where a caller needs lockout information - the
 * confirmed admin endpoint `GET /students/:studentId/security`, for example -
 * use `toCredentialSecurityView()` at the bottom of this file, which cannot
 * carry a hash because the hash is not in its type.
 *
 * NOTHING HERE IS A DATABASE SCHEMA. These are the fields the application
 * needs. How MS SQL Server stores them is the database team's decision and
 * the questions are in docs/database-handoff.md §15.
 */

/**
 * One user's password credential.
 *
 * Keyed by `userId` rather than carrying its own id: a user has exactly one
 * password credential, so a separate surrogate key would add a join without
 * adding meaning. Whether the database agrees is Q-CR1.
 *
 * Three of these fields are CONFIRMED by the frontend's `StudentProfile`,
 * which was carved out of the Step 5 student model precisely because it
 * belongs here: `failedLoginAttempts`, `lockedUntil` and `lastPasswordChange`
 * (named `passwordUpdatedAt` below).
 */
export interface CredentialRecord {
  /** The owning user. Also the natural key. */
  userId: EntityId;

  /**
   * Argon2id PHC string, e.g.
   * `$argon2id$v=19$m=47104,t=2,p=1$<salt>$<digest>`.
   *
   * The PHC format already carries the algorithm, its parameters and the
   * per-password salt, which is what lets a rehash upgrade an old hash
   * without a schema change. That is why no separate algorithm or salt
   * field exists here.
   *
   * NEVER returned by an API, never logged, never included in an error.
   */
  passwordHash: string;

  /**
   * When the password was last CHANGED by a user.
   *
   * Confirmed: the frontend's `StudentProfile.lastPasswordChange`, and what
   * a future password-expiry policy would read
   * (`SystemConfig.security.passwordExpiryDays`, open question O7).
   *
   * A REHASH MUST NOT TOUCH THIS. Re-hashing stores the same password under
   * stronger parameters; it is a storage upgrade, not a password change.
   * Stamping it would make every user look as though they had just changed
   * their password, corrupting password-age reporting and any expiry policy
   * built on it.
   */
  passwordUpdatedAt: IsoDateTime;

  /**
   * Consecutive failed login attempts. Reset to 0 on success.
   *
   * Confirmed field, and confirmed semantics: the frontend shows the user
   * "N attempts remaining", so this count drives UX as well as the lockout.
   *
   * THIS FIELD ALONE GOVERNS LOCKOUT - see `isCredentialLocked`.
   */
  failedLoginAttempts: number;

  /**
   * The stored lock flag (NXA_Users.IsLocked). It is set atomically with the
   * failure that reaches the threshold in force AT THAT MOMENT, and cleared
   * only by a password reset or an Admin unlock (D7). When it is known it is
   * the lock state, so changing the threshold never locks or unlocks anyone
   * retroactively. Absent (a store that does not carry it): the counter rule.
   */
  isLocked?: boolean;

  /**
   * RESERVED. Nothing sets this today.
   *
   * The field is confirmed by the frontend (`StudentProfile.lockedUntil`)
   * and is kept so the database schema can carry it, but **timed lockout is
   * not implemented** and no code populates it. See the lockout note on
   * `isCredentialLocked` and open question O4.
   *
   * If a future policy does set it, a value in the future locks the
   * credential - but an ELAPSED value never unlocks one, because the
   * counter governs.
   */
  lockedUntil?: IsoDateTime;

  /**
   * When the most recent failure happened.
   *
   * NOT a frontend field - proposed. It is what a future "consecutive
   * failures within a window" policy would need, and it is useful in an
   * incident to see whether five failures took five seconds or five weeks.
   */
  lastFailedLoginAt?: IsoDateTime;

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * Creating a credential. Takes a HASH, never a password.
 *
 * The caller hashes with `password.service.ts` first, which enforces the
 * policy, so a non-compliant password can never reach storage.
 */
export interface CreateCredentialInput {
  userId: EntityId;
  /** An argon2id PHC string from `hashPassword()`. */
  passwordHash: string;
}

/**
 * A deliberate password change by a user who proved knowledge of the current
 * one.
 *
 * Compare-and-set is MANDATORY: the caller verified a specific stored hash
 * moments ago, and the write must apply to that credential and no other.
 */
export interface ChangePasswordInput {
  userId: EntityId;
  /** The hash that was just verified. Required. */
  expectedCurrentHash: string;
  /** The new argon2id PHC string. */
  newPasswordHash: string;
}

/**
 * Re-hashing the SAME password under current parameters.
 *
 * Happens immediately after a successful verification, when
 * `needsRehash()` reports the stored hash used weaker parameters.
 *
 * Compare-and-set is MANDATORY, and this is the correction the backend lead
 * identified: a rehash is NOT an unconditional write. The caller has just
 * verified the password, so it knows exactly which hash it is replacing -
 * and if a concurrent request has since changed the password, the rehash
 * must LOSE. Writing unconditionally would silently reinstate the old
 * password over the new one, which is a credential-rollback bug and far
 * worse than skipping an upgrade.
 *
 * Distinct from `ChangePasswordInput` because the side effects differ: a
 * rehash must not stamp `passwordUpdatedAt` and must not alter lockout
 * state. Only the stored hash changes.
 */
export interface RehashPasswordInput {
  userId: EntityId;
  /** The hash that was just verified and is being upgraded. Required. */
  expectedCurrentHash: string;
  /** The same password, hashed with current parameters. */
  newPasswordHash: string;
}

/**
 * Setting a password without knowing the old one - the forgot-password flow.
 *
 * There is NO compare-and-set here, and that is correct rather than a
 * weakness: the user cannot know their current hash, which is the whole
 * premise of a reset. Authorization comes from elsewhere entirely - a
 * single-use, short-lived reset grant issued after OTP verification
 * (docs/auth-implementation-plan.md §4.5, open item O8). The repository
 * cannot check that grant, so the SERVICE must, and must refuse to call
 * this method without one.
 *
 * Kept as its own method precisely so that authorization requirement is
 * visible at every call site, rather than hidden in an optional field.
 */
export interface ResetPasswordInput {
  userId: EntityId;
  /** The new argon2id PHC string. */
  newPasswordHash: string;
}

/** Recording a failed login attempt. See the port for the atomicity rules. */
export interface RecordFailedAttemptInput {
  userId: EntityId;

  /**
   * Attempts allowed before locking.
   *
   * Passed in rather than read here, because the threshold is POLICY and
   * policy belongs to the service: it is 5 in the confirmed frontend and
   * configurable through `SystemConfig.security.maxFailedLogins`. The
   * repository only needs it to make the increment-and-maybe-lock atomic.
   */
  threshold: number;
}

/**
 * Input for the conditional reset of the failure counter.
 *
 * Replaces an unconditional reset, which was a security defect: a
 * successful login could zero a counter that a concurrent fifth failure had
 * just driven to the lockout threshold, erasing the lock before anything
 * could observe it.
 */
export interface ConditionalResetInput {
  userId: EntityId;

  /**
   * Attempts allowed before lockout. Policy, so it is passed in - the
   * repository needs it only to evaluate the guard atomically.
   */
  threshold: number;

  /**
   * Stored hashes that still represent the password the caller verified.
   *
   * Normally one value - the hash read before verification. When the login
   * also upgraded the hash it is TWO: the original and the upgrade. Both are
   * accepted because both mean "the password I verified is still current",
   * which is what makes an uncertain rehash outcome safe. Anything else
   * means somebody changed the password, and the reset must not apply.
   */
  acceptableHashes: readonly string[];
}

/**
 * Outcome of a conditional reset.
 *
 * A discriminated union rather than a thrown error, because every branch is
 * an expected state the caller must handle differently - and because the
 * caller must NOT treat a refused reset as a reason to proceed.
 */
export type ConditionalResetResult =
  /** The guard held: the counter is now 0. */
  | { status: "reset"; credential: CredentialRecord }
  /**
   * The credential is locked. The counter was NOT touched, so the lock
   * survives. The login must be refused - a correct password does not
   * unlock an account.
   */
  | { status: "locked"; credential: CredentialRecord }
  /**
   * The stored hash is none of the acceptable ones, so the verification is
   * stale. The login must be refused.
   */
  | { status: "password_changed" }
  /** No credential for that user. */
  | { status: "not_found" };

/**
 * Lockout state after a mutation.
 *
 * Returned so a service never has to read the record back to answer "how
 * many attempts remain" - which is confirmed UX, and would otherwise be a
 * second round trip on the login hot path.
 */
export interface CredentialLockoutState {
  failedLoginAttempts: number;
  lockedUntil?: IsoDateTime;
  isLocked: boolean;
  /** Never negative. 0 once locked. */
  remainingAttempts: number;
}

/**
 * Attempts left before lockout.
 *
 * Exported so the service and the repository cannot disagree about it.
 */
export const remainingAttempts = (failedLoginAttempts: number, threshold: number): number =>
  Math.max(0, threshold - failedLoginAttempts);

/**
 * Whether a credential is locked right now.
 *
 * ===========================================================================
 * LOCKOUT POLICY AS IMPLEMENTED - deliberately simple, and temporary.
 *
 * A credential is locked when `failedLoginAttempts >= threshold`, and it
 * STAYS locked until something explicitly clears the counter:
 *
 *   - a successful password reset  (`resetPassword`)
 *   - an administrator unlock      (`clearLockout`)
 *
 * There is NO automatic time-based unlock, and nothing sets `lockedUntil`.
 * This matches the confirmed frontend, whose lockout message tells the user
 * to "unlock via Forgot Password" and which never populates `lockedUntil`.
 *
 * WHY TIMED LOCKOUT WAS REMOVED. The first version of this port accepted a
 * `lockDurationMinutes` and set `lockedUntil`, while this function also
 * treated a counter at the threshold as locked. Those two rules contradict
 * each other: once `lockedUntil` elapsed the counter was still at the
 * threshold, so the "timed" lockout never actually expired. Rather than
 * silently introduce an automatic unlock - which would weaken the confirmed
 * behaviour - the timed half was removed. One rule, no contradiction.
 *
 * `lockedUntil` remains in the record because it is a confirmed frontend
 * field the database schema should carry, and this function still honours a
 * FUTURE value so a later policy can switch it on. An ELAPSED value never
 * unlocks a credential on its own.
 *
 * FINAL POLICY IS OPEN - question O4, for the backend lead. Choosing timed
 * lockout means deciding what happens to the counter when the timer
 * expires; that decision belongs with the business, not in this file.
 * ===========================================================================
 *
 * `threshold` is a parameter because it is policy, not data.
 */
export const isCredentialLocked = (
  credential: Pick<CredentialRecord, "failedLoginAttempts" | "lockedUntil" | "isLocked">,
  threshold: number,
  now: Date = new Date(),
): boolean => {
  // D7: the stored flag, when known, is the lock state (non-retroactive
  // threshold changes). Otherwise the counter rule.
  if (credential.isLocked !== undefined) {
    if (credential.isLocked) return true;
  } else if (credential.failedLoginAttempts >= threshold) {
    return true;
  }

  // Reserved path: honoured if some future policy sets it, but an elapsed
  // value does NOT unlock - it simply stops contributing.
  return (
    credential.lockedUntil !== undefined &&
    Date.parse(credential.lockedUntil) > now.getTime()
  );
};

/** Builds the state summary for a record. */
export const toLockoutState = (
  credential: Pick<CredentialRecord, "failedLoginAttempts" | "lockedUntil" | "isLocked">,
  threshold: number,
  now: Date = new Date(),
): CredentialLockoutState => ({
  failedLoginAttempts: credential.failedLoginAttempts,
  ...(credential.lockedUntil === undefined ? {} : { lockedUntil: credential.lockedUntil }),
  isLocked: isCredentialLocked(credential, threshold, now),
  remainingAttempts: remainingAttempts(credential.failedLoginAttempts, threshold),
});

/**
 * The ONLY credential shape that may leave the authentication layer.
 *
 * Structurally incapable of carrying a password hash, because
 * `passwordHash` is not in the type - so a controller cannot leak one by
 * forgetting to strip a field. Use this for the confirmed admin security
 * view (`GET /students/:studentId/security`) and anywhere else lockout
 * information is displayed.
 */
export interface CredentialSecurityView {
  userId: EntityId;
  passwordUpdatedAt: IsoDateTime;
  failedLoginAttempts: number;
  isLocked: boolean;
  lockedUntil?: IsoDateTime;
  lastFailedLoginAt?: IsoDateTime;
}

/** Projects a credential into the safe, hash-free view. */
export const toCredentialSecurityView = (
  credential: CredentialRecord,
  threshold: number,
  now: Date = new Date(),
): CredentialSecurityView => ({
  userId: credential.userId,
  passwordUpdatedAt: credential.passwordUpdatedAt,
  failedLoginAttempts: credential.failedLoginAttempts,
  isLocked: isCredentialLocked(credential, threshold, now),
  ...(credential.lockedUntil === undefined ? {} : { lockedUntil: credential.lockedUntil }),
  ...(credential.lastFailedLoginAt === undefined
    ? {}
    : { lastFailedLoginAt: credential.lastFailedLoginAt }),
});

/** D7: the Super Admin may set 3-10; anything else (never saved, invalid) is the current 5. */
export const LOCKOUT_THRESHOLD_MIN = 3;
export const LOCKOUT_THRESHOLD_MAX = 10;
export const effectiveLockoutThreshold = (saved: number | undefined | null, fallback: number): number =>
  typeof saved === "number" && Number.isInteger(saved) && saved >= LOCKOUT_THRESHOLD_MIN && saved <= LOCKOUT_THRESHOLD_MAX ? saved : fallback;
