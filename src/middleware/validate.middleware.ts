import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodType } from "zod";

import type { FieldIssue } from "../contracts/api.contract";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListQuery,
  type PaginationQuery,
} from "../contracts/api.contract";
import { ApiError } from "../utils/api-error";
import { z } from "zod";

/** Schemas to apply to one route. Every part is optional. */
export interface ValidationSchemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

const toFieldIssues = (error: ZodError, section: keyof ValidationSchemas): FieldIssue[] =>
  error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : section,
    message: issue.message,
  }));

/**
 * Validates the incoming request against the given schemas and rejects
 * bad input at the edge with 422, so controllers only ever see valid data.
 *
 * Where the parsed values end up:
 *   body   -> req.body            (overwrite is safe)
 *   params -> req.params          (overwrite is safe)
 *   query  -> req.validatedQuery  (req.query is a getter in Express 5;
 *                                  assigning to it fails silently)
 */
export const validate = (schemas: ValidationSchemas): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: FieldIssue[] = [];

    if (schemas.body !== undefined) {
      const result = schemas.body.safeParse(req.body);
      if (result.success) {
        req.body = result.data;
      } else {
        issues.push(...toFieldIssues(result.error, "body"));
      }
    }

    if (schemas.params !== undefined) {
      const result = schemas.params.safeParse(req.params);
      if (result.success) {
        req.params = result.data as Record<string, string>;
      } else {
        issues.push(...toFieldIssues(result.error, "params"));
      }
    }

    if (schemas.query !== undefined) {
      const result = schemas.query.safeParse(req.query);
      if (result.success) {
        req.validatedQuery = result.data;
      } else {
        issues.push(...toFieldIssues(result.error, "query"));
      }
    }

    if (issues.length > 0) {
      next(ApiError.validation(issues));
      return;
    }

    next();
  };
};

/**
 * Shared pagination schema. Query values arrive as strings, so both fields
 * are coerced. Use it as `query: paginationSchema` or extend it with
 * `paginationSchema.extend({ ... })` for module-specific filters.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/** Reads validated pagination off the request. Call only behind `validate`. */
export const getPagination = (req: Request): PaginationQuery =>
  req.validatedQuery as PaginationQuery;

/**
 * Shared list schema: pagination + sorting + free-text search. This is the
 * standard query contract for every collection endpoint.
 *
 * `sortBy` is a free string here and MUST be checked by the module against
 * its own allow-list of sortable columns before it reaches the database.
 * Never interpolate it into a query. Build module filters by extending
 * this: `listQuerySchema.extend({ status: z.enum([...]).optional() })`.
 */
export const listQuerySchema = paginationSchema.extend({
  sortBy: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
  search: z.string().trim().min(1).max(120).optional(),
});

/** Reads validated list query off the request. Call only behind `validate`. */
export const getListQuery = (req: Request): ListQuery => req.validatedQuery as ListQuery;

/**
 * Guards a client-supplied sort field against a module's allow-list.
 * Returns undefined when nothing valid was requested, so the repository
 * can apply its own default ordering.
 */
export const resolveSortField = <TAllowed extends readonly string[]>(
  requested: string | undefined,
  allowed: TAllowed,
): TAllowed[number] | undefined =>
  requested !== undefined && allowed.includes(requested) ? requested : undefined;
