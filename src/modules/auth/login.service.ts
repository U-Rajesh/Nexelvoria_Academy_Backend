import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type { StudentRepository } from "../students/student.repository";
import type { UserRepository } from "../users/user.repository";
import type { User } from "../users/user.types";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import { MOBILE_PATTERN, loginSchema } from "./auth.validation";
import { issueVerificationTicket } from "./token.service";
import { decideStudentAccess } from "../students/student-access";

/** Consecutive failed sign-ins before the credential is locked (the value the app is wired with). */
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
import type { CredentialRepository } from "./credential.repository";
import type { ConditionalResetResult, CredentialRecord } from "./credential.types";
import { isCredentialLocked } from "./credential.types";
import {
  hashPassword,
  verifyAgainstDummyHash,
  verifyPassword,
} from "./password.service";
import type { SessionRepository } from "./session.repository";
import { generateRefreshToken, issueAccessToken } from "./token.service";

/**
 * The login application service.
 *
 * Orchestrates the primitives built in Steps 6B-6G: password verification
 * (argon2id), credential and lockout state, session creation, and access
 * token issuance. It contains the business rules; it knows nothing about
 * HTTP.
 *
 * NO HTTP HERE. It returns a typed result, never a status code and never an
 * `ApiError`. How login conveys account state to the client is still
 * decision **D1** in docs/auth-implementation-plan.md, and encoding a guess
 * here would have to be unpicked.
 *
 * ===========================================================================
 * TIME-OF-CHECK / TIME-OF-USE - the central problem, and what is actually
 * guaranteed.
 *
 * An argon2id verification takes ~120ms. A great deal can happen in that
 * window and in the writes that follow: the password can be changed, the
 * credential locked by concurrent failures, the account suspended or
 * deactivated, the role changed. The snapshot read before verification is
 * therefore NOT authoritative by the time a token is minted.
 *
 * WHAT THIS SERVICE DOES:
 *
 *  1. Re-reads the user and credential AFTER verification and after every
 *     write, and re-checks the full authorization set each time
 *     (`revalidate` below).
 *  2. Runs that gate TWICE: once before creating a session (so a doomed
 *     session is never created) and once AFTER creating it (the
 *     authoritative check), minting the token only if the second gate
 *     passes.
 *  3. Revokes the session it just created if the second gate fails.
 *  4. Mints the token with the role from that final read, so the JWT
 *     carries the role that was authorized last.
 *
 * WHY A RE-READ ALONE IS NOT SUFFICIENT, AND WHY THIS IS STILL SOUND.
 *
 * A re-read narrows the window from ~120ms to microseconds but cannot close
 * it: a change committing between the final read and the token being
 * returned is still possible. There is no unit of work across repositories
 * (Q-CR6 / Q-X1), and no single-repository operation could fix it, because
 * the condition spans `users`, `credentials` and `sessions`. **Adding a new
 * atomic method to one port would not help**, which is why none is proposed.
 *
 * The window closes from the other direction instead. Every state change
 * that matters is already required to revoke the user's sessions
 * (docs/auth-implementation-plan.md §16.3): suspension and role change
 * revoke with `account_suspended` / `role_changed`, and a password change or
 * reset revokes with `password_changed`. So:
 *
 *   - change commits BEFORE our post-create gate -> the gate sees it, and we
 *     revoke our own session;
 *   - change commits AFTER our session row exists -> its revocation sweep
 *     includes our session.
 *
 * Together those cover the whole window, PROVIDED the status/role write and
 * the revocation happen in one unit of work. They cannot today, so a narrow
 * interleaving remains: the status write commits after our final read while
 * the revocation sweep ran before our insert. **That residual gap closes
 * only with Q-X1 transactions.** It is bounded by the access-token lifetime
 * (15 minutes) and by Step 6F session validation, which re-checks the
 * session on every authenticated request.
 *
 * Cost: four extra single-row reads per login (two gates x user + credential).
 * Login is not a hot path, and they are trivial beside one argon2 hash.
 * ===========================================================================
 */

