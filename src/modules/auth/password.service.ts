import { randomBytes } from "node:crypto";
import argon2 from "argon2";

import type { FieldIssue } from "../../contracts/api.contract";
import { ApiError } from "../../utils/api-error";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import { PASSWORD_MAX_LENGTH, passwordPolicySchema } from "./auth.validation";

/**
 * Password hashing and policy enforcement.
 *
 * The single place in the codebase that touches a plaintext password or a
 * password hash. Nothing else should import argon2.
 *
 * Invariants this module exists to guarantee:
 *  - A plaintext password is never logged, never stored, never returned, and
 *    never placed in an error message.
 *  - A password hash is never logged and never returned to a caller. The only
 *    thing that leaves this module is a boolean (plus a rehash hint).
 *  - A stored value that is not a valid argon2 hash denies access rather than
 *    crashing the request or, worse, admitting the caller.
 *  - A password that fails policy is never hashed at all.
 *
 * Note that `UserRepository` (Step 5) deliberately exposes no password field:
 * hashes will be reached only through a dedicated credential repository, so no
 * ordinary user query can select one into a response or a log line.
 */

/**
 * Argon2id parameters.
 *
 * Why argon2id: it is memory-hard, so it resists GPU and ASIC cracking far
 * better than bcrypt, and it is the current OWASP first choice. The `id`
 * variant combines argon2i's side-channel resistance with argon2d's
 * resistance to time-memory trade-offs.
 *
 * These values are OWASP's published m=46MiB, t=1, p=1 configuration with one
 * extra pass. They were MEASURED on the development host rather than copied:
 *
 *   m=19MiB t=2 p=1   ->  51 ms   (OWASP minimum)
 *   m=19MiB t=3 p=1   ->  66 ms
 *   m=46MiB t=1 p=1   ->  76 ms   (OWASP alternative)
 *   m=46MiB t=2 p=1   -> 122 ms   <- chosen
 *   m=64MiB t=3 p=1   -> 248 ms
 *
 * ~120 ms is the interactive sweet spot: slow enough that offline cracking is
 * expensive, fast enough that a login feels instant.
 *
 * MEMORY BUDGET - read before deploying. Each in-flight hash allocates 46 MiB,
 * so 10 simultaneous logins need ~460 MiB on top of the process baseline. On a
 * small instance that is an availability risk. Two things bound it: the
 * `loginRateLimiter` from Step 4 (10 attempts per IP per 15 minutes) and the
 * fact that hashing only happens on login, registration and password change.
 * If the deployment target is memory-constrained, drop to the OWASP minimum
 * (m=19456, t=3) - it is a one-line change here and old hashes keep working,
 * because `needsRehash()` upgrades them on the owner's next successful login.
 *
 * Salts are 16 random bytes generated per password by argon2 itself; we never
 * supply or manage one. The returned PHC string carries the algorithm, the
 * parameters and the salt together, which is what makes a future parameter
 * change safe for existing hashes.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  /** 46 MiB, in KiB. */
  memoryCost: 47_104,
  /** Passes over memory. */
  timeCost: 2,
  /** Lanes. 1 keeps cost predictable under concurrency. */
  parallelism: 1,
} as const;

/** Prefix every argon2id PHC string starts with. */
const ARGON2ID_PREFIX = "$argon2id$";

/** Result of a policy check. Mirrors the 422 `details[]` shape. */
export interface PasswordPolicyResult {
  valid: boolean;
  /** Empty when valid. One entry per failed rule. */
  issues: FieldIssue[];
}

/**
 * Result of a verification.
 *
 * Deliberately carries no hash, no plaintext and no reason for failure - a
 * caller gets a boolean and nothing it could leak.
 */
export interface PasswordVerificationResult {
  /** True only when the password matches a well-formed stored hash. */
  valid: boolean;
  /**
   * True when the password was correct but the stored hash used weaker
   * parameters than current policy. The caller should re-hash and store the
   * result - this is the only moment the plaintext is available to do so.
   */
  needsRehash: boolean;
}

/**
 * Checks a password against the policy WITHOUT hashing it.
 *
 * Pure and synchronous, so it is cheap to call from a validation layer. Does
 * not throw: a policy failure is ordinary user input, not an exception.
 *
 * @param password  the candidate. Typed `unknown` because it often arrives
 *                  straight from a request body.
 * @param field     field name to report issues under, e.g. "newPassword" for
 *                  the reset flow, so `details[]` points at the right input.
 */
export const validatePasswordPolicy = (
  password: unknown,
  field = "password",
): PasswordPolicyResult => {
  const result = passwordPolicySchema.safeParse(password);

  if (result.success) {
    return { valid: true, issues: [] };
  }

  return {
    valid: false,
    // Messages come from the schema, which mirrors the frontend's wording.
    // The password itself is never echoed back in an issue.
    issues: result.error.issues.map((issue) => ({ field, message: issue.message })),
  };
};

