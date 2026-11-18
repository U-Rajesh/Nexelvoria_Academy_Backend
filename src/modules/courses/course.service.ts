import type { FieldIssue, PaginatedResult } from "../../contracts/api.contract";
import { toPaginatedResult } from "../../contracts/api.contract";
import type { EntityId, Slug } from "../../contracts/identifier.contract";
import { resolveSortField } from "../../middleware/validate.middleware";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import { logger } from "../../utils/logger";
import type { CourseRepository } from "./course.repository";
import {
  COURSE_SORT_FIELDS,
  PUBLIC_COURSE_STATUSES,
  RESERVED_COURSE_SLUGS,
  type CourseSort,
  type CourseStatus,
  type Chapter,
  type Course,
  type CourseModule,
  type CreateCourseInput,
  type Lesson,
  type PublicChapter,
  type PublicCourse,
  type PublicCourseModule,
  type PublicLesson,
  type UpdateCourseInput,
} from "./course.types";
import {
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  type CreateCourseBody,
  type CurriculumModuleBody,
  type ManageCourseListQuery,
  type PublicCourseListQuery,
  type UpdateCourseBody,
} from "./course.validation";

/**
 * Business logic for the `courses` module.
 *
 * Step 1: the PUBLIC catalogue. Management operations arrive in Step 2.
 *
 * No `express` import and no `req`/`res` - this is callable from a test,
 * a job or a CLI. See docs/architecture.md section 4.
 */

export interface CourseServiceDeps {
  courses: CourseRepository;
}

/**
 * Single public-visibility rule, used by every public read.
 *
 * A course is public only when BOTH hold:
 *   1. `isPublished === true` - the flag the repository's `publishedOnly`
 *      filter gates on, and
 *   2. its `status` (when present) is `Published` or `Active`.
 *
 * The frontend maintains (1) <=> (2), so normally they agree. Checking both
 * is defence in depth: if a write path ever breaks the invariant (say,
 * `Archived` with `isPublished` left `true`), the course stays hidden. The
 * failure mode of disagreement is "hidden", never "leaked".
 */
export const isPubliclyVisible = (course: Course): boolean => {
  if (course.isPublished !== true) {
    return false;
  }

  if (course.status === undefined) {
    return true;
  }

  return (PUBLIC_COURSE_STATUSES as readonly string[]).includes(course.status);
};

const byOrder = <T extends { order: number }>(a: T, b: T): number => a.order - b.order;

/**
 * Lesson projection - an explicit WHITELIST, not a blacklist.
 *
 * Building the object field by field means a column added to `Lesson`
 * later (an internal note, a signed storage key) is NOT exposed until
 * someone deliberately adds it here. Deleting known-sensitive fields would
 * fail open instead.
 */
const toPublicLesson = (lesson: Lesson): PublicLesson => {
  // Strict `=== true`, so a missing or garbled flag (e.g. the string
  // "true" from a faulty adapter) fails closed - and the value we emit is
  // always a real boolean, matching the frontend's `isFreePreview: boolean`.
  const isFreePreview = lesson.isFreePreview === true;

  const outline: PublicLesson = {
    id: lesson.id,
    chapterId: lesson.chapterId,
    title: lesson.title,
    durationMinutes: lesson.durationMinutes,
    isFreePreview,
    order: lesson.order,
    ...(lesson.lessonType === undefined ? {} : { lessonType: lesson.lessonType }),
    ...(lesson.isLocked === undefined ? {} : { isLocked: lesson.isLocked }),
    ...(lesson.isDownloadRestricted === undefined
      ? {}
      : { isDownloadRestricted: lesson.isDownloadRestricted }),
  };

  // BR-003, as approved by the lead at the Step 1 review: anonymous callers
  // get `videoUrl` ONLY, and only for lessons explicitly marked free
  // preview. `pdfUrl`, `studyMaterialText` and `externalLinks` are never
  // public until separately approved - `PublicLesson` omits them, so adding
  // one here would not compile.
  if (!isFreePreview || lesson.videoUrl === undefined) {
    return outline;
  }

  return { ...outline, videoUrl: lesson.videoUrl };
};

