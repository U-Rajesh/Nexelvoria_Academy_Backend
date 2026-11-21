import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import type { ApiFailure } from "../contracts/api.contract";
import { ApiError } from "../utils/api-error";
import { HttpStatus } from "../utils/http-status";
import { logger } from "../utils/logger";
import { isProduction } from "../config/env";

/**
 * The single place an error response is produced.
 *
 * Contract:
 *  - ApiError      -> its own status/code/message reach the client.
 *  - ZodError      -> 422 (a schema parsed outside `validate`).
 *  - body-parser   -> 413 too large / 400 malformed JSON.
 *  - anything else -> 500 with a generic message; the real error is logged
 *    but never leaked to the client.
 *
 * Express identifies error middleware by arity, so all four parameters
 * must stay declared even though `next` is unused.
 */

/** Shape body-parser uses for its own failures. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

const isBodyParserError = (err: unknown): err is BodyParserError =>
  err instanceof Error && typeof (err as BodyParserError).type === "string";

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const requestId = req.requestId;

  const base = {
    requestId,
    method: req.method,
    // originalUrl, not req.path: Express rewrites req.url during router
    // dispatch, so req.path would report the router-relative path here.
    // The query string is stripped so token-bearing values are not logged.
    path: req.originalUrl.split("?")[0] ?? req.originalUrl,
    ip: req.ip,
  };

  // The response has already started streaming - nothing safe left to do.
  if (res.headersSent) {
    logger.error("error thrown after response was sent", { ...base, err });
    return;
  }

  /** Adds the correlation id to every failure body. */
  const fail = (status: number, body: Omit<ApiFailure, "success">): void => {
    const payload: ApiFailure = { success: false, ...body };

    if (requestId !== undefined) {
      payload.requestId = requestId;
    }

    res.status(status).json(payload);
  };

  if (err instanceof ApiError) {
    // 4xx is caller error and stays at warn; 5xx is ours and is an error.
    if (err.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      logger.error("request failed", { ...base, statusCode: err.status, code: err.code, err });
    } else {
      logger.warn("request rejected", {
        ...base,
        statusCode: err.status,
        code: err.code,
        reason: err.message,
      });
    }

    fail(err.status, {
      message: err.message,
      error: err.code,
      ...(err.details === undefined ? {} : { details: err.details }),
    });
    return;
  }

  if (err instanceof ZodError) {
    logger.warn("request rejected", {
      ...base,
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: "VALIDATION_ERROR",
    });

    fail(HttpStatus.UNPROCESSABLE_ENTITY, {
      message: "Validation failed",
      error: "VALIDATION_ERROR",
      details: err.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  // Body parser failures are caller errors, not server faults, so they must
  // not be reported as 500s.
  if (isBodyParserError(err)) {
    if (err.type === "entity.too.large") {
      logger.warn("request rejected", {
        ...base,
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        code: "PAYLOAD_TOO_LARGE",
      });

      fail(HttpStatus.PAYLOAD_TOO_LARGE, {
        message: "Request body is too large",
        error: "PAYLOAD_TOO_LARGE",
      });
      return;
    }

    if (err.type === "entity.parse.failed") {
      logger.warn("request rejected", {
        ...base,
        statusCode: HttpStatus.BAD_REQUEST,
        code: "MALFORMED_JSON",
      });

      fail(HttpStatus.BAD_REQUEST, {
        message: "Request body is not valid JSON",
        error: "MALFORMED_JSON",
      });
      return;
    }
  }

  // Unexpected: a real bug. Log everything, tell the client nothing.
  logger.error("unhandled error", {
    ...base,
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    err,
  });

  fail(HttpStatus.INTERNAL_SERVER_ERROR, {
    message: isProduction
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Internal server error",
    error: "INTERNAL_SERVER_ERROR",
  });
};
