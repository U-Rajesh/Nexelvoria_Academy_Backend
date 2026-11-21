import type { Request, Response } from "express";

import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import { ApiError } from "../../utils/api-error";
import { HttpStatus, type HttpStatusCode } from "../../utils/http-status";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import { sendSuccess } from "../../utils/send";
import type { User } from "../users/user.types";
import type {
  LoginClientContext,
  LoginFailureReason,
  LoginService,
  LoginSuccess,
} from "./login.service";
import type { RefreshFailureReason, RefreshService } from "./refresh.service";
import type { SessionService } from "./session.service";

/**
 * HTTP layer for the four authentication endpoints (decisions D1-D4).
 *
 * The services own every security decision (password verification before
 * account state, lockout, rotation, reuse detection). This controller only
 * translates their typed outcomes into HTTP, and whitelists what leaves.
 *
 * Nothing here logs a password, a token, a token hash or a password hash:
 * the services already log outcomes, so the controller adds no logging on
 * the success or refusal paths.
 */

interface Refusal {
  status: HttpStatusCode;
  code: string;
  message: string;
}

/**
 * D1: one HTTP status + code per login refusal reason. A `Record` keyed by
 * the service's union makes a new, unmapped reason a compile error.
 * Failed-attempt counts are deliberately never returned.
 */
export const LOGIN_REFUSALS: Readonly<Record<LoginFailureReason, Refusal>> = Object.freeze({
  invalid_credentials: {
    status: HttpStatus.UNAUTHORIZED,
    code: "INVALID_CREDENTIALS",
    message: "Invalid email/mobile or password.",
  },
  account_locked: {
    status: HttpStatus.FORBIDDEN,
    code: "ACCOUNT_LOCKED",
    message:
      "Your account is locked after too many failed attempts. Reset your password or contact support.",
  },
  account_pending: {
    status: HttpStatus.FORBIDDEN,
    code: "ACCOUNT_PENDING",
    message: "Your account is not active yet.",
  },
  // MERGE: two reasons added to LoginFailureReason by nex_b_development.
  // Status, code and message copied exactly from its dev login controller
  // (dev/auth.dev.controller.ts) so both login routes refuse identically.
  account_pending_verification: {
    status: HttpStatus.FORBIDDEN,
    code: "ACCOUNT_PENDING_VERIFICATION",
    message: "Please verify your email address to continue. Enter the 6-digit code we sent you.",
  },
  account_pending_approval: {
    status: HttpStatus.FORBIDDEN,
    code: "ACCOUNT_PENDING_APPROVAL",
    message: "Your email is verified and your registration is awaiting administrator approval.",
  },
  account_suspended: {
    status: HttpStatus.FORBIDDEN,
    code: "ACCOUNT_SUSPENDED",
    message: "Your account has been suspended. Please contact support.",
  },
  account_deactivated: {
    status: HttpStatus.FORBIDDEN,
    code: "ACCOUNT_DEACTIVATED",
    message: "Your account has been deactivated. Please contact support.",
  },
  password_changed_concurrently: {
    status: HttpStatus.CONFLICT,
    code: "CONFLICT",
    message: "Your password changed while signing in. Please try again.",
  },
  authentication_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: "SERVICE_UNAVAILABLE",
    message: "Sign-in is temporarily unavailable. Please try again shortly.",
  },
});

const SESSION_ENDED: Refusal = {
  status: HttpStatus.UNAUTHORIZED,
  code: "UNAUTHENTICATED",
  message: "Your session has ended. Please sign in again.",
};

/**
 * Refresh refusals. Invalid token, reuse and an unauthorised user are all
 * the SAME response: reuse details are never disclosed to the client (the
 * service logs them). Never `TOKEN_EXPIRED`, so a client that refreshes on
 * TOKEN_EXPIRED can never be told to refresh again by the refresh endpoint.
 */
export const REFRESH_REFUSALS: Readonly<Record<RefreshFailureReason, Refusal>> = Object.freeze({
  invalid_refresh_token: SESSION_ENDED,
  token_reuse_detected: SESSION_ENDED,
  user_not_authorized: SESSION_ENDED,
  refresh_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: "SERVICE_UNAVAILABLE",
    message: "Session refresh is temporarily unavailable. Please try again shortly.",
  },
});

/** /auth/me: a non-active account gets the same refusal login would give. */
const STATUS_REFUSALS: Readonly<Record<Exclude<UserStatus, "active">, Refusal>> = Object.freeze({
  pending: LOGIN_REFUSALS.account_pending,
  suspended: LOGIN_REFUSALS.account_suspended,
  deactivated: LOGIN_REFUSALS.account_deactivated,
});