const toPublicChapter = (chapter: Chapter): PublicChapter => ({
  id: chapter.id,
  moduleId: chapter.moduleId,
  title: chapter.title,
  order: chapter.order,
  ...(chapter.description === undefined ? {} : { description: chapter.description }),
  // Sorted here because a SQL adapter returns child rows in no guaranteed
  // order; the outline must render in curriculum order regardless.
  lessons: [...chapter.lessons].sort(byOrder).map(toPublicLesson),
});

const toPublicModule = (module: CourseModule): PublicCourseModule => ({
  id: module.id,
  courseId: module.courseId,
  title: module.title,
  description: module.description,
  order: module.order,
  chapters: [...module.chapters].sort(byOrder).map(toPublicChapter),
});

/** Course projection - also a whitelist. `status` is deliberately absent. */
export const toPublicCourse = (course: Course): PublicCourse => ({
  id: course.id,
  slug: course.slug,
  title: course.title,
  shortDescription: course.shortDescription,
  longDescription: course.longDescription,
  thumbnailUrl: course.thumbnailUrl,
  durationWeeks: course.durationWeeks,
  totalHours: course.totalHours,
  feeINR: course.feeINR,
  level: course.level,
  category: course.category,
  technologies: [...course.technologies],
  isPublished: true,
  hasPlacementGuarantee: course.hasPlacementGuarantee,
  prerequisites: [...course.prerequisites],
  learningOutcomes: [...course.learningOutcomes],
  ...(course.courseCode === undefined ? {} : { courseCode: course.courseCode }),
  ...(course.discountedFeeINR === undefined ? {} : { discountedFeeINR: course.discountedFeeINR }),
  ...(course.eligibilityCriteria === undefined
    ? {}
    : { eligibilityCriteria: [...course.eligibilityCriteria] }),
  ...(course.syllabusPdfUrl === undefined ? {} : { syllabusPdfUrl: course.syllabusPdfUrl }),
  modules: [...course.modules].sort(byOrder).map(toPublicModule),
});

// ===========================================================================
// Management helpers (Step 2A)
// ===========================================================================

/**
 * THE publication rule: `isPublished` is derived from `status`, never
 * supplied by a client. Mirrors the frontend's
 * `adminService.updateCourseStatus`:
 *   isPublished = status === 'Published' || status === 'Active'
 */
export const isPublishedForStatus = (status: CourseStatus): boolean =>
  (PUBLIC_COURSE_STATUSES as readonly CourseStatus[]).includes(status);

/**
 * Translates repository (domain) errors into HTTP errors - the mapping
 * prescribed in repositories/repository.errors.ts. Anything else is
 * rethrown untouched and becomes a 500 in the error middleware.
 */
const rethrowAsApiError = (err: unknown): never => {
  if (err instanceof RecordNotFoundError) {
    throw ApiError.notFound("Course not found");
  }

  if (err instanceof DuplicateRecordError) {
    throw ApiError.conflict(`A course with this ${err.field} already exists`);
  }

  throw err;
};

/**
 * Service-level slug normalisation - the same rules as `courseSlugSchema`
 * (trim, lowercase per open-questions Q17, then the pattern and length
 * check), plus a CASE-INSENSITIVE reserved-slug check. Uses the schema's
 * own `SLUG_PATTERN` / `SLUG_MAX_LENGTH`, so the two cannot drift.
 */
const normaliseSlug = (raw: string): Slug => {
  const slug = raw.trim().toLowerCase();

  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw ApiError.validation([
      { field: "slug", message: "Slug may contain only lowercase letters, digits and single hyphens" },
    ]);
  }

  // `slug` is already lowercase, so this comparison is case-insensitive.
  if ((RESERVED_COURSE_SLUGS as readonly string[]).includes(slug)) {
    throw ApiError.validation([
      { field: "slug", message: "This slug is reserved and cannot be used for a course" },
    ]);
  }

  return slug;
};