/**
 * Why a login was refused.
 *
 * INTERNAL vocabulary for the caller to map. These are NOT response bodies:
 * several of them must collapse into one generic message before reaching a
 * client - see `docs/auth-implementation-plan.md` §18.
 */
export type LoginFailureReason =
  /**
   * No such user, no credential, or the wrong password. ONE reason for all
   * three so the result cannot distinguish them.
   */
  | "invalid_credentials"
  /** Correct password, but the credential is locked out. */
  | "account_locked"
  /**
   * Correct password, but the account is not active and the precise reason
   * could NOT be established - no student repository was supplied, the
   * lookup failed, or the user has no student profile.
   *
   * Deliberately the fallback rather than a guess: see `resolvePending`.
   */
  | "account_pending"
  /** Correct password, `pending`, and the email is not yet verified. */
  | "account_pending_verification"
  /** Correct password, `pending`, email verified, awaiting BR-002 approval. */
  | "account_pending_approval"
  /** Correct password, but suspended by staff. */
  | "account_suspended"
  /** Correct password, but deactivated. */
  | "account_deactivated"
  /**
   * The stored hash is no longer the one we verified, so the verification is
   * stale. Covers a concurrent change AND an uncertain rehash outcome.
   */
  | "password_changed_concurrently"
  /**
   * The credential or user state could not be established, or a session or
   * token could not be produced. Fail-closed catch-all.
   */
  | "authentication_unavailable";

/** A successful login. */
export interface LoginSuccess {
  /**
   * The authoritative user record, as read by the FINAL authorization gate.
   * Contains no password material - `User` has no hash field, by design.
   */
  user: User;

  /** Short-lived JWT. */
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;

  /**
   * Opaque refresh token, returned to the caller EXACTLY ONCE.
   *
   * UNRESOLVED: how this reaches the browser is not decided (**D4**). The
   * frontend keeps its access token in `localStorage`, which is readable by
   * any XSS on the origin; a refresh token there is a long-lived credential
   * in the same exposed place. The alternative is an httpOnly, Secure,
   * SameSite cookie, which needs CSRF protection and frontend work.
   *
   * This service takes no position on transport. **No HTTP endpoint may
   * return it until D4 is decided.**
   */
  refreshToken: string;
  refreshTokenExpiresAt: IsoDateTime;

  /** The session this login opened. Also the token's `sid` claim. */
  sessionId: EntityId;
}

/**
 * The login outcome.
 *
 * A failure carries ONLY `outcome` and `reason`. It deliberately carries no
 * attempt count: see `docs/auth-implementation-plan.md` §18.2 - a field
 * present for a known user and absent for an unknown one is an
 * account-existence oracle the moment a controller serialises it. Lockout
 * progress is logged server-side instead.
 */
export type LoginResult =
  | { outcome: "success"; data: LoginSuccess }
  | {
      outcome: "failure";
      reason: LoginFailureReason;
      /**
       * Present ONLY for `account_pending_verification`.
       *
       * The caller has supplied the correct password, so handing back the
       * means to continue to email verification reveals nothing the reason
       * does not already imply. It is issued here rather than by the
       * controller because this service is already the one that mints tokens
       * on success, and because the controller is given no user id on a
       * failure - deliberately, so that a refusal can never become an
       * account-existence oracle.
       *
       * Opaque and purpose-scoped: it cannot authenticate anything.
       */
      verificationTicket?: string;
    };

/** Client metadata recorded on the session. Never used for authorization. */
export interface LoginClientContext {
  device?: string;
  browser?: string;
  os?: string;
  ipAddress?: string;
  location?: string;
}

export interface LoginServiceDeps {
  users: UserRepository;
  credentials: CredentialRepository;
  sessions: SessionRepository;
  /**
   * Student profiles, read ONLY to distinguish "awaiting email verification"
   * from "awaiting admin approval" when a `pending` account is refused.
   *
   * OPTIONAL, and omitting it is a supported configuration rather than a
   * degraded one: the refusal is then the generic `account_pending`, exactly
   * as before this parameter existed. That is why every pre-existing login
   * test still constructs this service without it.
   *
   * It is never consulted for an authorization decision - only to choose
   * which of two equally-refusing messages the client receives.
   */
  students?: StudentRepository;
  /**
   * Consecutive failures before lockout.
   *
   * 5 in the confirmed frontend, configurable through
   * `SystemConfig.security.maxFailedLogins`. Injected rather than read here
   * so the policy has one owner.
   */
  maxFailedLoginAttempts: number | (() => Promise<number>);
}

