import { z } from "zod";
import { MAX_PAGE_SIZE } from "../../contracts/api.contract";
import { REPORT_CODES } from "./reports.types";

/** A real calendar date in YYYY-MM-DD form. */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD format.")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a valid calendar date.");

const rangeCheck = <T extends { from?: string | undefined; to?: string | undefined }>(v: T, ctx: z.RefinementCtx) => {
  if (v.from && v.to && v.from > v.to) ctx.addIssue({ code: "custom", path: ["from"], message: "The start date must not be after the end date." });
};

const filterShape = {
  from: day.optional(),
  to: day.optional(),
  // Status values are those present in the data (GET /:code/statuses); compared in lower case.
  status: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_ -]{1,40}$/, "Invalid status value.")
    .optional(),
  search: z.string().trim().min(1).max(100).optional(),
};

export const reportCodeParamsSchema = z.object({ code: z.enum(REPORT_CODES as [string, ...string[]]) });

export const reportQuerySchema = z
  .object({
    ...filterShape,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  })
  .superRefine(rangeCheck);

/** Custom report fields: comma-separated column keys (checked against the report's columns by the route). */
const columnsParam = z
  .string()
  .regex(/^[A-Za-z]+(,[A-Za-z]+)*$/, "List column keys separated by commas.")
  .max(500)
  .optional();

export const exportQuerySchema = z
  .object({ ...filterShape, format: z.enum(["csv", "xlsx", "pdf"]), columns: columnsParam })
  .superRefine(rangeCheck);

export const rangeQuerySchema = z.object({ from: day.optional(), to: day.optional() }).superRefine(rangeCheck);
