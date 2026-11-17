import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type {
  CreateEnrollmentInput,
  Enrollment,
  EnrollmentFilter,
  EnrollmentStatus,
} from "./enrollment.types";

/**
 * The `enrollments` repository PORT. Interface only - no SQL, no driver.
 *
 * Maps to docs/api-contracts.md section 9.
 */
export interface EnrollmentRepository {
  findById(id: EntityId): Promise<Enrollment | null>;

  /**
   * The one enrolment for a student on a course, or null.
   *
   * Two jobs: it prevents duplicate enrolment (the 409), and it is the
   * lookup the content path uses to decide preview-versus-full access
   * (BR-003). It assumes a student holds at most one enrolment per
   * course - a uniqueness assumption the database team must confirm,
   * since re-enrolment after cancellation would break it. Raised in the
   * handoff document.
   */
  findByStudentAndCourse(studentId: EntityId, courseId: EntityId): Promise<Enrollment | null>;

  /** Every enrolment for one student. Backs `GET /enrollments/me`. */
  findByStudent(studentId: EntityId): Promise<Enrollment[]>;

  /** Paginated admin list. */
  findMany(
    filter: EnrollmentFilter,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Enrollment>>;

  /**
   * Creates an enrolment.
   * Throws DuplicateRecordError when one already exists for this
   * student and course.
   */
  create(input: CreateEnrollmentInput): Promise<Enrollment>;

  /** Moves the lifecycle state. Throws RecordNotFoundError when absent. */
  setStatus(id: EntityId, status: EnrollmentStatus): Promise<Enrollment>;

  /**
   * Records a completed lesson and returns the updated enrolment.
   *
   * Idempotent: completing the same lesson twice must not double-count,
   * because the client may retry. Progress recalculation needs the
   * course's total lesson count, which the SERVICE supplies - the
   * repository does not reach into the courses module.
   */
  markLessonCompleted(
    id: EntityId,
    lessonId: EntityId,
    progressPercentage: number,
  ): Promise<Enrollment>;

  /** Adds a bookmark. Idempotent, so a retry is safe. */
  addBookmark(id: EntityId, lessonId: EntityId): Promise<Enrollment>;

  /** Removes a bookmark. Idempotent - removing an absent one is not an error. */
  removeBookmark(id: EntityId, lessonId: EntityId): Promise<Enrollment>;

  /**
   * Counts active enrolments on a batch.
   *
   * Exists for the batch capacity check (BR / open-questions Q5). The
   * capacity limit itself is unconfirmed, so nothing enforces it yet -
   * but the count the check will need is defined here so the database
   * team can index for it.
   */
  countActiveByBatch(batchId: EntityId): Promise<number>;
}