/** The ONLY status permitted to sign in. */
const REQUIRED_STATUS: UserStatus = "active";

/**
 * Reasons for the known non-active statuses. The frontend renders a
 * different screen per state, so the distinction is kept.
 */
const STATUS_REASONS: Partial<Record<UserStatus, LoginFailureReason>> = {
  pending: "account_pending",
  suspended: "account_suspended",
  deactivated: "account_deactivated",
};

/**
 * Maps a status to its refusal reason, or `null` when the status is allowed.
 *
 * FAILS CLOSED. The previous version consulted a map of blocked statuses and
 * allowed anything absent from it, so a status added to `UserStatus` later -
 * "archived", "locked" - would have been permitted by default. This requires
 * equality with "active" first, and only then picks a reason, falling back
 * to a generic refusal for a status nobody has mapped yet.
 */
const statusRefusal = (status: UserStatus): LoginFailureReason | null => {
  if (status === REQUIRED_STATUS) {
    return null;
  }

  return STATUS_REASONS[status] ?? "account_suspended";
};

/**
 * Narrows a `pending` refusal into the reason the student can act on.
 *
 * ===========================================================================
 * THE RULE: NEVER GUESS.
 *
 * Only `User.status` is available at the gate, and it says `pending` for two
 * completely different situations - "verify your email" and "wait for an
 * administrator". The student's next action differs, so the UI shows
 * different screens.
 *
 * When the distinction cannot be established, this returns the GENERIC
 * `account_pending` rather than picking one. Reporting
 * `account_pending_approval` on a failed lookup would tell a student to wait
 * for an admin when what they actually need is to enter a code - they would
 * wait for something that is never coming.
 *
 * Four paths reach the generic answer, and all four are deliberate:
 *   - no `students` repository was supplied (the pre-existing behaviour);
 *   - the lookup threw (logged at error - it is an infrastructure fault);
 *   - the user has no student profile (logged at warn - a partial
 *     registration, or a non-student account that is somehow pending);
 *   - anything else unforeseen.
 *
 * This never widens access: every branch still refuses the login.
 * ===========================================================================
 */
interface PendingOutcome {
  reason: LoginFailureReason;
  /** Issued only when the student still needs to verify their email. */
  verificationTicket?: string;
}

const resolvePending = async (
  userId: EntityId,
  students: StudentRepository | undefined,
): Promise<PendingOutcome> => {
  const generic: PendingOutcome = { reason: "account_pending" };

  if (students === undefined) {
    return generic;
  }

  let student;

  try {
    student = await students.findById(userId);
  } catch (err) {
    logger.error(
      "login: could not establish why an account is pending; refusing with the generic reason",
      { userId, errorType: describeError(err) },
    );

    return generic;
  }

  if (student === null) {
    logger.warn("login: a pending account has no student profile", { userId });

    return generic;
  }

  if (!student.isEmailVerified) {
    return {
      reason: "account_pending_verification",
      verificationTicket: issueVerificationTicket(userId).ticket,
    };
  }

  if (student.adminApprovalStatus === "pending") {
    return { reason: "account_pending_approval" };
  }

  /**
   * Verified, and a decision has already been made - yet the account is
   * still `pending`.
   *
   * Reported GENERICALLY, and this is not laziness. Saying
   * `account_pending_approval` here would be plainly wrong: an approved
   * student told to "wait for approval" would wait for something that has
   * already happened. What they are actually waiting on is ACTIVATION, which
   * is a separate authorized admin action (BR-002: approval gates payment,
   * not login) and has no code of its own.
   *
   * A rejected student lands here too. Spelling that out is an unresolved
   * product decision - whether a rejection should be disclosed at sign-in at
   * all - so nothing is invented.
   */
  logger.info("login refused: account approved or rejected but not yet active", {
    userId,
    approval: student.adminApprovalStatus,
  });

  return { reason: "account_pending" };
};

