import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Verification tickets
// ---------------------------------------------------------------------------

/**
 * A short-lived, purpose-scoped bearer of ONE fact: "whoever holds this has
 * already proven control of this account."
 *
 * ===========================================================================
 * WHY A TICKET EXISTS AT ALL.
 *
 * The OTP endpoints need to know WHICH account a code belongs to. They used
 * to be told directly - `{ studentId, otp }` - and `RegisterPage` put that
 * id in a URL (`/verify-otp?studentId=user-2`). Two problems:
 *
 *  1. A real internal identifier travelled in a query string, where it lands
 *     in browser history, referrer headers and server logs.
 *  2. Keying the endpoints by any client-supplied identifier means the
 *     endpoint must either leak whether that identifier exists, or collapse
 *     every failure into one unhelpful message.
 *
 * A ticket solves both. The id becomes an opaque signed claim, so nothing
 * identifying crosses the wire, and because a ticket is only ever issued
 * AFTER proof of control - a completed registration, or a login with the
 * correct password - the endpoints can afford precise, helpful errors
 * ("2 attempts remaining") without telling a stranger anything.
 * ===========================================================================
 *
 * ===========================================================================
 * THREE INDEPENDENT SEPARATIONS FROM AN ACCESS TOKEN.
 *
 * A ticket must never be usable as an access token, and an access token must
 * never be usable as a ticket. Any one of these would be enough; all three
 * are present so that a mistake in one does not breach the boundary.
 *
 *  1. A DIFFERENT SIGNING KEY, derived from `JWT_SECRET` by HKDF under a
 *     distinct `info` label. This is the strongest of the three: a ticket
 *     presented as an access token fails the SIGNATURE check, before any
 *     claim is examined. The same pattern already protects OTP hashes
 *     (`otp.service.ts`), and it needs no new configuration - so no existing
 *     deployment gains a required variable.
 *  2. A DIFFERENT AUDIENCE. `jwt.verify` rejects a mismatched `aud` at the
 *     library layer, so even with a shared key the token would be refused
 *     before our own claim checks ran.
 *  3. AN EXPLICIT `purpose` CLAIM, asserted on use. Defence in depth, and it
 *     makes the token self-describing to anyone debugging one.
 *
 * Beyond those, a ticket simply lacks what `verifyAccessToken` demands: it
 * carries no `sid` and no `role`, so that function would reject it twice
 * over even if the key and audience were shared.
 * ===========================================================================
 */

/** Ticket lifetime. Long enough to read an email, short enough to be cheap. */
export const VERIFICATION_TICKET_TTL_SECONDS = 15 * 60;

/** The `purpose` claim value. Only email verification exists today. */
export const VERIFICATION_TICKET_PURPOSE = "email_verification" as const;

/**
 * The ticket audience - deliberately NOT `env.JWT_AUDIENCE`.
 *
 * Derived from it rather than configured separately, so the two can never
 * drift apart in a deployment that sets one and forgets the other.
 */
export const VERIFICATION_TICKET_AUDIENCE = `${env.JWT_AUDIENCE}:email-verification`;

/**
 * The ticket signing key.
 *
 * HKDF from `JWT_SECRET` with its own `info`, giving cryptographic domain
 * separation: this key cannot be used to forge an access token and the
 * access-token key cannot be used to forge a ticket, even though both derive
 * from one configured secret.
 *
 * Rotating `JWT_SECRET` invalidates outstanding tickets. That is correct and
 * already true of access tokens; a student simply requests a new code.
 */
const VERIFICATION_TICKET_KEY: Buffer = Buffer.from(
  hkdfSync("sha256", env.JWT_SECRET, "nexelvoria-otp-ticket", "otp-ticket-v1", 32),
);

/** A freshly issued ticket. */
export interface IssuedVerificationTicket {
  ticket: string;
  /** Seconds until it expires, so a client can show a countdown. */
  expiresIn: number;
}

/** Why a ticket was refused. For logs and triage; only `expired` is shown. */
export type VerificationTicketRejection =
  | "missing"
  | "expired"
  | "invalid_signature"
  | "invalid_audience"
  | "invalid_issuer"
  | "invalid_algorithm"
  | "invalid_purpose"
  | "invalid_claims";

export type VerificationTicketVerification =
  | { valid: true; userId: EntityId }
  | { valid: false; reason: VerificationTicketRejection };

/**
 * Issues a verification ticket for a user.
 *
 * CALLERS MUST HAVE ESTABLISHED CONTROL FIRST. Today that means a completed
 * registration or a login whose password verified. Issuing one from an
 * unauthenticated request keyed by an email address would turn this into an
 * account-enumeration oracle and undo the reason it exists.
 */
export const issueVerificationTicket = (userId: EntityId): IssuedVerificationTicket => {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("Refusing to issue a verification ticket without a user id.");
  }

  const ticket = jwt.sign(
    { purpose: VERIFICATION_TICKET_PURPOSE },
    VERIFICATION_TICKET_KEY,
    {
      algorithm: JWT_ALGORITHM,
      subject: userId,
      expiresIn: VERIFICATION_TICKET_TTL_SECONDS,
      issuer: env.JWT_ISSUER,
      audience: VERIFICATION_TICKET_AUDIENCE,
    },
  );

  return { ticket, expiresIn: VERIFICATION_TICKET_TTL_SECONDS };
};

/** Maps a jsonwebtoken failure onto the ticket rejection vocabulary. */
const classifyTicketError = (err: unknown): VerificationTicketRejection => {
  if (!(err instanceof Error)) {
    return "invalid_claims";
  }

  if (err.name === "TokenExpiredError") {
    return "expired";
  }

  if (err.message.includes("audience")) {
    return "invalid_audience";
  }

  if (err.message.includes("issuer")) {
    return "invalid_issuer";
  }

  if (err.message.includes("algorithm")) {
    return "invalid_algorithm";
  }

  return "invalid_signature";
};

/**
 * Verifies a ticket and returns the user it was issued for.
 *
 * Never throws - a bad ticket is an expected input. Checks, in order:
 * signature (under the ticket key), algorithm allow-list, expiry, issuer,
 * audience, then the `purpose` and `sub` claims.
 */
export const verifyVerificationTicket = (
  ticket: unknown,
): VerificationTicketVerification => {
  if (typeof ticket !== "string" || ticket.trim() === "") {
    return { valid: false, reason: "missing" };
  }

  let decoded: unknown;

  try {
    decoded = jwt.verify(ticket, VERIFICATION_TICKET_KEY, {
      algorithms: [JWT_ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: VERIFICATION_TICKET_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
  } catch (err) {
    const reason = classifyTicketError(err);

    // The ticket itself is never logged - only why it was refused.
    logger.debug("verification ticket rejected", { reason });

    return { valid: false, reason };
  }

  if (typeof decoded !== "object" || decoded === null) {
    return { valid: false, reason: "invalid_claims" };
  }

  const payload = decoded as Record<string, unknown>;
  const { sub, purpose } = payload;

  if (typeof sub !== "string" || sub === "") {
    logger.warn("verification ticket rejected: no subject");
    return { valid: false, reason: "invalid_claims" };
  }

  // Asserted rather than assumed: a future ticket purpose must not be
  // accepted by this one's verifier just because it was signed with the
  // same key.
  if (purpose !== VERIFICATION_TICKET_PURPOSE) {
    logger.warn("verification ticket rejected: wrong purpose");
    return { valid: false, reason: "invalid_purpose" };
  }

  return { valid: true, userId: sub };
};