/** Drops `undefined` values so `exactOptionalPropertyTypes` holds. */
const definedOnly = <T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Builds the repository input field by field (a whitelist, as with the
 * public projection), so nothing outside `CreateCourseInput` can be passed
 * through - in particular no `status`, `isPublished` or `modules`.
 */
const toCreateCourseInput = (body: CreateCourseBody): CreateCourseInput => ({
  slug: body.slug,
  title: body.title,
  shortDescription: body.shortDescription,
  longDescription: body.longDescription,
  thumbnailUrl: body.thumbnailUrl,
  durationWeeks: body.durationWeeks,
  totalHours: body.totalHours,
  feeINR: body.feeINR,
  level: body.level,
  category: body.category,
  technologies: body.technologies,
  hasPlacementGuarantee: body.hasPlacementGuarantee,
  prerequisites: body.prerequisites,
  learningOutcomes: body.learningOutcomes,
  ...(body.courseCode === undefined ? {} : { courseCode: body.courseCode }),
  ...(body.discountedFeeINR === undefined ? {} : { discountedFeeINR: body.discountedFeeINR }),
  ...(body.eligibilityCriteria === undefined
    ? {}
    : { eligibilityCriteria: body.eligibilityCriteria }),
  ...(body.syllabusPdfUrl === undefined ? {} : { syllabusPdfUrl: body.syllabusPdfUrl }),
});

/**
 * Structural integrity of a curriculum tree - NOT a business rule.
 *
 * The tree is client-built (Q1), so the server checks it is internally
 * consistent before replacing the stored one:
 *   - every module belongs to THIS course (`courseId` matches the path);
 *   - every chapter/lesson points at its actual parent;
 *   - ids are unique within their level, because enrolment progress and
 *     bookmarks reference lessons by id (`findLessonById`).
 * Violations are reported as 422 field issues with exact paths.
 */
const checkCurriculumIntegrity = (courseId: EntityId, modules: CurriculumModuleBody[]): void => {
  const issues: FieldIssue[] = [];
  const seen = { module: new Set<string>(), chapter: new Set<string>(), lesson: new Set<string>() };

  const unique = (kind: keyof typeof seen, id: string, field: string): void => {
    if (seen[kind].has(id)) {
      issues.push({ field, message: `Duplicate ${kind} id "${id}"` });
    }
    seen[kind].add(id);
  };

  modules.forEach((mod, m) => {
    const mPath = `modules.${m}`;
    unique("module", mod.id, `${mPath}.id`);

    if (mod.courseId !== courseId) {
      issues.push({ field: `${mPath}.courseId`, message: "Must match the course being updated" });
    }

    mod.chapters.forEach((chapter, c) => {
      const cPath = `${mPath}.chapters.${c}`;
      unique("chapter", chapter.id, `${cPath}.id`);

      if (chapter.moduleId !== mod.id) {
        issues.push({ field: `${cPath}.moduleId`, message: "Must match its parent module id" });
      }

      chapter.lessons.forEach((lesson, l) => {
        const lPath = `${cPath}.lessons.${l}`;
        unique("lesson", lesson.id, `${lPath}.id`);

        if (lesson.chapterId !== chapter.id) {
          issues.push({ field: `${lPath}.chapterId`, message: "Must match its parent chapter id" });
        }
      });
    });
  });

  if (issues.length > 0) {
    throw ApiError.validation(issues, "Curriculum is not internally consistent");
  }
};

