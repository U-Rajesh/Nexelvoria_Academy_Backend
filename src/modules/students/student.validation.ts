import { z } from "zod";

import { USER_STATUSES } from "../../contracts/user.contract";
import { listQuerySchema } from "../../middleware/validate.middleware";
import { ADMIN_APPROVAL_STATUSES, ADMIN_SETTABLE_STUDENT_STATUSES } from "./student.types";

/**
 * zod schemas for the `students` module.
 *
 *   GET   /students                     api-contracts 5 #1  (Task 3.1)
 *   GET   /students/:studentId          api-contracts 5 #3  (Task 3.1)
 *   PATCH /students/:studentId/status   api-contracts 5 #4  (Task 3.2)
 */

/**
 * An `EntityId` from a client: opaque string (open-questions Q1), only
 * emptiness and a sanity length are checked, never a format. Kept local
 * rather than imported from `courses` - modules must not reach into each
 * other (architecture section 7).
 */
const entityIdSchema = z.string().trim().min(1, "Id is required").max(128);

/** `:studentId` path param. */
export const studentIdParamsSchema = z.object({
  studentId: entityIdSchema,
});

export type StudentIdParams = z.infer<typeof studentIdParamsSchema>;

/**
 * `GET /students` query - the shared list contract (page, pageSize,
 * sortBy, sortOrder, search) plus the filters api-contracts section 5
 * lists: status, approvalStatus, courseId, batchId, passingYear.
 *
 * `sortBy` stays a free string here; the service checks it against
 * `STUDENT_SORT_FIELDS` (section 3.8). `search` spans name, email, mobile
 * and collegeName (section 5).
 */
export const studentListQuerySchema = listQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  approvalStatus: z.enum(ADMIN_APPROVAL_STATUSES).optional(),
  courseId: entityIdSchema.optional(),
  batchId: entityIdSchema.optional(),
  // Stored as a 4-digit year string (frontend `passingYear: string`). Only
  // the shape is checked - no range is enforced, none being approved.
  passingYear: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Must be a 4-digit year")
    .optional(),
});

export type StudentListQuery = z.infer<typeof studentListQuerySchema>;

/**
 * `PATCH /students/:studentId/status` body - approved shape at Task 3.2:
 *   { "status": "active" | "suspended" | "deactivated" }
 * `pending`, any other value, a missing field or a missing body is a 422.
 */
export const studentStatusBodySchema = z.object({
  status: z.enum(ADMIN_SETTABLE_STUDENT_STATUSES, {
    message: 'status must be one of "active", "suspended" or "deactivated"',
  }),
});

export type StudentStatusBody = z.infer<typeof studentStatusBodySchema>;
