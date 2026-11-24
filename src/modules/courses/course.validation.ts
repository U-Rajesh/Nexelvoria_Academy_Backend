import { z } from "zod";

import { listQuerySchema } from "../../middleware/validate.middleware";
import {
  COURSE_CATEGORIES,
  COURSE_LEVELS,
  COURSE_STATUSES,
  LESSON_TYPES,
  RESERVED_COURSE_SLUGS,
} from "./course.types";

/**
 * zod schemas for the `courses` module.
 *
 * Public catalogue (Step 1) first, then management (Step 2A).
 */

/**
 * Slug rules: lowercase letters and digits in hyphen-separated groups,
 * e.g. `java-full-stack`.
 *
 * Normalised to lowercase BEFORE the pattern check, following
 * open-questions Q17: slug matching must not silently depend on SQL Server
 * collation, so the application treats `Java-Full-Stack` and
 * `java-full-stack` as the same slug.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 150;

export const courseSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug is required")
  .max(SLUG_MAX_LENGTH, `Slug must be at most ${SLUG_MAX_LENGTH} characters`)
  .regex(SLUG_PATTERN, "Slug may contain only lowercase letters, digits and single hyphens");

/** `GET /courses/:slug` path params. */
export const courseSlugParamsSchema = z.object({
  slug: courseSlugSchema,
});

export type CourseSlugParams = z.infer<typeof courseSlugParamsSchema>;

/**
 * Query-string boolean.
 *
 * Deliberately NOT `z.coerce.boolean()`: that runs `Boolean("false")`,
 * which is `true`, so `?hasPlacementGuarantee=false` would return exactly
 * the courses the caller asked to exclude. Only the literal strings
 * "true" and "false" are accepted; anything else is a 422.
 */
const queryBoolean = z
  .enum(["true", "false"], { message: 'Expected "true" or "false"' })
  .transform((value) => value === "true");

/**
 * `GET /courses` query.
 *
 * Built on the shared `listQuerySchema` - page, pageSize, sortBy,
 * sortOrder, search - exactly as api-contracts section 3.6 requires of
 * every collection endpoint:
 *   - `sortOrder` other than asc|desc is a 422.
 *   - `sortBy` is a free string HERE and is checked against
 *     `COURSE_SORT_FIELDS` by the service via `resolveSortField` (3.8); an
 *     unknown field falls back to the default order, never reaching the
 *     repository.
 *
 * `status` and `publishedOnly` are intentionally NOT accepted: the public
 * catalogue's visibility is decided by the server, never by the caller.
 * Unknown params are stripped (section 3.7).
 */
export const publicCourseListQuerySchema = listQuerySchema.extend({
  category: z.enum(COURSE_CATEGORIES).optional(),
  level: z.enum(COURSE_LEVELS).optional(),
  hasPlacementGuarantee: queryBoolean.optional(),
});

export type PublicCourseListQuery = z.infer<typeof publicCourseListQuerySchema>;

// ===========================================================================
// Management (Step 2A) - admin-only endpoints, api-contracts section 7 #3-#9.
//
// LENGTH LIMITS ARE PROVISIONAL. They are defensive bounds, not business
// rules: the real column sizes (NVARCHAR(n)) are the database team's call
// (database-handoff section 6). Align these once the schema is confirmed.
// ===========================================================================

/**
 * An `EntityId` arriving from a client. Opaque string (open-questions Q1);
 * only emptiness and a sanity length are checked, never a format.
 */
const entityIdSchema = z.string().trim().min(1, "Id is required").max(128);

/** Required, trimmed, non-empty text. */
const text = (max: number) => z.string().trim().min(1, "Must not be empty").max(max);

/**
 * Absolute http(s) URL. Uploads are undecided (open-questions Q11), so
 * media fields are plain URLs for now. Other schemes - `javascript:`,
 * `data:` - are rejected because these values end up in `href`/`src`.
 */
const httpUrl = z.url({ protocol: /^https?$/, message: "Must be an absolute http(s) URL" }).max(2048);