/** Explicit tree builder - a whitelist, dropping `undefined` optionals. */
const toCourseModules = (modules: CurriculumModuleBody[]): CourseModule[] =>
  modules.map((mod) => ({
    id: mod.id,
    courseId: mod.courseId,
    title: mod.title,
    description: mod.description,
    order: mod.order,
    chapters: mod.chapters.map((chapter) => ({
      id: chapter.id,
      moduleId: chapter.moduleId,
      title: chapter.title,
      order: chapter.order,
      ...(chapter.description === undefined ? {} : { description: chapter.description }),
      lessons: chapter.lessons.map(
        (lesson): Lesson => ({
          id: lesson.id,
          chapterId: lesson.chapterId,
          title: lesson.title,
          durationMinutes: lesson.durationMinutes,
          isFreePreview: lesson.isFreePreview,
          order: lesson.order,
          ...definedOnly({
            lessonType: lesson.lessonType,
            videoUrl: lesson.videoUrl,
            pdfUrl: lesson.pdfUrl,
            studyMaterialText: lesson.studyMaterialText,
            externalLinks: lesson.externalLinks,
            isLocked: lesson.isLocked,
            isDownloadRestricted: lesson.isDownloadRestricted,
          }),
        }),
      ),
    })),
  }));

/**
 * The ONLY shape a course leaves the MANAGEMENT endpoints in - an explicit
 * WHITELIST of the contract's `Course` fields (api-contracts section 7;
 * frontend `src/types/course.types.ts`).
 *
 * TypeScript types do not strip properties at runtime, so returning the
 * repository object would forward whatever an adapter maps (an internal
 * column, an audit field, a row version). Building the response field by
 * field drops anything not listed here until someone deliberately adds it.
 *
 * Unlike `toPublicCourse` this is the ADMIN view: it keeps `status` and the
 * full curriculum, including paid lesson content, which admins edit. The
 * curriculum reuses `toCourseModules`, the existing explicit tree builder.
 */
export const toAdminCourse = (course: Course): Course => ({
  id: course.id,
  slug: course.slug,
  title: course.title,
  shortDescription: course.shortDescription,
  longDescription: course.longDescription,
  thumbnailUrl: course.thumbnailUrl,
  durationWeeks: course.durationWeeks,
  totalHours: course.totalHours,
  feeINR: course.feeINR,
  level: course.level,
  category: course.category,
  technologies: [...course.technologies],
  isPublished: course.isPublished,
  hasPlacementGuarantee: course.hasPlacementGuarantee,
  prerequisites: [...course.prerequisites],
  learningOutcomes: [...course.learningOutcomes],
  ...(course.status === undefined ? {} : { status: course.status }),
  ...(course.courseCode === undefined ? {} : { courseCode: course.courseCode }),
  ...(course.discountedFeeINR === undefined ? {} : { discountedFeeINR: course.discountedFeeINR }),
  ...(course.eligibilityCriteria === undefined
    ? {}
    : { eligibilityCriteria: [...course.eligibilityCriteria] }),
  ...(course.syllabusPdfUrl === undefined ? {} : { syllabusPdfUrl: course.syllabusPdfUrl }),
  modules: toCourseModules(course.modules),
});

/**
 * Builds the course service.
 *
 * IMPORTANT - `deps.courses` is read lazily, inside each method, never
 * destructured here. The production container has no adapter yet, and
 * resolving one throws `RepositoryNotConfiguredError`. Reading it at
 * construction would stop the whole app booting (taking /health down with
 * it); reading it per call confines the failure to the course endpoints.
 */
