import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId, Slug } from "../../contracts/identifier.contract";
import type {
  Course,
  CourseFilter,
  CourseModule,
  CourseStatus,
  CreateCourseInput,
  UpdateCourseInput,
} from "./course.types";

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
   */
  findMany(filter: CourseFilter, pagination: PaginationQuery): Promise<PaginatedResult<Course>>;

  /** Creates a course. Throws DuplicateRecordError on slug conflict. */
  create(input: CreateCourseInput): Promise<Course>;

  /** Patches metadata. Throws RecordNotFoundError when absent. */
  update(id: EntityId, input: UpdateCourseInput): Promise<Course>;

  /**
   * Replaces the whole curriculum tree.
   *
   * A replace, not a patch, because the frontend sends the entire
   * `CourseModule[]`. This is the operation open-questions Q24 is about:
   * two editors will silently overwrite each other until optimistic
   * concurrency is added, so the signature is kept deliberately simple
   * now and will gain a version token when that decision is made.
   */
  replaceCurriculum(id: EntityId, modules: CourseModule[]): Promise<Course>;

  /** Sets the lifecycle status, including `Archived`. */
  setStatus(id: EntityId, status: CourseStatus): Promise<Course>;

  /** Sets the publish flag that gates the public catalogue. */
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
}
