import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { SessionRepository } from "../modules/auth/session.repository";
import { getSessionStatus } from "../modules/auth/session.types";
import {
  type AccessTokenRejection,
  verifyAccessToken,
} from "../modules/auth/token.service";
import type {
  StudentAccessDecision,
  StudentAccessResolver,
  StudentAccessTier,
} from "../modules/students/student-access";
import { ApiError } from "../utils/api-error";
import { logger } from "../utils/logger";

/**
 * Authentication: turns a bearer token into `req.principal`, but ONLY if the
 * session behind it is still valid.
 *
 * This is the ONLY code that may populate an identity on a request.
 * Authorization is separate and unchanged - the Step 4 role guards
 * (`requireAdmin`, `requireStudent`, ...) read the identity this sets and
 * continue to fail closed when it is absent.
 *
 * Division of responsibility, deliberately kept sharp:
 *   authenticate -> WHO is calling     -> 401 when it cannot be established
 *   authorize    -> MAY they do this   -> 403 when the role is wrong
 *
 * ---------------------------------------------------------------------------
 * WHY THE SESSION LOOKUP EXISTS
 *
 * A verified signature proves only that WE issued the token and that it has
 * not expired. It says nothing about whether the session still exists. An
 * access token is self-contained, so without this lookup a token stolen
 * before logout keeps working until `exp`, and logout, "terminate this
 * session", suspension and reuse-revocation all become decorative.
 *
 * Validating on EVERY authenticated request was decided by the backend lead
 * at Step 6E (docs/auth-implementation-plan.md §14.3, option A): revocation
 * latency is zero, at the cost of one indexed read per request.
 * ---------------------------------------------------------------------------
 *
 * Never trusts the client for identity. The role comes from a signed token
 * and nowhere else: headers such as `X-User-Role`, query parameters and body
 * fields are never read here, so a client cannot assert who it is.
 */

/** `Bearer <token>` - exactly two parts, scheme matched case-insensitively. */
const BEARER_PATTERN = /^Bearer[ ]+(\S+)$/i;

/**
 * Extracts the credential from an Authorization header.
 *
 * Returns `null` for anything that is not a well-formed bearer header: a
 * missing header, a different scheme (Basic, Digest), a bare token with no
 * scheme, or extra whitespace-separated parts.
 */
export const extractBearerToken = (header: string | undefined): string | null => {
  if (header === undefined || header.trim() === "") {
    return null;
  }

  const match = BEARER_PATTERN.exec(header.trim());

  return match?.[1] ?? null;
};

/**
 * Dependencies, supplied through the existing DI convention.
 *
 * `sessions` is a RESOLVER, not an instance, and that is deliberate. The
 * container resolves repositories lazily and throws
 * `RepositoryNotConfiguredError` when no adapter is registered - which is
 * the state of production today. Taking an instance would mean resolving at
 * app-construction time, so `createApp()` would throw and the public health
 * endpoint would die with it.
 *
 * Resolving per request instead means: public routes keep working, the app
 * still boots, and protected routes FAIL CLOSED with a 503 until a real
 * adapter is registered. No request is ever served without session
 * validation.
 */
export interface AuthenticateDeps {
  sessions: () => SessionRepository;
  /**
   * Resolves a student's access tier on every request (CL-001). REQUIRED
   * so that no wiring can silently omit it: pass `null` only where no
   * student records exist (some isolated tests), in which case student
   * principals carry no tier and are treated as before.
   */
  studentAccess: StudentAccessResolver | null;
}

/**
 * Maps a token rejection onto the response the client receives.
 *
 * Only `expired` is distinguishable. Every other reason collapses into one
 * generic 401, because the differences describe HOW a forgery failed - "bad
 * signature" versus "bad issuer" versus "unknown role" tells an attacker
 * which part of their token to fix. `expired` is safe and useful: it is the
 * signal for the client to refresh rather than send the user back to login.
 */
const toApiError = (reason: AccessTokenRejection): ApiError => {
  if (reason === "expired") {
    return ApiError.unauthorized("Access token has expired", "TOKEN_EXPIRED");
  }

  return ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
};

/** The single generic authentication failure. Reveals nothing. */
const unauthenticated = (): ApiError =>
  ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");

/**
 * Builds the authentication middleware.
 *
 * Order of checks, each failing closed:
 *
 *   1. bearer credential present            -> 401 generic
 *   2. token verifies (signature, alg, exp,
 *      issuer, audience, role)              -> 401 (TOKEN_EXPIRED if expired)
 *   3. session repository available          -> 503 (cannot establish identity)
 *   4. session exists                        -> 401 generic
 *   5. session is neither revoked nor expired-> 401 generic
 *   6. session.userId === token `sub`        -> 401 generic + security log
 *   7. attach req.principal, then record activity (best effort)
 */
