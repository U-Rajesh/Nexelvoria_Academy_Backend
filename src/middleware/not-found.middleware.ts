import type { NextFunction, Request, Response } from "express";

import { ApiError } from "../utils/api-error";

/**
 * Terminal catch-all for unmatched routes. Registered after every router.
 *
 * It hands an ApiError to the error middleware rather than responding
 * directly, so 404s are formatted by the same code path as every other
 * error.
 */
export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, "ROUTE_NOT_FOUND"));
};
