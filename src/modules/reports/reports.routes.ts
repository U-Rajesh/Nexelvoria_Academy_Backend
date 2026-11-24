import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireRoles } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { ADMIN_ROLES } from "../../contracts/user.contract";
import { ApiError } from "../../utils/api-error";
import { sendSuccess } from "../../utils/send";
import type { ReportsRepository, DateRange } from "./reports.repository";
import { EXPORT_TYPES, renderReport, type ExportFormat } from "./report-files";
import {
  MAX_ANALYTICS_MONTHS,
  ReportTooLargeError,
  describeFilters,
  financialSummaryRows,
  financialYearStartDay,
  istToday,
  monthsBetween,
} from "./reports.rules";
import { REPORTS, REPORT_CODES, type ReportCode, type ReportFilter, type ReportRole } from "./reports.types";
import { BR011_MIN_ATTENDANCE_PERCENT, attendanceFigure, effectiveThreshold, isBelowThreshold } from "../academics/academic-rules";
import { exportQuerySchema, rangeQuerySchema, reportCodeParamsSchema, reportQuerySchema } from "./reports.validation";

export interface ReportsRoutesOptions {
  reports: ReportsRepository;
  authenticate?: RequestHandler;
  /** Institute name from settings, printed on exports. */
  instituteName?: () => Promise<string | undefined>;
  /** The saved minimum attendance %; the BR-011 floor applies when absent or lower (D1). */
  minimumAttendance?: () => Promise<number | undefined>;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

/** Attendance Summary rows: the shared D2 formula and the unrounded below-minimum comparison. */
export const withAttendancePercentages = (rows: Record<string, unknown>[], minimum: number): Record<string, unknown>[] =>
  rows.map((r) => {
    const f = attendanceFigure({ present: num(r["present"]), absent: num(r["absent"]), leave: num(r["leave"]) });
    const below = isBelowThreshold(f.percentage, minimum);
    return {
      ...r,
      markedSessions: f.markedSessions,
      attendancePercentage: f.percentageDisplay ?? "",
      belowMinimum: below === null ? "" : below ? "yes" : "no",
    };
  });

const handle =
  (work: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await work(req, res);
    } catch (err) {
      if (err instanceof ReportTooLargeError) return next(ApiError.validation([{ field: "query", message: err.message }], err.message));
      next(err);
    }
  };

const roleOf = (req: Request): ReportRole => (req.principal?.role === "super_admin" ? "super_admin" : "admin");

/** Report access by role (REP-007): role-based until BR-018 defines permissions. */
const allowed = (req: Request, code: ReportCode): void => {
  if (!REPORTS[code].roles.includes(roleOf(req))) throw ApiError.forbidden("This report is available to the Super Admin only.");
};

const filterOf = (q: Record<string, unknown>): ReportFilter => ({
  ...(q.from ? { from: String(q.from) } : {}),
  ...(q.to ? { to: String(q.to) } : {}),
  ...(q.status ? { status: String(q.status) } : {}),
  ...(q.search ? { search: String(q.search) } : {}),
});

/** Default range: the current Indian financial year to today (IST). */
const rangeOf = (q: { from?: string; to?: string }): DateRange => ({
  from: q.from ?? financialYearStartDay(),
  to: q.to ?? istToday(),
});