export const createCourseService = (deps: CourseServiceDeps) => ({
  /**
   * `GET /courses` - the anonymous catalogue, published courses only.
   *
   * `publishedOnly: true` is hard-coded here, not taken from the caller,
   * so no query string can widen visibility.
   */
  async listPublishedCourses(query: PublicCourseListQuery): Promise<PaginatedResult<PublicCourse>> {
    // api-contracts 3.8: a client string never reaches the repository. An
    // unknown or hostile `sortBy` resolves to undefined -> default order.
    const sortField = resolveSortField(query.sortBy, COURSE_SORT_FIELDS);
    const sort: CourseSort | undefined =
      sortField === undefined ? undefined : { field: sortField, order: query.sortOrder };

    const result = await deps.courses.findMany(
      {
        publishedOnly: true,
        ...(query.category === undefined ? {} : { category: query.category }),
        ...(query.level === undefined ? {} : { level: query.level }),
        ...(query.hasPlacementGuarantee === undefined
          ? {}
          : { hasPlacementGuarantee: query.hasPlacementGuarantee }),
        ...(query.search === undefined ? {} : { search: query.search }),
      },
      { page: query.page, pageSize: query.pageSize },
      sort,
    );

    // Defence in depth over the repository filter (see isPubliclyVisible).
    // `total` is left as the repository reported it: a mismatch can only
    // arise from corrupt data, and is logged so it gets fixed at source.
    const visible = result.items.filter(isPubliclyVisible);

    if (visible.length !== result.items.length) {
      logger.warn("courses: repository returned non-public rows to the public catalogue", {
        dropped: result.items.length - visible.length,
      });
    }

    return toPaginatedResult(visible.map(toPublicCourse), result.total, {
      page: result.page,
      pageSize: result.pageSize,
    });
  },

  /**
   * `GET /courses/:slug` - one published course.
   *
   * Missing and unpublished are indistinguishable on purpose: both are 404
   * with the same message, so the endpoint cannot be used to discover
   * draft slugs (api-contracts section 3.11, "404 not 403").
   */
  async getPublishedCourseBySlug(slug: Slug): Promise<PublicCourse> {
    const course = await deps.courses.findBySlug(slug);

    if (course === null || !isPubliclyVisible(course)) {
      throw ApiError.notFound("Course not found");
    }

    return toPublicCourse(course);
  },

  // =========================================================================
  // Management (Step 2A) - admin-only, api-contracts section 7 #3-#9.
  //
  // Deferred, deliberately NOT implemented here (do not add ad hoc):
  //   - Audit trail: every mutation below should record an AuditLogEntry
  //     through the shared audit service api-contracts section 15
  //     recommends. That service does not exist yet, so there is no
  //     per-module substitute.
  //   - Teacher access to allocated courses (api-contracts 7, rows marked *):
  //     needs the identity contract + allocation lookup.
  //   - Status-transition restrictions: none are documented, so any status
  //     may follow any other, matching the frontend.
  // =========================================================================

  /** `GET /courses/manage` - every course, drafts included. */
  async listCourses(query: ManageCourseListQuery): Promise<PaginatedResult<Course>> {
    const sortField = resolveSortField(query.sortBy, COURSE_SORT_FIELDS);

    const result = await deps.courses.findMany(
      definedOnly({
        category: query.category,
        level: query.level,
        status: query.status,
        hasPlacementGuarantee: query.hasPlacementGuarantee,
        search: query.search,
      }),
      { page: query.page, pageSize: query.pageSize },
      sortField === undefined ? undefined : { field: sortField, order: query.sortOrder },
    );

    // Built field by field - never the adapter's page object, which could
    // carry extra properties. Items are whitelisted by `toAdminCourse`.
    return toPaginatedResult(result.items.map(toAdminCourse), result.total, {
      page: result.page,
      pageSize: result.pageSize,
    });
  },

  /** `GET /courses/manage/:courseId` - full course for editing. */
  async getCourseById(id: EntityId): Promise<Course> {
    const course = await deps.courses.findById(id);

    if (course === null) {
      throw ApiError.notFound("Course not found");
    }

    return toAdminCourse(course);
  },

  /**
   * `POST /courses` - create.
   *
   * Always created as a Draft, unpublished, with an empty curriculum: that
   * is the `CourseRepository.create` contract (`CreateCourseInput` has no
   * status, publish flag or modules). Publishing is a separate, explicit
   * step through the status / publish endpoints.
   */
  async createCourse(body: CreateCourseBody): Promise<Course> {
    // The HTTP schema already normalises and checks the slug. The service
    // repeats it because it must be safe when called WITHOUT HTTP
    // validation (a job, a script): otherwise `"Manage"` would bypass the
    // reserved check and create a course that GET /courses/manage shadows
    // (Express route matching is case-insensitive).
    const slug = normaliseSlug(body.slug);

    // Q2: no courseCode is generated - it is stored as supplied, or absent.
    return toAdminCourse(
      await deps.courses.create(toCreateCourseInput({ ...body, slug })).catch(rethrowAsApiError),
    );
  },

  /**
   * `PATCH /courses/:courseId` - metadata only.
   *
   * Cannot change `status`, `isPublished`, `modules` or `slug`.
   *
   * Precisely why: the request type `UpdateCourseBody` has none of these
   * fields, but the repository's `UpdateCourseInput` DOES still allow
   * `status` and `isPublished` (it is `Partial<Omit<Course, "id" |
   * "modules" | "slug">>`). So the type system alone does not protect the
   * status/visibility invariant here - the explicit whitelist below does.
   * Keep it a whitelist; never pass `body` through directly.
   */
  async updateCourse(id: EntityId, body: UpdateCourseBody): Promise<Course> {
    // Explicit whitelist, not `definedOnly(body)`: the service must stay
    // safe when called without the HTTP schema, so even a caller passing
    // `status`/`isPublished`/`modules`/`slug` cannot get them through.
    const input: UpdateCourseInput = definedOnly({
      courseCode: body.courseCode,
      title: body.title,
      shortDescription: body.shortDescription,
      longDescription: body.longDescription,
      thumbnailUrl: body.thumbnailUrl,
      durationWeeks: body.durationWeeks,
      totalHours: body.totalHours,
      feeINR: body.feeINR,
      discountedFeeINR: body.discountedFeeINR,
      level: body.level,
      category: body.category,
      technologies: body.technologies,
      hasPlacementGuarantee: body.hasPlacementGuarantee,
      prerequisites: body.prerequisites,
      learningOutcomes: body.learningOutcomes,
      eligibilityCriteria: body.eligibilityCriteria,
      syllabusPdfUrl: body.syllabusPdfUrl,
    });

    return toAdminCourse(await deps.courses.update(id, input).catch(rethrowAsApiError));
  },

  /**
   * `PUT /courses/:courseId/curriculum` - replace the whole tree.
   *
   * Q24: LAST WRITE WINS. Two editors saving the same curriculum will
   * silently overwrite each other until optimistic concurrency is decided.
   * The body is `{ modules }` so a version token can be added later.
   */
  async replaceCurriculum(id: EntityId, modules: CurriculumModuleBody[]): Promise<Course> {
    checkCurriculumIntegrity(id, modules);
    return toAdminCourse(
      await deps.courses.replaceCurriculum(id, toCourseModules(modules)).catch(rethrowAsApiError),
    );
  },

  /**
   * `PATCH /courses/:courseId/status` - set the lifecycle status, which
   * also covers archiving (`Archived`).
   *
   * `isPublished` is DERIVED here and written in the same single
   * `setPublication` call, so status and visibility cannot disagree.
   */
  async setCourseStatus(id: EntityId, status: CourseStatus): Promise<Course> {
    return toAdminCourse(
      await deps.courses
        .setPublication(id, { status, isPublished: isPublishedForStatus(status) })
        .catch(rethrowAsApiError),
    );
  },

  /**
   * `PATCH /courses/:courseId/publish` - toggle visibility.
   *
   * A server-side toggle mirroring `adminService.toggleCoursePublish`:
   * published -> `Draft`, unpublished -> `Published`. No client-supplied
   * `isPublished` is read at all; any body is ignored.
   *
   * Known limitations, both inherited from the contract's "toggle" design:
   * a retried request flips twice, and the read-then-write is not guarded
   * against a concurrent change (Q24). Unpublishing an `Active` course
   * lands on `Draft`, exactly as the frontend does.
   */
  async togglePublish(id: EntityId): Promise<Course> {
    const course = await deps.courses.findById(id);

    if (course === null) {
      throw ApiError.notFound("Course not found");
    }

    const status: CourseStatus = course.isPublished ? "Draft" : "Published";

    return toAdminCourse(
      await deps.courses
        .setPublication(id, { status, isPublished: isPublishedForStatus(status) })
        .catch(rethrowAsApiError),
    );
  },
});

export type CourseService = ReturnType<typeof createCourseService>;