/**
 * Whether this account may sign in at all, and why not.
 *
 * STUDENTS (CL-001): decided by `decideStudentAccess`, the same rule the
 * per-request authorization uses. A student with a verified email may sign
 * in while Admin approval is pending (limited access) and after approval -
 * approval replaces the former separate activation step. Suspended,
 * deactivated, rejected and unverified students are refused.
 *
 * Everyone else: the account must be `active`, as before.
 */
const accountRefusal = async (
  user: User,
  students: StudentRepository | undefined,
): Promise<PendingOutcome | null> => {
  if (user.role === "student" && students !== undefined) {
    let student;
    try {
      student = await students.findById(user.id);
    } catch (err) {
      logger.error("login: student access could not be established; refusing", {
        userId: user.id,
        errorType: describeError(err),
      });
      return { reason: "account_pending" };
    }

    const decision = decideStudentAccess({
      status: user.status,
      student: student === null ? null : { adminApprovalStatus: student.adminApprovalStatus, isEmailVerified: student.isEmailVerified },
    });
    if (decision.allowed) return null;

    switch (decision.reason) {
      case "suspended":
        return { reason: "account_suspended" };
      case "deactivated":
        return { reason: "account_deactivated" };
      case "email_unverified":
        return { reason: "account_pending_verification", verificationTicket: issueVerificationTicket(user.id).ticket };
      default:
        // Rejected, or no usable student profile. Not disclosed further.
        logger.info("login refused: student account not permitted", { userId: user.id, reason: decision.reason });
        return { reason: "account_pending" };
    }
  }

  const base = statusRefusal(user.status);
  if (base === null) return null;
  return base === "account_pending" ? resolvePending(user.id, students) : { reason: base };
};

export interface LoginService {
  login(input: unknown, client?: LoginClientContext): Promise<LoginResult>;
}

/** Outcome of one authorization gate. */
type GateResult =
  | { ok: true; user: User }
  | { ok: false; reason: LoginFailureReason; verificationTicket?: string };

