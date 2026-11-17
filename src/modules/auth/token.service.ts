import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import { AUTHENTICATED_ROLES, type UserRole } from "../../contracts/user.contract";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

/**
 * Access tokens and refresh-token primitives.
 *
 * The only module that signs or verifies a token. Nothing else should import
 * `jsonwebtoken` or read `env.JWT_SECRET`.
 *
 * This step implements the cryptographic primitives ONLY. There is no session
 * store, no refresh endpoint, no login and no authentication middleware - a
 * refresh token is generated and hashed here, but persisting it is Step 6D's
 * job.
 *
 * ---------------------------------------------------------------------------
 * PROVISIONAL DECISIONS - not approved business requirements.
 *
 * The lifetimes, algorithm and claim set below were supplied as provisional
 * defaults for this isolated step. They are recorded in
 * docs/auth-implementation-plan.md as decisions D9 (lifetimes) and D8
 * (secret handling), both still awaiting the backend lead's ratification.
 * `rememberMe` semantics remain open question O6.
 *
 * Changing any of them is a one-line change here.
 * ---------------------------------------------------------------------------
 */

/** Access token lifetime. Provisional: 15 minutes. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh token lifetime. Provisional: 7 days. */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Refresh lifetime when the user ticked "remember me". Provisional: 30 days. */
export const REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The ONLY accepted signing algorithm.
 *
 * Pinned to a single value and always passed to `verify`. Without an explicit
 * allow-list a verifier will honour whatever `alg` the token header claims,
 * which is the classic JWT break: `alg: none` strips the signature entirely,
 * and swapping an RS256 token for HS256 lets an attacker sign with the public
 * key. Neither is possible when only HS256 is accepted.
 */
export const JWT_ALGORITHM = "HS256" as const;

/**
 * Tolerance for clock drift between processes, in seconds.
 *
 * Small on purpose: it extends the effective life of an expired token by this
 * much, so it buys resilience to minor skew without meaningfully widening the
 * window. Whether the database and app servers share a clock is open question
 * Q-A6 in docs/database-handoff.md.
 */
const CLOCK_TOLERANCE_SECONDS = 5;

/** Bytes of entropy in a refresh token. 32 bytes = 256 bits. */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Claims carried by an access token.
 *
 * Deliberately minimal. No email, no name, no permissions, no profile data:
 *
 *  - A token is a cache, and a cached permission is a privilege bug waiting
 *    to happen - revoking a role would leave the old one valid until expiry.
 *  - Anything placed here is readable by anyone holding the token. A JWT is
 *    signed, NOT encrypted; the payload is plain base64url.
 */
