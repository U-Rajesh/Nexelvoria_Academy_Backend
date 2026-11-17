import type { FieldIssue } from "../contracts/api.contract";
import { HttpStatus, type HttpStatusCode } from "./http-status";

/**
 * The only error type services and controllers should throw.
 *
 * Anything thrown that is NOT an ApiError is treated by the error
 * middleware as an unexpected bug: it becomes a generic 500 and the
 * real message is logged but never sent to the client.
 *
 * Express 5 forwards rejected promises to the error handler automatically,
 * so `throw new ApiError(...)` inside an async controller is enough - no
 * try/catch and no asyncHandler wrapper are required.
 */
export class ApiError extends Error {
  readonly status: HttpStatusCode;
  /** Machine-readable code for the frontend to branch on. */
  readonly code: string;
  readonly details?: FieldIssue[];
  /** true = safe to show the user; false = unexpected, hide the message. */
  readonly isOperational = true;

  constructor(status: HttpStatusCode, message: string, code: string, details?: FieldIssue[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }

    Error.captureStackTrace(this, ApiError);
  }

  static badRequest(message: string, code = "BAD_REQUEST"): ApiError {
    return new ApiError(HttpStatus.BAD_REQUEST, message, code);
  }

  static unauthorized(message = "Authentication required", code = "UNAUTHORIZED"): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, message, code);
  }

  static forbidden(message = "You do not have access to this resource", code = "FORBIDDEN"): ApiError {
    return new ApiError(HttpStatus.FORBIDDEN, message, code);
  }

  static notFound(message = "Resource not found", code = "NOT_FOUND"): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, message, code);
  }

  static conflict(message: string, code = "CONFLICT"): ApiError {
    return new ApiError(HttpStatus.CONFLICT, message, code);
  }

  static tooManyRequests(
    message = "Too many requests. Please try again later.",
    code = "TOO_MANY_REQUESTS",
  ): ApiError {
    return new ApiError(HttpStatus.TOO_MANY_REQUESTS, message, code);
  }

  /**
   * A dependency we need is unavailable or misconfigured.
   *
   * Distinct from a 500: nothing is broken in the request, and the caller
   * may reasonably retry. Used where identity cannot be ESTABLISHED (as
   * opposed to being established and rejected) - see
   * authenticate.middleware.ts.
   */
  static serviceUnavailable(
    message = "Service temporarily unavailable",
    code = "SERVICE_UNAVAILABLE",
  ): ApiError {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, message, code);
  }

  static validation(details: FieldIssue[], message = "Validation failed"): ApiError {
    return new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, message, "VALIDATION_ERROR", details);
  }
}