const refuse = (refusal: Refusal): ApiError => new ApiError(refusal.status, refusal.message, refusal.code);

const unauthenticated = (): ApiError => ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");

/**
 * The ONLY user shape that leaves the auth endpoints (D3: base User).
 * Built field by field, so whatever extra a repository adapter returns
 * (credential, lockout or audit columns) is dropped.
 */
export interface UserView {
  id: EntityId;
  name: string;
  email: string;
  mobile: string;
  role: User["role"];
  status: User["status"];
  avatarUrl?: string;
  createdAt: string;
}

export const toUserView = (user: User): UserView => ({
  id: user.id,
  name: user.name,
  email: user.email,
  mobile: user.mobile,
  role: user.role,
  status: user.status,
  ...(user.avatarUrl === undefined ? {} : { avatarUrl: user.avatarUrl }),
  createdAt: user.createdAt,
});

/** Login and refresh share this response shape. */
export interface AuthTokensView {
  user: UserView;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: EntityId;
}

const toAuthTokensView = (data: LoginSuccess): AuthTokensView => ({
  user: toUserView(data.user),
  accessToken: data.accessToken,
  expiresIn: data.expiresIn,
  refreshToken: data.refreshToken,
  refreshTokenExpiresAt: data.refreshTokenExpiresAt,
  sessionId: data.sessionId,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface AuthControllerDeps {
  login: LoginService;
  refresh: RefreshService;
  sessions: SessionService;
  /** `users.findById`, resolved lazily. */
  findUserById: (id: EntityId) => Promise<User | null>;
}

export const createAuthController = (deps: AuthControllerDeps) => ({
  /** POST /auth/login - body `{ identifier, password, rememberMe? }`. */
  async login(req: Request, res: Response): Promise<void> {
    // The service validates the body itself and answers invalid input with
    // `invalid_credentials`, so no field-level 422 is ever disclosed here.
    const client: LoginClientContext = typeof req.ip === "string" && req.ip !== "" ? { ipAddress: req.ip } : {};
    const result = await deps.login.login(req.body, client);

    if (result.outcome === "failure") {
      throw refuse(LOGIN_REFUSALS[result.reason]);
    }

    sendSuccess(res, { data: toAuthTokensView(result.data), message: "Login successful" });
  },

  /**
   * POST /auth/refresh - body `{ refreshToken }` (D2). No access token is
   * required or read: an expired access token must not block a refresh.
   */
  async refresh(req: Request, res: Response): Promise<void> {
    const presented = isRecord(req.body) ? req.body["refreshToken"] : undefined;
    const result = await deps.refresh.refresh(presented);

    if (result.outcome === "failure") {
      throw refuse(REFRESH_REFUSALS[result.reason]);
    }

    sendSuccess(res, { data: toAuthTokensView(result.data), message: "Session refreshed" });
  },

  /**
   * POST /auth/logout - revokes the CURRENT session (the token's `sid`).
   * Idempotent: a session that is already gone is still a successful
   * logout. Only a storage failure is reported (503); clients must clear
   * their local tokens regardless.
   */
  async logout(req: Request, res: Response): Promise<void> {
    const principal = req.principal;
    if (principal === undefined) {
      throw unauthenticated();
    }

    const result = await deps.sessions.logout(principal);

    if (result.outcome === "unavailable") {
      throw ApiError.serviceUnavailable("Sign-out is temporarily unavailable. Please try again shortly.");
    }

    sendSuccess(res, { message: "Logged out" });
  },

  /** GET /auth/me - the caller's base User (D3). */
  async me(req: Request, res: Response): Promise<void> {
    const principal = req.principal;
    if (principal === undefined) {
      throw unauthenticated();
    }

    let user: User | null;
    try {
      user = await deps.findUserById(principal.id);
    } catch (err) {
      logger.error("current user lookup failed", {
        requestId: req.requestId,
        userId: principal.id,
        errorType: describeError(err),
      });
      throw ApiError.serviceUnavailable("Your account details are temporarily unavailable. Please try again shortly.");
    }

    if (user === null) {
      throw unauthenticated();
    }

    if (user.status !== "active") {
      throw refuse(STATUS_REFUSALS[user.status]);
    }

    sendSuccess(res, { data: toUserView(user) });
  },
});

export type AuthController = ReturnType<typeof createAuthController>;
