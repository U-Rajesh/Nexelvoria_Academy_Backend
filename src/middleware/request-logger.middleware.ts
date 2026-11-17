import type { NextFunction, Request, Response } from "express";

import { logger } from "../utils/logger";

/**
 * Logs one structured line per completed request.
 *
 * Deliberately logs metadata only - method, path, status, duration, ip and
 * the request id. It does NOT log the request body, headers, query string
 * values or the Authorization header, because those carry passwords, OTPs
 * and tokens. Logging the full URL would leak query values too, so only
 * the route path is recorded.
 *
 * Logging happens on response `finish` rather than up front, so one line
 * carries both the request and its outcome.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = process.hrtime.bigint();

  // Captured NOW, not in the finish handler. Express rewrites `req.url`
  // while dispatching into mounted routers, so by the time the response
  // finishes `req.path` reports the router-relative path ("/health")
  // rather than the real one ("/api/v1/health"). `req.originalUrl` is
  // stable, and splitting off the query string keeps token-bearing query
  // values out of the log.
  const path = req.originalUrl.split("?")[0] ?? req.originalUrl;

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const context = {
      requestId: req.requestId,
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
    };

    if (res.statusCode >= 500) {
      logger.error("request failed", context);
      return;
    }

    if (res.statusCode >= 400) {
      logger.warn("request rejected", context);
      return;
    }

    logger.info("request completed", context);
  });

  next();
};