export const createReportsRoutes = (options: ReportsRoutesOptions): Router => {
  const router = Router();
  const auth = options.authenticate ? [options.authenticate] : [];
  const guard = [...auth, requireRoles(ADMIN_ROLES)];
  const repo = () => options.reports;
  const minimumAttendance = async (): Promise<number> =>
    effectiveThreshold(options.minimumAttendance ? await options.minimumAttendance().catch(() => undefined) : undefined, BR011_MIN_ATTENDANCE_PERCENT);

  router.get(
    "/catalog",
    ...guard,
    handle(async (req, res) => {
      const role = roleOf(req);
      sendSuccess(res, { data: REPORT_CODES.map((c) => REPORTS[c]).filter((d) => d.roles.includes(role)) });
    }),
  );

  router.get(
    "/analytics",
    ...guard,
    validate({ query: rangeQuerySchema }),
    handle(async (req, res) => {
      const range = rangeOf(req.validatedQuery as { from?: string; to?: string });
      if (range.from > range.to) throw ApiError.validation([{ field: "from", message: "The start date must not be after the end date." }]);
      if (monthsBetween(range.from, range.to).length > MAX_ANALYTICS_MONTHS) {
        throw ApiError.validation([{ field: "from", message: `Choose a range of at most ${MAX_ANALYTICS_MONTHS} months.` }]);
      }
      sendSuccess(res, { data: await repo().analytics(range) });
    }),
  );

  router.get(
    "/financial-summary",
    ...guard,
    validate({ query: rangeQuerySchema }),
    handle(async (req, res) => {
      allowed(req, "financial-summary");
      const range = rangeOf(req.validatedQuery as { from?: string; to?: string });
      if (range.from > range.to) throw ApiError.validation([{ field: "from", message: "The start date must not be after the end date." }]);
      const summary = await repo().financialSummary(range);
      sendSuccess(res, { data: { summary, rows: financialSummaryRows(summary), columns: REPORTS["financial-summary"].columns } });
    }),
  );

  router.get(
    "/:code/statuses",
    ...guard,
    validate({ params: reportCodeParamsSchema }),
    handle(async (req, res) => {
      const code = req.params.code as ReportCode;
      allowed(req, code);
      if (code === "financial-summary" || !REPORTS[code].hasStatus) return sendSuccess(res, { data: [] });
      sendSuccess(res, { data: await repo().listStatuses(code) });
    }),
  );

  router.get(
    "/:code/export",
    ...guard,
    validate({ params: reportCodeParamsSchema, query: exportQuerySchema }),
    handle(async (req, res) => {
      const code = req.params.code as ReportCode;
      allowed(req, code);
      const def = REPORTS[code];
      const q = req.validatedQuery as Record<string, unknown> & { format: ExportFormat; columns?: string };
      // Custom report fields (REP-002): only columns the report defines, kept in the report's order.
      const wanted = q.columns ? q.columns.split(",") : null;
      const unknown = wanted?.filter((k) => !def.columns.some((c) => c.key === k)) ?? [];
      if (unknown.length) throw ApiError.validation([{ field: "columns", message: `Unknown column(s) for this report: ${unknown.join(", ")}` }]);
      const columns = wanted ? def.columns.filter((c) => wanted.includes(c.key)) : def.columns;
      let rows: Record<string, unknown>[];
      let filter: ReportFilter;
      let filterLines: string[];
      if (code === "financial-summary") {
        const range = rangeOf(q as { from?: string; to?: string });
        filter = range;
        rows = financialSummaryRows(await repo().financialSummary(range));
        filterLines = [`Period: ${range.from} to ${range.to} (IST)`];
      } else {
        filter = filterOf(q);
        rows = (await repo().runReport(code, filter, null)).rows;
        filterLines = describeFilters(def, filter);
        if (code === "attendance-summary") {
          const minimum = await minimumAttendance();
          rows = withAttendancePercentages(rows, minimum);
          filterLines.push(`Minimum attendance: ${minimum}%`);
        }
      }
      const institute = options.instituteName ? await options.instituteName().catch(() => undefined) : undefined;
      if (institute) filterLines.unshift(`Institute: ${institute}`);
      const generatedAt = new Date();
      if (wanted) filterLines.push(`Fields: ${columns.map((c) => c.label).join(", ")}`);
      const file = renderReport(q.format, { title: def.title, generatedAt, filters: filterLines, columns, rows });
      // Every export is audited (who, which report, filters, row count) before the file leaves the server.
      await repo().recordExport({
        actorUserId: String(req.principal?.id ?? ""),
        reportCode: code,
        format: q.format,
        filter,
        ...(wanted ? { columns: columns.map((c) => c.key) } : {}),
        rowCount: rows.length,
      });
      const type = EXPORT_TYPES[q.format];
      const stamp = istToday(generatedAt);
      res.setHeader("Content-Type", type.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${code}-${stamp}.${type.extension}"`);
      res.setHeader("X-Report-Row-Count", String(rows.length));
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(file);
    }),
  );

  router.get(
    "/:code",
    ...guard,
    validate({ params: reportCodeParamsSchema, query: reportQuerySchema }),
    handle(async (req, res) => {
      const code = req.params.code as ReportCode;
      allowed(req, code);
      if (code === "financial-summary") throw ApiError.notFound("Use /financial-summary for this report.");
      const q = req.validatedQuery as Record<string, unknown> & { page: number; pageSize: number };
      const filter = filterOf(q);
      const result = await repo().runReport(code, filter, { page: q.page, pageSize: q.pageSize });
      const minimum = code === "attendance-summary" ? await minimumAttendance() : undefined;
      sendSuccess(res, {
        data: {
          report: REPORTS[code],
          filter,
          rows: minimum === undefined ? result.rows : withAttendancePercentages(result.rows, minimum),
          ...(minimum === undefined ? {} : { minimumAttendancePercentage: minimum }),
          total: result.total,
          page: q.page,
          pageSize: q.pageSize,
          totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
        },
      });
    }),
  );

  return router;
};