/**
 * Optional field where the frontend sends `""` for "not set" (its form
 * state defaults to empty strings). A blank string becomes "absent" rather
 * than a stored empty value or a 422 the user cannot act on.
 */
const blankAsAbsent = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

/** Whole INR. Money is never a float (course.types.ts, handoff on money). */
const wholeInr = z.number().int("Must be a whole number of INR").nonnegative();

const textList = (itemMax: number) => z.array(text(itemMax)).max(50);

/**
 * `slug` on create: the shared slug rules plus the reserved-word check.
 * See RESERVED_COURSE_SLUGS - "manage" would shadow GET /courses/manage.
 */
const creatableSlugSchema = courseSlugSchema.refine(
  (slug) => !(RESERVED_COURSE_SLUGS as readonly string[]).includes(slug),
  { message: "This slug is reserved and cannot be used for a course" },
);

/**
 * Course metadata fields shared by create and update.
 *
 * Deliberately ABSENT, so they are stripped if a client sends them:
 *   - `status`, `isPublished` - change only through the status / publish
 *     endpoints, where the server derives one from the other.
 *   - `modules`               - replaced only through PUT .../curriculum.
 *   - `id`                    - assigned by the database (Q1).
 * Unknown keys are stripped, not rejected, matching every other schema in
 * the codebase.
 */
const courseMetadataFields = {
  // Q2: courseCode generation is undecided. Accepted as supplied, exactly
  // as the frontend's admin form does today; nothing is generated here.
  courseCode: blankAsAbsent(text(50)),
  title: text(200),
  shortDescription: text(500),
  longDescription: text(10_000),
  thumbnailUrl: httpUrl,
  durationWeeks: z.number().int().positive(),
  totalHours: z.number().int().positive(),
  feeINR: wholeInr,
  discountedFeeINR: wholeInr.optional(),
  level: z.enum(COURSE_LEVELS),
  category: z.enum(COURSE_CATEGORIES),
  technologies: textList(60),
  hasPlacementGuarantee: z.boolean(),
  prerequisites: textList(300),
  learningOutcomes: textList(300),
  eligibilityCriteria: textList(300).optional(),
  syllabusPdfUrl: blankAsAbsent(httpUrl),
};

/** `POST /courses` body. A new course is always a Draft (see service). */
/**
 * Create body. Fields with no NXA_Courses column (see UNPERSISTED_COURSE_FIELDS)
 * are optional: the SQL Server adapter rejects them until a schema change
 * makes them storable, so a client must be able to create a course without
 * them.
 */
export const createCourseBodySchema = z.object({
  slug: creatableSlugSchema,
  ...courseMetadataFields,
  thumbnailUrl: courseMetadataFields.thumbnailUrl.optional(),
  totalHours: courseMetadataFields.totalHours.optional(),
  category: courseMetadataFields.category.optional(),
  technologies: courseMetadataFields.technologies.optional(),
  hasPlacementGuarantee: courseMetadataFields.hasPlacementGuarantee.optional(),
  prerequisites: courseMetadataFields.prerequisites.optional(),
  learningOutcomes: courseMetadataFields.learningOutcomes.optional(),
});

export type CreateCourseBody = z.infer<typeof createCourseBodySchema>;

/**
 * `PATCH /courses/:courseId` body - every metadata field optional.
 *
 * `slug` is not patchable: `UpdateCourseInput` excludes it, because public
 * URLs and bookmarks depend on it. An optional field cannot be CLEARED
 * here (JSON has no `undefined`), a known limitation pending a decision.
 */
export const updateCourseBodySchema = z.object(courseMetadataFields).partial();

export type UpdateCourseBody = z.infer<typeof updateCourseBodySchema>;

/** `:courseId` path param for management routes. */
export const courseIdParamsSchema = z.object({
  courseId: entityIdSchema,
});

export type CourseIdParams = z.infer<typeof courseIdParamsSchema>;