export const createLoginService = (deps: LoginServiceDeps): LoginService => {
  const fail = (reason: LoginFailureReason, verificationTicket?: string): LoginResult =>
    verificationTicket === undefined
      ? { outcome: "failure", reason }
      : { outcome: "failure", reason, verificationTicket };

  /**
   * Resolves an identifier to a user.
   *
   * A 10-digit Indian mobile goes to `findByMobile`; anything else is tried
   * as an email. The mobile pattern is shared with the registration schema,
   * so a user who registered with a number can log in with it.
   */
  const resolveUser = async (identifier: string): Promise<User | null> => {
    const trimmed = identifier.trim();

    if (MOBILE_PATTERN.test(trimmed)) {
      return deps.users.findByMobile(trimmed);
    }

    // Email comparison is case-insensitive; the adapter owns that, and we
    // normalise here too so behaviour never depends on collation.
    return deps.users.findByEmail(trimmed.toLowerCase());
  };

  /**
   * Re-reads the user and credential and re-checks EVERYTHING that may have
   * changed since the password was verified.
   *
   * `acceptableHashes` is the set of stored hashes that still represent the
   * password we verified: the hash we read before verifying, plus - when a
   * rehash was attempted - the upgraded hash we wrote. Accepting both is what
   * makes an uncertain rehash safe:
   *
   *   - the rehash succeeded (even if the call reported an error) -> the
   *     stored hash is our upgrade -> accepted;
   *   - the rehash did not land -> the stored hash is the original ->
   *     accepted;
   *   - someone else changed the password -> the stored hash is neither ->
   *     REFUSED.
   *
   * A read failure is fail-closed: if the state cannot be established, the
   * login is refused rather than granted on a stale snapshot.
   */
  /**
   * D7: the threshold in force for this sign-in, read once. A read failure
   * falls back to the current default rather than blocking sign-in.
   */
  const lockoutThreshold = async (): Promise<number> => {
    if (typeof deps.maxFailedLoginAttempts === "number") return deps.maxFailedLoginAttempts;
    try {
      return await deps.maxFailedLoginAttempts();
    } catch (err) {
      logger.error("lockout threshold could not be read; using the default", { errorType: describeError(err) });
      return MAX_FAILED_LOGIN_ATTEMPTS;
    }
  };

  const revalidate = async (
    userId: EntityId,
    acceptableHashes: ReadonlySet<string>,
    threshold: number,
  ): Promise<GateResult> => {
    let freshUser: User | null;
    let freshCredential: CredentialRecord | null;

    try {
      [freshUser, freshCredential] = await Promise.all([
        deps.users.findById(userId),
        deps.credentials.findByUserId(userId),
      ]);
    } catch (err) {
      logger.error("login refused: authorization state could not be re-read", {
        userId,
        // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
      });

      return { ok: false, reason: "authentication_unavailable" };
    }

    if (freshUser === null || freshCredential === null) {
      // Deleted or had its credential removed mid-login.
      logger.warn("login refused: user or credential disappeared during login", { userId });
      return { ok: false, reason: "invalid_credentials" };
    }

    if (!acceptableHashes.has(freshCredential.passwordHash)) {
      // The verification is stale. Issuing a session here would grant access
      // on the strength of a password that is no longer current.
      logger.warn("login refused: password changed during login", { userId });
      return { ok: false, reason: "password_changed_concurrently" };
    }

    if (isCredentialLocked(freshCredential, threshold)) {
      // Covers a concurrent fifth failed attempt, and a failed counter
      // reset that left an authoritative locked state in place.
      logger.warn("login refused: credential locked during login", {
        userId,
        failedLoginAttempts: freshCredential.failedLoginAttempts,
      });

      return { ok: false, reason: "account_locked" };
    }

    const pending = await accountRefusal(freshUser, deps.students);
    const statusFailure = pending === null ? null : pending.reason;

    if (statusFailure !== null) {
      logger.warn("login refused: account status changed during login", {
        userId,
        status: freshUser.status,
      });

      return pending?.verificationTicket === undefined
        ? { ok: false, reason: statusFailure }
        : { ok: false, reason: statusFailure, verificationTicket: pending.verificationTicket };
    }

    return { ok: true, user: freshUser };
  };

  return {
    async login(input: unknown, client: LoginClientContext = {}): Promise<LoginResult> {
      // --- 1. input -----------------------------------------------------
      const parsed = loginSchema.safeParse(input);

      if (!parsed.success) {
        // Malformed input is not an authentication attempt: no user is
        // known, so there is nothing to count and nothing to disclose.
        return fail("invalid_credentials");
      }

      const { identifier, password, rememberMe = false } = parsed.data;
      const threshold = await lockoutThreshold();

      // --- 2 + 3. user and credential -----------------------------------
      // Guarded, and it matters twice over. Every OTHER repository call in
      // this method already fails closed; these two did not, so a database
      // fault threw straight out of `login()`. That broke the contract
      // (`authentication_unavailable` is the documented fail-closed result)
      // and, worse, handed the raw driver exception to the error
      // middleware - the exact message that can carry a login name, a
      // password or a connection string. Caught here, only the error class
      // is ever logged.
      let user: User | null;
      let credential: CredentialRecord | null;

      try {
        user = await resolveUser(identifier);
        credential = user === null ? null : await deps.credentials.findByUserId(user.id);
      } catch (err) {
        logger.error("login failed: user or credential could not be read", {
          // No identifier is logged: it is unvalidated input and, for an
          // email, personal data. The error class is the whole payload.
          errorType: describeError(err),
        });

        return fail("authentication_unavailable");
      }

      // --- 4. password --------------------------------------------------
      if (user === null || credential === null) {
        // Spend the same work as a real verification. Without this, "no such
        // user" returns in under a millisecond while "wrong password" takes
        // ~120ms, and that difference is a reliable account-existence
        // oracle. A missing credential is treated identically: it is a data
        // fault, not something a caller should be able to detect.
        await verifyAgainstDummyHash(password);

        if (user !== null && credential === null) {
          logger.error("login failed: user has no credential record", { userId: user.id });
        }

        return fail("invalid_credentials");
      }

      const verification = await verifyPassword(credential.passwordHash, password);

      if (!verification.valid) {
        // Atomic increment; see credential.repository.ts on why this must be
        // one statement. The resulting count is logged, never returned.
        try {
          const lockout = await deps.credentials.recordFailedAttempt({
            userId: user.id,
            threshold: threshold,
          });

          logger.warn("login failed: incorrect password", {
            userId: user.id,
            failedLoginAttempts: lockout.failedLoginAttempts,
            isLocked: lockout.isLocked,
          });
        } catch (err) {
          // The attempt could not be counted. Still a failed login, but an
          // operator needs to know the lockout may be under-counting.
          logger.error("could not record a failed login attempt", {
            userId: user.id,
            // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
          });
        }

        return fail("invalid_credentials");
      }

      // --- 5. cheap snapshot checks --------------------------------------
      // Fast rejections on the data already in hand, so a locked or
      // suspended account does not pay for a rehash. The authoritative
      // checks are the gates below.
      if (isCredentialLocked(credential, threshold)) {
        // A correct password does NOT unlock an account. Current policy:
        // locked until a verified password reset or an administrator
        // unlock - no automatic timed unlock (open question Q4a).
        logger.warn("login refused: credential is locked", { userId: user.id });
        return fail("account_locked");
      }

      const snapshotPending = await accountRefusal(user, deps.students);
      const snapshotStatusFailure = snapshotPending === null ? null : snapshotPending.reason;

      if (snapshotStatusFailure !== null) {
        logger.warn("login refused: account status", {
          userId: user.id,
          status: user.status,
        });

        return fail(snapshotStatusFailure, snapshotPending?.verificationTicket);
      }

      // --- 6. rehash -----------------------------------------------------
      // Both the original and the upgraded hash represent the password we
      // verified, so either is acceptable at the gates. This is what makes
      // an UNCERTAIN rehash outcome safe: a timeout that actually committed
      // is indistinguishable from one that did not, and we accept both.
      const acceptableHashes = new Set<string>([credential.passwordHash]);

      if (verification.needsRehash) {
        const upgraded = await hashPassword(password);
        acceptableHashes.add(upgraded);

        try {
          await deps.credentials.rehashPassword({
            userId: user.id,
            // Compare-and-set against the hash we actually verified.
            expectedCurrentHash: credential.passwordHash,
            newPasswordHash: upgraded,
          });
        } catch (err) {
          // NOT decided here. Every rehash failure - a lost compare-and-set,
          // a timeout, a dropped connection - leaves the stored hash
          // uncertain, and a timeout may even have committed. The gate
          // below reads the authoritative value and decides, which is both
          // safer and more precise than guessing from the error type.
          logger.warn("password rehash did not complete; deferring to the authorization gate", {
            userId: user.id,
            reason: err instanceof Error ? err.name : "unknown",
          });
        }
      }

      // --- 7. reset the counter, CONDITIONALLY ----------------------------
      // This is the authoritative credential check, and it must be atomic.
      // An unconditional reset here was a security defect: with the counter
      // at four, a concurrent fifth failure could lock the credential and
      // this write would erase the lock - leaving nothing for the gates
      // below to detect, because the evidence was destroyed.
      //
      // The guard and the write happen in one statement, so a locked
      // credential refuses the reset and keeps its lock.
      let resetOutcome: ConditionalResetResult;

      try {
        resetOutcome = await deps.credentials.resetFailedAttemptsIfAuthorized({
          userId: user.id,
          threshold: threshold,
          acceptableHashes: [...acceptableHashes],
        });
      } catch (err) {
        // The credential state cannot be established, so it is not safe to
        // continue - fail closed rather than issue a session.
        logger.error("login refused: the failed-attempt counter could not be reset", {
          userId: user.id,
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        return fail("authentication_unavailable");
      }

      if (resetOutcome.status === "locked") {
        // A concurrent fifth failure locked the credential during
        // verification. The lock was NOT erased, and a correct password does
        // not unlock an account (policy Q4a).
        logger.warn("login refused: credential locked during verification", {
          userId: user.id,
          failedLoginAttempts: resetOutcome.credential.failedLoginAttempts,
        });

        return fail("account_locked");
      }

      if (resetOutcome.status === "password_changed") {
        // The stored hash is neither the one we verified nor our own
        // upgrade, so the verification is stale.
        logger.warn("login refused: password changed before the counter reset", {
          userId: user.id,
        });

        return fail("password_changed_concurrently");
      }

      if (resetOutcome.status === "not_found") {
        logger.warn("login refused: credential disappeared during login", { userId: user.id });
        return fail("invalid_credentials");
      }

      // --- 8. gate one: before creating a session ------------------------
      const preGate = await revalidate(user.id, acceptableHashes, threshold);

      if (!preGate.ok) {
        // Nothing was created, so there is nothing to clean up.
        return fail(preGate.reason, preGate.verificationTicket);
      }

      // --- 9. session ----------------------------------------------------
      const refresh = generateRefreshToken(rememberMe);

      let sessionId: EntityId;

      try {
        const session = await deps.sessions.create({
          userId: user.id,
          // Only the hash is stored. The raw token is returned to the caller
          // once and never persisted.
          refreshTokenHash: refresh.tokenHash,
          expiresAt: refresh.expiresAt,
          ...(client.device === undefined ? {} : { device: client.device }),
          ...(client.browser === undefined ? {} : { browser: client.browser }),
          ...(client.os === undefined ? {} : { os: client.os }),
          ...(client.ipAddress === undefined ? {} : { ipAddress: client.ipAddress }),
          ...(client.location === undefined ? {} : { location: client.location }),
        });

        sessionId = session.sessionId;
      } catch (err) {
        logger.error("login failed: could not create a session", {
          userId: user.id,
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        // No session, no token, no partial state.
        return fail("authentication_unavailable");
      }

      /**
       * Revokes the session this login just created.
       *
       * There is no unit of work across repositories, so an orphan is
       * compensated explicitly rather than left active. Best effort: the
       * session expires on its own, and its refresh token was never
       * returned to anyone.
       */
      const discardSession = async (): Promise<void> => {
        try {
          await deps.sessions.revokeSession({
            sessionId,
            userId: user.id,
            // An internal fault, not an administrative action.
            reason: "issuance_failed",
          });
        } catch (revokeErr) {
          logger.error("could not revoke the session after an authorization conflict", {
            userId: user.id,
            sessionId,
            errorType: describeError(revokeErr),
          });
        }
      };

      // --- 10. gate two: the authoritative check -------------------------
      // Runs AFTER the session row exists. Anything that committed before
      // this read is caught here and the session is revoked; anything that
      // commits after it will find our session and revoke it through the
      // mandated revoke-on-change path (§16.3).
      const finalGate = await revalidate(user.id, acceptableHashes, threshold);

      if (!finalGate.ok) {
        await discardSession();
        return fail(finalGate.reason, finalGate.verificationTicket);
      }

      // --- 11. token ------------------------------------------------------
      try {
        // The role comes from the FINAL authoritative read, so the JWT
        // carries the role that was authorized last - not the one captured
        // before the password was verified. A client-supplied role never
        // reaches this call.
        const issued = issueAccessToken({
          userId: finalGate.user.id,
          role: finalGate.user.role,
          sessionId,
        });

        logger.info("login succeeded", {
          userId: finalGate.user.id,
          role: finalGate.user.role,
          sessionId,
        });

        return {
          outcome: "success",
          data: {
            user: finalGate.user,
            accessToken: issued.token,
            expiresIn: issued.expiresIn,
            refreshToken: refresh.token,
            refreshTokenExpiresAt: refresh.expiresAt,
            sessionId,
          },
        };
      } catch (err) {
        logger.error("login failed: could not issue an access token", {
          userId: user.id,
          sessionId,
          // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
        });

        await discardSession();
        return fail("authentication_unavailable");
      }
    },
  };
};
