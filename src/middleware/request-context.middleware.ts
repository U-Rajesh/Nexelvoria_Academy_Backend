import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Assigns a correlation id to every request and echoes it back.
 *
 * Must be the first middleware registered, so that an error anywhere -
 * including in the body parsers - can still be traced.
 *
 * An inbound `X-Request-Id` is honoured so a trace can span the frontend
 * and a reverse proxy, but it is validated and length-capped first: the
 * header is attacker-controlled, and it ends up in logs. An unvalidated
 * value would allow log injection (newlines forging fake log lines) and
 * unbounded memory per request.
 */

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const REQUEST_ID_HEADER = "X-Request-Id";

/** Accepts a client-supplied id only if it is safe to put in a log line. */
export const sanitizeRequestId = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  return SAFE_REQUEST_ID.test(value) ? value : undefined;
};

export const requestContext = (req: Request, res: Response, next: NextFunction): void => {
  const inbound = sanitizeRequestId(req.get(REQUEST_ID_HEADER));
  const requestId = inbound ?? randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
};
