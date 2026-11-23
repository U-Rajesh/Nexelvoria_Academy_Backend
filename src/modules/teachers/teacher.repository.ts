import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type { Course } from "../courses/course.types";
import type {
  AssignmentRecord,
  AssignmentSubmissionRecord,
  AttendanceItem,
  BatchStudentInfo,
  ClassSessionRecord,
  CreateTeacherInput,
  LearningMaterialRecord,
  LessonDoubtRecord,
  OnlineTestRecord,
  Teacher,
  TeacherAllocation,
  TeacherFilter,
  TestAttemptRecord,
  UpdateTeacherInput,
} from "./teacher.types";

/**
 * The `teachers` repository PORT. Interface only - no SQL, no driver.
 *
 * Maps to docs/api-contracts.md section 6 and Batch 3 LMS operations.
 */
export interface TeacherRepository {
  findById(id: EntityId): Promise<Teacher | null>;

  findByEmail(email: string): Promise<Teacher | null>;

  existsByEmail(email: string): Promise<boolean>;

  findMany(filter: TeacherFilter, pagination: PaginationQuery): Promise<PaginatedResult<Teacher>>;

  create(input: CreateTeacherInput): Promise<Teacher>;

  update(id: EntityId, input: UpdateTeacherInput): Promise<Teacher>;

  setStatus(id: EntityId, status: UserStatus): Promise<Teacher>;

  // --- Allocations -------------------------------------------------------

  /**
   * Allocates a teacher to a course + batch.
   * Throws DuplicateRecordError if the same allocation already exists.
   */
  addAllocation(allocation: TeacherAllocation): Promise<Teacher>;

  /** Removes the allocation for a batch. Throws if the teacher is absent. */
  removeAllocation(teacherId: EntityId, batchId: EntityId): Promise<Teacher>;

  /** Every allocation held by one teacher. */
  findAllocations(teacherId: EntityId): Promise<TeacherAllocation[]>;

  /**
   * THE teacher authorization primitive.
   * A teacher may only read or mutate data for batches allocated to them.
   */
  isAllocatedToBatch(teacherId: EntityId, batchId: EntityId): Promise<boolean>;

  /** Teachers allocated to a batch. Backs batch detail views. */
  findByBatch(batchId: EntityId): Promise<Teacher[]>;

  // --- Batch 3 Learning Management & Teacher Portals ----------------------

  findAssignedCourses(teacherId: EntityId): Promise<Course[]>;

  findAssignedBatches(teacherId: EntityId): Promise<Array<{ id: string; courseId: string; batchCode: string; batchName: string; status: string; scheduleDescription?: string }>>;

  findBatchStudents(teacherId: EntityId, batchId: EntityId): Promise<BatchStudentInfo[]>;

  findAllAuthorizedStudents(teacherId: EntityId): Promise<BatchStudentInfo[]>;

  recordAttendanceSession(
    teacherId: EntityId,
    session: {
      batchId: string;
      courseId?: string | undefined;
      sessionTitle: string;
      startsAt?: string | undefined;
      endsAt?: string | undefined;
    },
    records: Array<{ studentUserId: string; status: "present" | "absent" | "late" | "excused"; remarks?: string | undefined }>,
  ): Promise<ClassSessionRecord>;

  findAttendanceHistory(teacherId: EntityId, batchId?: EntityId): Promise<Array<{ session: ClassSessionRecord; records: AttendanceItem[] }>>;

  findStudentAttendance(studentUserId: EntityId): Promise<AttendanceItem[]>;

  findAssignments(teacherId?: EntityId, batchId?: EntityId, courseId?: EntityId): Promise<AssignmentRecord[]>;

  createAssignment(teacherId: EntityId, assignment: Partial<AssignmentRecord>): Promise<AssignmentRecord>;

  submitAssignment(submission: Partial<AssignmentSubmissionRecord>): Promise<AssignmentSubmissionRecord>;

  evaluateSubmission(
    submissionId: EntityId,
    evaluatorUserId: EntityId,
    marks: number,
    feedback?: string,
  ): Promise<AssignmentSubmissionRecord>;

  findMaterials(lessonId: EntityId): Promise<LearningMaterialRecord[]>;

  createMaterial(material: Partial<LearningMaterialRecord>): Promise<LearningMaterialRecord>;

  deleteMaterial(materialId: EntityId): Promise<boolean>;

  findDoubts(courseId?: EntityId, lessonId?: EntityId): Promise<LessonDoubtRecord[]>;

  createDoubt(doubt: Partial<LessonDoubtRecord>): Promise<LessonDoubtRecord>;

  replyDoubt(doubtId: EntityId, replyText: string): Promise<LessonDoubtRecord>;

  recordLessonProgress(
    studentUserId: EntityId,
    lessonId: EntityId,
    isCompleted: boolean,
    progressPercent: number,
  ): Promise<{ isCompleted: boolean; progressPercent: number }>;

  findTests(teacherId?: EntityId, batchId?: EntityId, courseId?: EntityId): Promise<OnlineTestRecord[]>;

  createTest(test: Partial<OnlineTestRecord>): Promise<OnlineTestRecord>;

  findTestAttempts(testId?: EntityId, studentUserId?: EntityId): Promise<TestAttemptRecord[]>;
}
