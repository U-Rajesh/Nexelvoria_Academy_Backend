import { z } from "zod";

import { USER_STATUSES } from "../../contracts/user.contract";
import { listQuerySchema } from "../../middleware/validate.middleware";

/**
 * zod schemas for the `teachers` module.
 *
 *   GET   /teachers              api-contracts 6 #1  (Teacher Management T1)
 *   GET   /teachers/:teacherId   api-contracts 6 #3  (T1)
 *   PATCH /teachers/:teacherId   api-contracts 6 #4  (T2, profile fields only)
 *
 * LENGTH LIMITS ARE PROVISIONAL defensive bounds, not business rules: the
 * frontend's add-teacher form defines none, and column sizes are the
 * database team's call (database-handoff Q-T8). Align them once confirmed.
 */

/**
 * An `EntityId` from a client: opaque string (open-questions Q1). Only
 * emptiness and a sanity length are checked, never a format. Kept local -
 * modules do not import each other's internals (architecture section 7).
 */
const entityIdSchema = z.string().trim().min(1, "Id is required").max(128);

/** Required, trimmed, non-empty text with a provisional maximum. */
const text = (max: number) => z.string().trim().min(1, "Must not be empty").max(max);

export const SPECIALIZATION_MAX_LENGTH = 100;
export const QUALIFICATIONS_MAX_LENGTH = 500;
export const BIO_MAX_LENGTH = 2000;
/** Provisional sanity ceiling; the requirement is "non-negative integer". */
export const EXPERIENCE_YEARS_MAX = 80;

/** `:teacherId` path param. */
export const teacherIdParamsSchema = z.object({
  teacherId: entityIdSchema,
});

export type TeacherIdParams = z.infer<typeof teacherIdParamsSchema>;

/**
 * `GET /teachers` query: the shared list contract (page, pageSize, sortBy,
 * sortOrder, search) plus the `TeacherFilter` fields.
 *
 * `sortBy` stays a free string here; the service checks it against
 * `TEACHER_SORT_FIELDS` (api-contracts 3.8). `search` spans name, email and
 * specialization. Unknown params are stripped (3.7).
 */
export const teacherListQuerySchema = listQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  specialization: text(SPECIALIZATION_MAX_LENGTH).optional(),
  courseId: entityIdSchema.optional(),
  batchId: entityIdSchema.optional(),
});

export type TeacherListQuery = z.infer<typeof teacherListQuerySchema>;

/**
 * `PATCH /teachers/:teacherId` body - PROFILE fields only.
 *
 * Deliberately ABSENT, so they are stripped if sent and can never be
 * changed here:
 *   - `email`, `role`, `status`, `rating`, `assignedCourseIds`,
 *     `assignedBatchIds`, `id`, `createdAt` (not updatable through this
 *     endpoint by approval).
 *   - `name`, `mobile` - identity fields. Whether they live on the teacher
 *     or the user record depends on the unresolved teacher-to-user linkage
 *     (the teacher counterpart of open-questions Q25), so they are deferred.
 *   - `avatarUrl` - REMOVED by approval. It is a `User` field owned by the
 *     user record under the adopted identity model (Q25); updating it on the
 *     teacher record would diverge from the avatar the signed-in teacher
 *     sees. A body carrying only `avatarUrl` is therefore a 422.
 *
 * At least one updatable field is required: a body that contains only
 * prohibited or unknown keys would otherwise "succeed" while changing
 * nothing, which hides the client's mistake.
 */
export const updateTeacherBodySchema = z
  .object({
    specialization: text(SPECIALIZATION_MAX_LENGTH),
    // 80 is a provisional sanity ceiling. Checked against api-contracts and
    // database-handoff: neither constrains experienceYears, and the frontend
    // form sets no maximum - so it conflicts with nothing.
    experienceYears: z
      .number({ message: "Must be a number" })
      .int("Must be a whole number of years")
      .nonnegative("Must not be negative")
      .max(EXPERIENCE_YEARS_MAX, `Must be at most ${EXPERIENCE_YEARS_MAX}`),
    bio: text(BIO_MAX_LENGTH),
    qualifications: text(QUALIFICATIONS_MAX_LENGTH),
  })
  .partial()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message:
      "Provide at least one updatable field: specialization, experienceYears, bio or qualifications",
  });

export type UpdateTeacherBody = z.infer<typeof updateTeacherBodySchema>;
