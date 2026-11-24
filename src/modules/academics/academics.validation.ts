import { z } from "zod";
import { ATTENDANCE_STATUSES } from "./academics.types";

/** BIGINT identity, accepted as a numeric string (or a JSON number). */
const numericId = (label: string) =>
  z
    .union([z.string().trim(), z.number().int().nonnegative()])
    .transform((v) => String(v))
    .refine((v) => /^\d{1,19}$/.test(v), { message: `${label} must be a numeric id` });

const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: `${label} must be a valid date-time` });

export const idParamsSchema = z.object({ id: numericId("Id") });

export const listSessionsQuerySchema = z.object({
  batchId: numericId("Batch").optional(),
  teacherUserId: numericId("Teacher").optional(),
  from: isoDate("from").optional(),
  to: isoDate("to").optional(),
});

/** NXA_ClassSessions: SessionTitle nvarchar(200), MeetingUrl nvarchar(1000). */
export const createSessionSchema = z
  .object({
    batchId: numericId("Batch"),
    teacherUserId: numericId("Teacher"),
    sessionTitle: z.string().trim().min(3).max(200),
    startsAt: isoDate("startsAt"),
    endsAt: isoDate("endsAt"),
    meetingUrl: z.string().trim().url().max(1000).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), { message: "endsAt must be after startsAt", path: ["endsAt"] });

/** The batch of a session cannot change; at least one field is required. */
export const updateSessionSchema = z
  .object({
    teacherUserId: numericId("Teacher").optional(),
    sessionTitle: z.string().trim().min(3).max(200).optional(),
    startsAt: isoDate("startsAt").optional(),
    endsAt: isoDate("endsAt").optional(),
    meetingUrl: z.string().trim().url().max(1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to change" });

/** NXA_AttendanceRecords: AttendanceStatus varchar(10), Remarks nvarchar(500). */
export const markAttendanceSchema = z
  .object({
    records: z
      .array(
        z
          .object({
            studentUserId: numericId("Student"),
            status: z.enum(ATTENDANCE_STATUSES),
            remarks: z.string().trim().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    // NXA_AttendanceChangeHistory.ChangeReason nvarchar(500) NOT NULL (required for corrections).
    reason: z.string().trim().min(5).max(500).optional(),
  })
  .strict()
  .refine((v) => new Set(v.records.map((r) => r.studentUserId)).size === v.records.length, {
    message: "Each student may appear only once",
    path: ["records"],
  });

export const summaryQuerySchema = z.object({ batchId: numericId("Batch") });

export const assessmentListQuerySchema = z.object({
  courseId: numericId("Course").optional(),
  batchId: numericId("Batch").optional(),
});

/** NXA_EvaluationRecords.MarksAwarded decimal(8,2). */
export const evaluateSubmissionSchema = z
  .object({
    marksAwarded: z.number().finite().min(0).max(999999.99),
    feedback: z.string().trim().max(4000).optional(),
  })
  .strict();

/** NXA_RetakeAuthorizations: AdditionalAttempts int, Reason nvarchar(500). */
export const authorizeRetakeSchema = z
  .object({
    studentUserId: numericId("Student"),
    additionalAttempts: z.number().int().min(1).max(100),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