export interface AccessTokenClaims {
  /** Authenticated user id. */
  sub: EntityId;
  /** Role, as resolved server-side. Never taken from a request. */
  role: UserRole;
  /** Session id, so a token can be tied to a revocable session. */
  sid: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/** What a caller must supply to mint a token. */
export interface IssueAccessTokenInput {
  userId: EntityId;
  /**
   * The role as determined by the server from its own records.
   *
   * NEVER pass a value that originated in a request body, query string or
   * header. The whole point of signing the role is that the client cannot
   * choose it.
   */
  role: UserRole;
  sessionId: string;
}

/** A freshly minted access token. */
export interface IssuedAccessToken {
  token: string;
  /** Seconds until expiry, for the client's refresh scheduling. */
  expiresIn: number;
  expiresAt: IsoDateTime;
}

/**
 * Why a token was refused.
 *
 * For server-side logging and triage. Only `expired` is safe to distinguish
 * to a client - it tells the frontend to refresh rather than re-authenticate.
 * Every other reason must surface as a generic 401, because the differences
 * describe how a forgery failed and that is an oracle.
 */
export type AccessTokenRejection =
  | "missing"
  | "malformed"
  | "expired"
  | "invalid_signature"
  | "invalid_issuer"
  | "invalid_audience"
  | "invalid_algorithm"
  | "invalid_role"
  | "invalid_claims";

export type AccessTokenVerification =
  | { valid: true; claims: AccessTokenClaims }
  | { valid: false; reason: AccessTokenRejection };

/**
 * Issues a signed access token.
 *
 * `iat` and `exp` are set by the library from `expiresIn`; `iss` and `aud`
 * come from configuration so both sides of the verification agree.
 */
export const issueAccessToken = (input: IssueAccessTokenInput): IssuedAccessToken => {
  // Guard against a caller passing something that is not a real role, e.g. a
  // value that reached them from a request. `public` is excluded because it
  // means "not authenticated" and must never be minted into a token.
  if (!AUTHENTICATED_ROLES.includes(input.role as (typeof AUTHENTICATED_ROLES)[number])) {
    throw new Error(`Refusing to issue an access token for role "${input.role}".`);
  }

  if (input.userId.trim() === "" || input.sessionId.trim() === "") {
    throw new Error("Refusing to issue an access token without a user id and session id.");
  }

  const token = jwt.sign(
    { role: input.role, sid: input.sessionId },
    env.JWT_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      subject: input.userId,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
  );

  return {
    token,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
};

/** Maps a jsonwebtoken failure onto our rejection vocabulary. */
const classifyError = (err: unknown): AccessTokenRejection => {
  if (err instanceof jwt.TokenExpiredError) {
    return "expired";
  }

  if (err instanceof jwt.JsonWebTokenError) {
    const message = err.message.toLowerCase();

    if (message.includes("signature")) return "invalid_signature";
    if (message.includes("issuer")) return "invalid_issuer";
    if (message.includes("audience")) return "invalid_audience";
    if (message.includes("algorithm")) return "invalid_algorithm";

    return "malformed";
  }

  return "malformed";
};

/**
 * Verifies an access token and returns its claims.
 *
 * Checks, in the order the library applies them: signature, algorithm
 * allow-list, expiry, issuer, audience. Then we check the claims we care
 * about ourselves, because a validly signed token can still carry a payload
 * we would not accept.
 *
 * Never throws. A bad token is an expected input, not an exception.
 */
export const verifyAccessToken = (token: unknown): AccessTokenVerification => {
  if (typeof token !== "string" || token.trim() === "") {
    return { valid: false, reason: "missing" };
  }

  let decoded: unknown;

  try {
    decoded = jwt.verify(token, env.JWT_SECRET, {
      // The allow-list. Without it, the token's own header decides.
      algorithms: [JWT_ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
  } catch (err) {
    const reason = classifyError(err);

    // Logged at debug: a rejected token is routine traffic, and the token
    // itself is never logged - only why it was refused.
    logger.debug("access token rejected", { reason });

    return { valid: false, reason };
  }

  if (typeof decoded !== "object" || decoded === null) {
    return { valid: false, reason: "invalid_claims" };
  }

  const payload = decoded as Record<string, unknown>;

  const { sub, role, sid, iat, exp, iss, aud } = payload;

  // A token missing any of these is not one we issued, even if it verifies.
  if (
    typeof sub !== "string" ||
    sub === "" ||
    typeof sid !== "string" ||
    sid === "" ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    typeof iss !== "string" ||
    typeof aud !== "string"
  ) {
    logger.warn("access token rejected: claim set is incomplete");
    return { valid: false, reason: "invalid_claims" };
  }

  // The role must be one we recognise AND one that denotes an authenticated
  // user. A token claiming `public`, an unknown role, or a renamed role is
  // refused rather than defaulted - a default would be a privilege decision
  // made by accident.
  if (
    typeof role !== "string" ||
    !AUTHENTICATED_ROLES.includes(role as (typeof AUTHENTICATED_ROLES)[number])
  ) {
    logger.warn("access token rejected: role is not an accepted authenticated role");
    return { valid: false, reason: "invalid_role" };
  }

  return {
    valid: true,
    claims: { sub, role: role as UserRole, sid, iat, exp, iss, aud },
  };
};

// ---------------------------------------------------------------------------
// Refresh token primitives
// ---------------------------------------------------------------------------

/** A generated refresh token and the verifier to store alongside the session. */
export interface GeneratedRefreshToken {
  /**
   * The secret, returned to the client exactly once. NEVER persist this
   * value and never log it.
   */
  token: string;
  /** The verifier to store. Safe to persist. */
  tokenHash: string;
  expiresAt: IsoDateTime;
  expiresInSeconds: number;
}

/**
 * Generates a refresh token.
 *
 * 32 bytes (256 bits) from the CSPRNG, base64url encoded so it is safe in a
 * JSON body and a header. `Math.random()` is predictable and must never be
 * used for anything security-bearing.
 *
 * A refresh token is an opaque random string, NOT a JWT: it carries no
 * claims, so it reveals nothing if intercepted, and it is only meaningful
 * next to the stored session row - which is what makes revocation possible
 * at all.
 *
 * It must travel in a request BODY, never in a URL. URLs end up in browser
 * history, proxy logs, server access logs and `Referer` headers.
 */
export const generateRefreshToken = (rememberMe = false): GeneratedRefreshToken => {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");

  const expiresInSeconds = rememberMe
    ? REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS
    : REFRESH_TOKEN_TTL_SECONDS;

  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    expiresInSeconds,
  };
};

/**
 * Hashes a refresh token for storage.
 *
 * SHA-256, deliberately - and this is NOT the same decision as password
 * hashing:
 *
 *  - A password is low-entropy and human-chosen, so a stolen hash must be
 *    expensive to attack: argon2id, ~120 ms per attempt (password.service.ts).
 *  - A refresh token is 256 bits of uniform randomness. There is nothing to
 *    guess, so a slow hash buys no security - it would only add latency to
 *    every refresh. The hash exists so that a database disclosure does not
 *    hand over usable tokens.
 *
 * Unkeyed on purpose: lookups happen BY hash, so the same input must always
 * give the same output.
 */
export const hashRefreshToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Compares a presented refresh token against a stored verifier.
 *
 * Uses `timingSafeEqual`, so the comparison takes the same time whether the
 * mismatch is in the first byte or the last. A plain `===` leaks how much of
 * a candidate was correct, which is enough to reconstruct a value byte by
 * byte given enough attempts.
 *
 * Returns false for any malformed input rather than throwing - fail closed.
 */
export const verifyRefreshTokenHash = (token: unknown, storedHash: unknown): boolean => {
  if (typeof token !== "string" || token === "") {
    return false;
  }

  if (typeof storedHash !== "string" || storedHash === "") {
    return false;
  }

  const candidate = Buffer.from(hashRefreshToken(token), "utf8");
  const expected = Buffer.from(storedHash, "utf8");

  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first. Hash length is fixed and public, so this leaks nothing.
  if (candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidate, expected);
};
