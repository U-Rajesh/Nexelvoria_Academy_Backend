import type { SortOrder } from "../../contracts/api.contract";
import type { EntityId, Slug } from "../../contracts/identifier.contract";

/**
 * The `courses` domain, including the curriculum tree.
 *
 * CONFIRMED - every field is copied from the frontend's
 * `src/types/course.types.ts`. The four-level nesting
 * (Course > CourseModule > Chapter > Lesson) is the frontend's existing
 * model, not a new design.
 *
 * How that tree is stored - four tables, or JSON in one column - is
 * explicitly the database team's decision and a question in the handoff
 * document. These types describe the API shape only.
 */

export const LESSON_TYPES = ["video", "reading", "pdf", "assignment", "quiz"] as const;
export type LessonType = (typeof LESSON_TYPES)[number];

export interface ExternalLink {
  title: string;
  url: string;
}

export interface Lesson {
  id: EntityId;
  chapterId: EntityId;
  title: string;
  durationMinutes: number;
  lessonType?: LessonType;
  videoUrl?: string;
  pdfUrl?: string;
  studyMaterialText?: string;
  externalLinks?: ExternalLink[];
  /** Accessible before payment (BR-003). */
  isFreePreview: boolean;
  order: number;
  isLocked?: boolean;
  /** Download permission control. */
  isDownloadRestricted?: boolean;
  /** LMS-004: opens only after the previous lesson (course order) is completed. */
  isSequentialUnlock?: boolean;
  /** LMS-005: ISO instant before which students cannot open the lesson (NXA_Lessons.PublishAt). */
  publishAt?: string;
  /** NXA_Lessons.Status = PUBLISHED. Absent is treated as published. */
  isPublished?: boolean;
}

export interface Chapter {
  id: EntityId;
  moduleId: EntityId;
  title: string;
  description?: string;
  order: number;
  lessons: Lesson[];
}

export interface CourseModule {
  id: EntityId;
  courseId: EntityId;
  title: string;
  description: string;
  order: number;
  chapters: Chapter[];
}

/**
 * The closed value sets below are `as const` arrays so the zod schemas in
 * course.validation.ts derive from the SAME list as the types - one source,
 * no drift. The resulting unions are identical to the frontend's.
 */
export const COURSE_STATUSES = ["Draft", "Published", "Active", "Inactive", "Archived"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

/**
 * Statuses under which a course may appear on the anonymous catalogue.
 *
 * Source: the frontend's public `CoursesPage` ("Only Published or Active
 * courses are visible to the public (excludes Draft, Inactive, and
 * Archived)") and `adminService.updateCourseStatus`, which keeps
 * `isPublished === (status is Published or Active)`.
 */
export const PUBLIC_COURSE_STATUSES = ["Published", "Active"] as const satisfies readonly CourseStatus[];

/**
 * Slugs no course may take, because they collide with a static path under
 * `/courses`. `GET /courses/manage` is registered before `GET /courses/:slug`,
 * so a course slugged "manage" could never be reached publicly.
 */
export const RESERVED_COURSE_SLUGS = ["manage"] as const;

export const COURSE_LEVELS =["Beginner", "Intermediate", "Advanced"] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];

export const COURSE_CATEGORIES = [
  "Software Development",
  "Data & AI",
  "Cloud & DevOps",
  "Cybersecurity",
  "Testing",
] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number];

export interface Course {
  id: EntityId;
  slug: Slug;
  courseCode?: string;
  title: string;
  shortDescription: string;
  longDescription: string;
  /** No NXA_Courses column: absent when read from SQL Server (never an invented path). */
  thumbnailUrl?: string | undefined;
  durationWeeks: number;
  /** No column: absent when read from SQL Server (never derived from weeks). */
  totalHours?: number | undefined;
  /** Fee in whole INR. Never a float - see handoff on money types. */
  feeINR: number;
  discountedFeeINR?: number;
  level: CourseLevel;
  /** No column: absent when read from SQL Server (never a default category). */
  category?: CourseCategory | undefined;
  technologies: string[];
  modules: CourseModule[];
  isPublished: boolean;
  status?: CourseStatus;
  /** Terms are legally unexecuted - open-questions Q7. */
  hasPlacementGuarantee: boolean;
  prerequisites: string[];
  learningOutcomes: string[];
  eligibilityCriteria?: string[];
  syllabusPdfUrl?: string;
}

