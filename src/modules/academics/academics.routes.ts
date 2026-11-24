import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES } from "../../contracts/user.contract";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";
import { AcademicRuleError, type AcademicsRepository } from "./academics.repository";
import { BR011_MIN_ATTENDANCE_PERCENT, attendanceFigure, effectiveThreshold, isBelowThreshold } from "./academic-rules";
import type { AttendanceSummary } from "./academics.types";
import {
  assessmentListQuerySchema,
  authorizeRetakeSchema,
  createSessionSchema,
  evaluateSubmissionSchema,
  idParamsSchema,
  listSessionsQuerySchema,
  markAttendanceSchema,
  summaryQuerySchema,
  updateSessionSchema,
} from "./academics.validation";

/** Adds the D2 attendance percentage and the below-minimum flag to a summary. */
export const withAttendanceFigures = (summary: AttendanceSummary, minimum: number): AttendanceSummary => ({
  ...summary,
  minimumAttendancePercentage: minimum,
  students: summary.students.map((row) => {
    const f = attendanceFigure(row);
    return {
      ...row,
      markedSessions: f.markedSessions,
      attendancePercentage: f.percentage,
      attendancePercentageDisplay: f.percentageDisplay,
      belowMinimum: isBelowThreshold(f.percentage, minimum),
    };
  }),
});

export interface AcademicsRoutesOptions {
  /** The saved minimum attendance %; the BR-011 floor applies when absent or lower (D1). */
  minimumAttendance?: () => Promise<number | undefined>;
  academics: AcademicsRepository;
  authenticate?: RequestHandler;
}

const ENTITY_LABEL: Record<string, string> = {
  batch: "Batch not found.",
  "class session": "Class session not found.",
  assignment: "Assignment not found.",
  submission: "Submission not found.",
  test: "Test not found.",
};

function actorId(req: Request): string {
  const id = req.principal?.id ?? (req as { user?: { userId?: string; id?: string } }).user?.userId;
  if (!id) throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  return String(id);
}

/** Strips undefined keys (exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** Repository errors -> HTTP: unknown record 404, rule 409/422. */
const handle =
  (work: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await work(req, res);
    } catch (err) {
      if (err instanceof RecordNotFoundError) return next(ApiError.notFound(ENTITY_LABEL[err.entity] ?? "Record not found."));
      if (err instanceof AcademicRuleError) return next(new ApiError(err.status, err.message, err.code));
      next(err);
    }
  };

/**
 * Admin / Super Admin academic oversight, mounted at /admin/academics.
 * Teacher endpoints are untouched; nothing here widens teacher access.
 */
export function createAcademicsRoutes(options: AcademicsRoutesOptions): Router {
  const router = Router();
  const repo = () => options.academics;
  const guards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];
  router.use(...guards);

  // ---- class schedules
  router.get(
    "/class-sessions",
    handle(async (req, res) => {
      const q = listSessionsQuerySchema.parse(req.query);
      sendSuccess(res, { data: await repo().listClassSessions(defined(q)) });
    }),
  );
  router.post(
    "/class-sessions",
    handle(async (req, res) => {
      const body = createSessionSchema.parse(req.body);
      const session = await repo().createClassSession(
        { batchId: body.batchId, teacherUserId: body.teacherUserId, sessionTitle: body.sessionTitle, startsAt: body.startsAt, endsAt: body.endsAt, ...defined({ meetingUrl: body.meetingUrl }) },
        actorId(req),
      );
      sendSuccess(res, { status: HttpStatus.CREATED, data: session, message: "Class session scheduled." });
    }),
  );
  router.patch(
    "/class-sessions/:id",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      const body = updateSessionSchema.parse(req.body);
      sendSuccess(res, { data: await repo().updateClassSession(id, defined(body), actorId(req)) });
    }),
  );

  // ---- attendance
  router.get(
    "/class-sessions/:id/attendance",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().getSessionAttendance(id) });
    }),
  );
  router.put(
    "/class-sessions/:id/attendance",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      const body = markAttendanceSchema.parse(req.body);
      const records = body.records.map((r) => ({ studentUserId: r.studentUserId, status: r.status, ...defined({ remarks: r.remarks }) }));
      sendSuccess(res, { data: await repo().markAttendance(id, records, body.reason, actorId(req)) });
    }),
  );
  router.get(
    "/class-sessions/:id/attendance/history",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().getAttendanceChanges(id) });
    }),
  );
  router.get(
    "/attendance/summary",
    handle(async (req, res) => {
      const { batchId } = summaryQuerySchema.parse(req.query);
      const saved = options.minimumAttendance ? await options.minimumAttendance() : undefined;
      const minimum = effectiveThreshold(saved, BR011_MIN_ATTENDANCE_PERCENT);
      sendSuccess(res, { data: withAttendanceFigures(await repo().getAttendanceSummary(batchId), minimum) });
    }),
  );

  // ---- assignments
  router.get(
    "/assignments",
    handle(async (req, res) => {
      sendSuccess(res, { data: await repo().listAssignments(defined(assessmentListQuerySchema.parse(req.query))) });
    }),
  );
  router.get(
    "/assignments/:id/submissions",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().listSubmissions(id) });
    }),
  );
  // ASM-012: every evaluation version (history is append-only).
  router.get(
    "/assignment-submissions/:id/evaluations",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().listEvaluations(id) });
    }),
  );
  router.post(
    "/assignment-submissions/:id/evaluations",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      const body = evaluateSubmissionSchema.parse(req.body);
      const result = await repo().evaluateSubmission(id, { marksAwarded: body.marksAwarded, ...defined({ feedback: body.feedback }) }, actorId(req));
      sendSuccess(res, { status: HttpStatus.CREATED, data: result, message: "Evaluation recorded." });
    }),
  );

  // ---- tests
  router.get(
    "/tests",
    handle(async (req, res) => {
      sendSuccess(res, { data: await repo().listTests(defined(assessmentListQuerySchema.parse(req.query))) });
    }),
  );
  router.get(
    "/tests/:id/attempts",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().listTestAttempts(id) });
    }),
  );
  router.get(
    "/tests/:id/retake-authorizations",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().listRetakeAuthorizations(id) });
    }),
  );
  router.post(
    "/tests/:id/retake-authorizations",
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      const body = authorizeRetakeSchema.parse(req.body);
      const result = await repo().authorizeRetake(id, body, actorId(req));
      sendSuccess(res, { status: HttpStatus.CREATED, data: result, message: "Retake authorized." });
    }),
  );

  return router;
}