/**
 * Hashes a password with argon2id.
 *
 * Enforces the policy first and throws `ApiError.validation` when it fails, so
 * a weak password is never hashed or stored. That maps directly onto the 422
 * the API must return, with per-rule `details[]`.
 *
 * @throws ApiError 422 when the password does not satisfy the policy.
 */
export const hashPassword = async (password: unknown, field = "password"): Promise<string> => {
  const policy = validatePasswordPolicy(password, field);

  if (!policy.valid) {
    // ApiError carries the field issues; it never carries the password.
    throw ApiError.validation(policy.issues, "Password does not meet the required policy");
  }

  // Safe after a successful policy check.
  return argon2.hash(password as string, ARGON2_OPTIONS);
};

/** True when `value` looks like an argon2id PHC string. */
const isArgon2idHash = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(ARGON2ID_PREFIX);

/**
 * Verifies a password against a stored hash.
 *
 * Fails closed in every abnormal case. A missing, empty, truncated, foreign or
 * corrupt stored hash returns `valid: false` - it never throws at the caller
 * and never admits anyone. A malformed hash is a data-integrity problem worth
 * an error log, but from the caller's side it is simply a failed login.
 *
 * The policy is deliberately NOT applied here. Policy can tighten over time,
 * and re-checking it at verification would lock out users whose existing
 * password predates the change. Policy belongs at the moment a password is
 * set; verification only answers "is this the right password".
 */
export const verifyPassword = async (
  storedHash: unknown,
  password: unknown,
): Promise<PasswordVerificationResult> => {
  const deny: PasswordVerificationResult = { valid: false, needsRehash: false };

  if (!isArgon2idHash(storedHash)) {
    // Includes null/undefined (no credential row) and any non-argon2id value.
    // Logged WITHOUT the value, so a hash never reaches the log.
    logger.error("stored password hash is missing or not argon2id", {
      storedHashType: typeof storedHash,
    });

    return deny;
  }

  // Reject absurd input before paying to hash it. Note this is a length check
  // on the CANDIDATE, not a policy check - see the comment above.
  if (typeof password !== "string" || password.length === 0) {
    return deny;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return deny;
  }

  let matches: boolean;

  try {
    // argon2.verify reads the parameters and salt out of the stored PHC
    // string, and compares in constant time.
    matches = await argon2.verify(storedHash, password);
  } catch (err) {
    // Thrown for a structurally invalid hash the prefix check did not catch,
    // e.g. a corrupt salt segment. Deny, and log the fault - not the value.
    //
    // Only the error's name and message are logged, never the error object
    // itself. argon2's parse failures are structural and do not echo their
    // input, but passing the whole error would put an attacker-influenced
    // value one library change away from the log file, and this module's
    // invariant is that a hash never reaches a log.
    logger.error("password verification failed: stored hash could not be parsed", {
      // Error CLASS only. A driver message can embed credentials,
          // hosts and connection strings; describeError drops it.
          errorType: describeError(err),
    });

    return deny;
  }

  if (!matches) {
    return deny;
  }

  return { valid: true, needsRehash: needsRehash(storedHash) };
};

/**
 * True when a stored hash was produced with weaker parameters than current
 * policy and should be upgraded.
 *
 * Returns false for anything unparseable: an unusable hash cannot be upgraded
 * automatically, and that case is already reported by `verifyPassword`.
 */
export const needsRehash = (storedHash: unknown): boolean => {
  if (!isArgon2idHash(storedHash)) {
    return false;
  }

  try {
    return argon2.needsRehash(storedHash, ARGON2_OPTIONS);
  } catch {
    return false;
  }
};

/**
 * Lazily built hash of a random throwaway value.
 *
 * Not a credential and not an account: the plaintext is 32 random bytes that
 * are discarded immediately and never retained, so nothing can ever verify
 * against it.
 */
let dummyHash: Promise<string> | undefined;

/**
 * Spends the same work as a real verification, then denies.
 *
 * Use when no credential exists for the submitted identifier. Without it,
 * "no such user" returns in under a millisecond while "wrong password" takes
 * ~120 ms, and that difference is a reliable account-existence oracle - an
 * attacker learns which email addresses are registered without ever logging
 * in. Step 6A flagged this; the countermeasure lives here so the login
 * service cannot forget it.
 *
 * Always resolves false.
 */
export const verifyAgainstDummyHash = async (password: unknown): Promise<false> => {
  dummyHash ??= argon2.hash(randomBytes(32).toString("hex"), ARGON2_OPTIONS);

  try {
    const hash = await dummyHash;

    if (typeof password === "string" && password.length > 0 && password.length <= PASSWORD_MAX_LENGTH) {
      await argon2.verify(hash, password);
    }
  } catch {
    // Swallowed on purpose: this path exists only to consume time.
  }

  return false;
};