export const createAuthenticate = (deps: AuthenticateDeps): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Captured once: Express rewrites req.url during router dispatch, and the
    // query string is stripped so token-bearing values never reach a log.
    const path = req.originalUrl.split("?")[0] ?? req.originalUrl;
    const context = { requestId: req.requestId, method: req.method, path };

    // --- 1. credential ---------------------------------------------------
    const token = extractBearerToken(req.get("authorization"));

    if (token === null) {
      // Missing header, wrong scheme and malformed header are deliberately
      // indistinguishable to the client.
      logger.debug("authentication failed: no usable bearer credential", context);
      next(unauthenticated());
      return;
    }

    // --- 2. token --------------------------------------------------------
    const verified = verifyAccessToken(token);

    if (!verified.valid) {
      // The token itself is NEVER logged - only why it was refused.
      logger.warn("authentication failed: token rejected", {
        ...context,
        reason: verified.reason,
        ip: req.ip,
      });

      next(toApiError(verified.reason));
      return;
    }

    const claims = verified.claims;

    // --- 3. repository ---------------------------------------------------
    let sessions: SessionRepository;

    try {
      sessions = deps.sessions();
    } catch (err) {
      // No session adapter registered. A deployment fault, not a client
      // error - so it is a 503 rather than a 401, and access is DENIED.
      // Never degrade to "token looks fine, let it through": that would
      // reintroduce exactly the bypass this middleware exists to close.
      logger.error("authentication unavailable: no session repository is registered", {
        ...context,
        reason: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
      });

      next(
        ApiError.serviceUnavailable(
          "Authentication is temporarily unavailable",
          "SERVICE_UNAVAILABLE",
        ),
      );
      return;
    }

    // Everything below is async, so the handler returns a promise. Express 5
    // forwards a rejection to the error handler, but we handle failures
    // explicitly to guarantee fail-closed behaviour rather than a 500.
    void (async (): Promise<void> => {
      let session: Awaited<ReturnType<SessionRepository["findBySessionId"]>>;

      try {
        session = await sessions.findBySessionId(claims.sid);
      } catch (err) {
        // A store outage. We cannot establish identity, so we deny - but as
        // 503, because the credentials may be perfectly good and the client
        // should not discard them. See "database outages" in the plan.
        logger.error("authentication unavailable: session lookup failed", {
          ...context,
          reason: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
        });

        next(
          ApiError.serviceUnavailable(
            "Authentication is temporarily unavailable",
            "SERVICE_UNAVAILABLE",
          ),
        );
        return;
      }

      // --- 4. session exists --------------------------------------------
      if (session === null) {
        // Unknown sid: a token for a purged session, or a forgery that
        // somehow verified. Generic 401 - never say which.
        logger.warn("authentication failed: session not found", { ...context, ip: req.ip });
        next(unauthenticated());
        return;
      }

      // --- 5. session is usable -----------------------------------------
      const status = getSessionStatus(session);

      if (status !== "active") {
        // THIS is what makes logout and revocation real: the token is
        // cryptographically perfect and still refused.
        logger.warn("authentication failed: session is not active", {
          ...context,
          // Status and reason are logged for operators, never returned.
          sessionStatus: status,
          revocationReason: session.revocationReason,
          ip: req.ip,
        });

        next(unauthenticated());
        return;
      }

      // --- 6. ownership --------------------------------------------------
      if (session.userId !== claims.sub) {
        // Should be impossible: it means a token's `sid` points at another
        // user's session. Treated as a security event, logged at error.
        logger.error("authentication failed: token subject does not own the session", {
          ...context,
          ip: req.ip,
        });

        next(unauthenticated());
        return;
      }

      // --- 7. student access tier (CL-001) -------------------------------
      // Read fresh on every request, so approval, rejection, suspension or
      // deactivation take effect immediately rather than at token expiry.
      let studentAccess: StudentAccessTier | undefined;
      if (claims.role === "student" && deps.studentAccess !== null) {
        let decision: StudentAccessDecision;
        try {
          decision = await deps.studentAccess(claims.sub);
        } catch (err) {
          logger.error("authentication unavailable: student access lookup failed", {
            ...context,
            reason: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
          });
          next(ApiError.serviceUnavailable("Authentication is temporarily unavailable", "SERVICE_UNAVAILABLE"));
          return;
        }
        if (!decision.allowed) {
          logger.warn("authentication refused: student account may not be used", {
            ...context,
            reason: decision.reason,
          });
          next(ApiError.forbidden("This account cannot be used at the moment", "ACCOUNT_NOT_PERMITTED"));
          return;
        }
        studentAccess = decision.tier;
      }

      // --- 8. identity ---------------------------------------------------
      // The single assignment of an identity in the whole codebase.
      req.principal = {
        id: claims.sub,
        role: claims.role,
        sessionId: claims.sid,
        ...(studentAccess === undefined ? {} : { studentAccess }),
      };

      // Best effort, and deliberately not awaited for correctness: an
      // informational timestamp must never fail or delay a request.
      try {
        await sessions.updateLastActiveAt(session.sessionId, new Date().toISOString());
      } catch (err) {
        logger.warn("could not record session activity", {
          ...context,
          reason: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
        });
      }

      next();
    })();
  };
};