/** Filters for the public catalogue and the management list. */
export interface CourseFilter {
  category?: CourseCategory;
  level?: CourseLevel;
  status?: CourseStatus;
  /**
   * Restricts to published courses. The public catalogue MUST set this -
   * see api-contracts section 7 on keeping draft content out of the
   * anonymous endpoint.
   */
  publishedOnly?: boolean;
  hasPlacementGuarantee?: boolean;
  /** Free-text across title, shortDescription and technologies. */
  search?: string;
}

/**
 * Sortable course fields - the allow-list every `sortBy` value is checked
 * against (api-contracts sections 3.6 / 3.8) before reaching a repository.
 *
 * Only plain scalar columns: cheap to index, unambiguous under SQL Server
 * collation. `Course` has no `createdAt`, so "newest first" is not offered.
 */
export const COURSE_SORT_FIELDS = ["title", "feeINR", "durationWeeks", "totalHours"] as const;
export type CourseSortField = (typeof COURSE_SORT_FIELDS)[number];

/**
 * Sort instruction passed to `CourseRepository.findMany`.
 *
 * Adapters must append a unique tiebreaker (the id) so OFFSET/FETCH paging
 * is stable - database-handoff Q-I1.
 */
export interface CourseSort {
  field: CourseSortField;
  order: SortOrder;
}

/**
 * Content fields that are NEVER part of the public projection, even for a
 * free-preview lesson, until separately approved by the lead.
 */
export type RestrictedLessonContent = "pdfUrl" | "studyMaterialText" | "externalLinks";

/**
 * Public projection of a lesson.
 *
 * Approved rule (Developer 1, Step 1 review): anonymous callers receive
 * `videoUrl` ONLY for lessons explicitly marked `isFreePreview` (BR-003).
 * Every other lesson shows its outline - title, duration, order - and no
 * content. PDF URLs, study material and external links are never exposed
 * publicly, which this type enforces at compile time.
 *
 * Still assignable to the frontend's `Lesson`, where all content fields are
 * optional. The frontend's `CourseDetailPage` only reads `videoUrl`.
 */
export type PublicLesson = Omit<Lesson, RestrictedLessonContent>;

export interface PublicChapter extends Omit<Chapter, "lessons"> {
  lessons: PublicLesson[];
}

export interface PublicCourseModule extends Omit<CourseModule, "chapters"> {
  chapters: PublicChapter[];
}

/**
 * What the anonymous catalogue returns.
 *
 * `status` is omitted: the internal lifecycle (Published vs Active) is not
 * public, and every course returned here is publicly visible by definition.
 * `isPublished` is therefore always `true`. Still assignable to the
 * frontend's `Course` type, whose `status` is optional.
 */
export interface PublicCourse extends Omit<Course, "status" | "modules"> {
  modules: PublicCourseModule[];
}

/** Filters accepted by the public catalogue. A strict subset of CourseFilter. */
export type PublicCourseFilter = Pick<
  CourseFilter,
  "category" | "level" | "hasPlacementGuarantee" | "search"
>;

/** Fields accepted when creating a course. Curriculum is set separately. */
/**
 * Course fields with no column in the live NXA_Courses table. The SQL Server
 * adapter rejects them (UnsupportedFieldsError) instead of silently dropping
 * them; they become storable only after an approved schema change.
 */
export const UNPERSISTED_COURSE_FIELDS = [
  "thumbnailUrl",
  "totalHours",
  "discountedFeeINR",
  "category",
  "technologies",
  "hasPlacementGuarantee",
  "prerequisites",
  "learningOutcomes",
  "eligibilityCriteria",
  "syllabusPdfUrl",
] as const;

export type UnpersistedCourseField = (typeof UNPERSISTED_COURSE_FIELDS)[number];

export type CreateCourseInput = Omit<Course, "id" | "modules" | "isPublished" | "status" | UnpersistedCourseField> &
  Partial<Pick<Course, UnpersistedCourseField>>;

/** Patchable course metadata. Curriculum has its own replace operation. */
export type UpdateCourseInput = Partial<Omit<Course, "id" | "modules" | "slug">>;