/** `PATCH /courses/:courseId/status` body. Includes `Archived` (archive). */
export const courseStatusBodySchema = z.object({
  status: z.enum(COURSE_STATUSES),
});

export type CourseStatusBody = z.infer<typeof courseStatusBodySchema>;

/**
 * `GET /courses/manage` query: the shared list contract plus filters. Unlike
 * the public list, `status` IS a filter here - drafts are the point.
 */
export const manageCourseListQuerySchema = listQuerySchema.extend({
  category: z.enum(COURSE_CATEGORIES).optional(),
  level: z.enum(COURSE_LEVELS).optional(),
  status: z.enum(COURSE_STATUSES).optional(),
  hasPlacementGuarantee: queryBoolean.optional(),
});

export type ManageCourseListQuery = z.infer<typeof manageCourseListQuerySchema>;

// --- curriculum tree --------------------------------------------------------
//
// Ids are CLIENT-SUPPLIED, exactly as the frontend's syllabus editor
// generates them today. Changing who generates them is open-questions Q1
// and is deliberately not done here.

const lessonSchema = z.object({
  id: entityIdSchema,
  chapterId: entityIdSchema,
  title: text(200),
  durationMinutes: z.number().int().nonnegative(),
  lessonType: z.enum(LESSON_TYPES).optional(),
  // NXA_Lessons.ExternalUrl is nvarchar(1000).
  videoUrl: blankAsAbsent(httpUrl.max(1000)),
  pdfUrl: blankAsAbsent(httpUrl),
  // Blank -> absent, like videoUrl/pdfUrl: the syllabus editor always sends
  // a string, "" when empty. Non-blank text is kept verbatim (NOT trimmed),
  // since leading whitespace can be meaningful in study material.
  studyMaterialText: blankAsAbsent(z.string().max(50_000)),
  externalLinks: z.array(z.object({ title: text(200), url: httpUrl })).max(20).optional(),
  isFreePreview: z.boolean(),
  order: z.number().int().nonnegative(),
  isLocked: z.boolean().optional(),
  isDownloadRestricted: z.boolean().optional(),
  // LMS-004 / LMS-005 (NXA_Lessons.IsSequentialUnlock / PublishAt). publishAt is an absolute
  // instant with its UTC offset, so no time-zone rule is needed; null / absent = available now.
  isSequentialUnlock: z.boolean().optional(),
  publishAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const chapterSchema = z.object({
  id: entityIdSchema,
  moduleId: entityIdSchema,
  title: text(200),
  // NXA_Chapters.Description is nvarchar(1000).
  description: blankAsAbsent(z.string().trim().max(1000)),
  order: z.number().int().nonnegative(),
  lessons: z.array(lessonSchema).max(200),
});

const moduleSchema = z.object({
  id: entityIdSchema,
  courseId: entityIdSchema,
  title: text(200),
  // Required by the frontend type but may legitimately be empty.
  // NXA_CourseModules.ModuleDescription is nvarchar(1000).
  description: z.string().trim().max(1000),
  order: z.number().int().nonnegative(),
  chapters: z.array(chapterSchema).max(100),
});

/**
 * `PUT /courses/:courseId/curriculum` body: the WHOLE tree (a replace).
 *
 * Wrapped as `{ modules }` rather than a bare array so the body can later
 * carry a concurrency token without a breaking change (open-questions Q24).
 */
export const curriculumBodySchema = z.object({
  modules: z.array(moduleSchema).max(100),
});

export type CurriculumBody = z.infer<typeof curriculumBodySchema>;

/**
 * `PUT /courses/:courseId/prerequisites` body: the WHOLE prerequisite set
 * (a replace). Prerequisites are other courses (NXA_CoursePrerequisites).
 */
export const prerequisitesBodySchema = z.object({
  prerequisiteCourseIds: z
    .array(entityIdSchema)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: "Each prerequisite course may be listed once" }),
});

export type PrerequisitesBody = z.infer<typeof prerequisitesBodySchema>;
export type CurriculumModuleBody = CurriculumBody["modules"][number];
