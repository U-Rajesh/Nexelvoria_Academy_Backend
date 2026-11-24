import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { TransactionalAuditEntry } from "../../contracts/audit.contract";
import type { EntityId, Slug } from "../../contracts/identifier.contract";
import type {
  Course,
  CourseFilter,
  CourseModule,
  CourseSort,
  CourseStatus,
  CreateCourseInput,
  UpdateCourseInput,
} from "./course.types";
import type { PrerequisiteCourse } from "./course-prerequisites";

/**
 * A course-management audit entry (COURSE_MGMT / Course, entity id = course
 * id), written by the repository in the same transaction as the change. Not
 * written for a no-op.
 */
export type CourseAudit = TransactionalAuditEntry;
/** An audit entry whose text depends on what the transaction stored. */
export type CourseAuditFor<T> = (stored: T) => CourseAudit;

/**
 * The `courses` repository PORT. Interface only - no SQL, no driver.
 *
 * Maps to docs/api-contracts.md section 7.
 */
export interface CourseRepository {
  findById(id: EntityId): Promise<Course | null>;

  /**
   * Public course detail is addressed by slug, matching the frontend
   * route `/courses/:courseSlug`.
   */
  findBySlug(slug: Slug): Promise<Course | null>;

  /** True when the slug is taken. Slugs are unique and case-insensitive. */
  existsBySlug(slug: Slug): Promise<boolean>;

  /**
   * Paginated list. The public catalogue passes
   * `filter.publishedOnly = true`; the management list does not.
   *
   * `sort` is OPTIONAL (added in Step 1b, backward compatible). When given,
   * its field has already been checked against `COURSE_SORT_FIELDS` by the
   * service - adapters may map it to a column directly, never a raw string.
   * When omitted, the adapter applies its own default order.
   *
   * Either way the ordering MUST be deterministic: adapters append the id
   * as a final tiebreaker so OFFSET/FETCH paging never repeats or skips rows
   * (database-handoff Q-I1).
   */
  findMany(
    filter: CourseFilter,
    pagination: PaginationQuery,
    sort?: CourseSort,
  ): Promise<PaginatedResult<Course>>;

  /**
   * Creates a course. Throws DuplicateRecordError on slug conflict. The audit
   * entry (built from the stored course code) is written in the same
   * transaction as the insert.
   */
  create(input: CreateCourseInput, audit?: CourseAuditFor<{ courseCode: string }>): Promise<Course>;

  /**
   * Patches metadata. Throws RecordNotFoundError when absent. A patch that
   * changes nothing writes nothing and is not audited.
   */
  update(id: EntityId, input: UpdateCourseInput, audit?: CourseAudit): Promise<Course>;

  /**
   * Replaces the whole curriculum tree.
   *
   * A replace, not a patch, because the frontend sends the entire
   * `CourseModule[]`. This is the operation open-questions Q24 is about:
   * two editors will silently overwrite each other until optimistic
   * concurrency is added, so the signature is kept deliberately simple
   * now and will gain a version token when that decision is made.
   */
  replaceCurriculum(id: EntityId, modules: CourseModule[], audit?: CourseAudit): Promise<Course>;

  /**
   * Sets `status` AND `isPublished` together, in ONE write.
   *
   * Approved at Step 2A. Both values are columns of the same row, so a
   * single `UPDATE ... SET status = @status, isPublished = @isPublished`
   * is atomic without any transaction API (database-handoff Q-X1 stays
   * open). The public catalogue depends on the two never disagreeing.
   *
   * The service always DERIVES `isPublished` from `status`; the adapter
   * stores what it is given and must not re-derive or second-guess it.
   * Throws RecordNotFoundError when the course is absent.
   */
  setPublication(
    id: EntityId,
    change: { status: CourseStatus; isPublished: boolean },
    audit?: CourseAudit,
  ): Promise<Course>;

  /**
   * Sets the lifecycle status, including `Archived`.
   *
   * @deprecated Use `setPublication`. Writing `status` alone can leave
   * `isPublished` contradicting it. Retained for backward compatibility
   * only; removal is the backend lead's decision.
   */
  setStatus(id: EntityId, status: CourseStatus): Promise<Course>;

  /**
   * Sets the publish flag that gates the public catalogue.
   *
   * @deprecated Use `setPublication`. Writing `isPublished` alone can leave
   * `status` contradicting it. Retained for backward compatibility only;
   * removal is the backend lead's decision.
   */
  setPublished(id: EntityId, isPublished: boolean): Promise<Course>;

  /**
   * Looks up a single lesson across the tree.
   *
   * Needed because BR-003 preview access is decided per lesson
   * (`Lesson.isFreePreview`), and the LMS read path should not have to
   * load an entire course to check one lesson.
   */
  findLessonById(
    courseId: EntityId,
    lessonId: EntityId,
  ): Promise<{ lesson: CourseModule["chapters"][number]["lessons"][number] } | null>;

  /**
   * Prerequisite courses of a course (NXA_CoursePrerequisites).
   * Throws RecordNotFoundError when the course is absent.
   */
  findPrerequisites(courseId: EntityId): Promise<PrerequisiteCourse[]>;

  /**
   * Replaces the course's prerequisite set in one transaction. Throws
   * RecordNotFoundError for an unknown course and PrerequisiteRuleError for a
   * self-dependency, an unknown prerequisite course or a circular chain. An
   * unchanged set writes nothing (`changed: false`).
   */
  replacePrerequisites(
    courseId: EntityId,
    prerequisiteCourseIds: string[],
    audit?: CourseAuditFor<PrerequisiteCourse[]>,
  ): Promise<{ prerequisites: PrerequisiteCourse[]; changed: boolean }>;
}
