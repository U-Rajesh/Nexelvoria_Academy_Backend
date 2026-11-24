import type { EntityId } from "../../contracts/identifier.contract";
import type { EnrollmentRepository } from "../enrollments/enrollment.repository";
import type { CourseRepository } from "../courses/course.repository";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import type { Course } from "../courses/course.types";
import { TeacherAccessError, TeacherRuleError, type TeacherRepository } from "./teacher.repository";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { evaluateLessonAccess, type LessonAccess } from "../courses/lesson-availability";
import type {
  AssignmentRecord,
  AssignmentSubmissionRecord,
  AttendanceItem,
  BatchStudentInfo,
  ClassSessionRecord,
  LearningMaterialRecord,
  LessonDoubtRecord,
  OnlineTestRecord,
  Teacher,
  TestAttemptRecord,
} from "./teacher.types";
import type {
  CreateAssignmentBody,
  CreateTestBody,
  EvaluateSubmissionBody,
  LessonProgressBody,
  PostDoubtBody,
  RecordAttendanceBody,
  StudentSubmissionBody,
  UpdateTeacherProfileBody,
  UploadMaterialBody,
} from "./teacher.validation";

export interface TeacherServiceDeps {
  teachers: TeacherRepository;
  /**
   * CRS-010 / BR-004: students reach learning content only through an
   * ACTIVE enrollment. Both are needed to decide that; when either is
   * missing, students get no content (fail closed).
   */
  enrollments?: EnrollmentRepository | undefined;
  courses?: CourseRepository | undefined;
}

/** The courses and batches a student may study: their ACTIVE enrollments only. */
interface StudentScope {
  courseIds: Set<string>;
  batchIds: Set<string>;
}

const contentLocked = (): ApiError =>
  ApiError.forbidden(
    "This content is available only with an active enrollment in the course.",
    "CONTENT_LOCKED",
  );

export const createTeacherService = (deps: TeacherServiceDeps) => {
  const studentScope = async (studentUserId: EntityId): Promise<StudentScope> => {
    const list = deps.enrollments ? await deps.enrollments.findByStudent(studentUserId) : [];
    const active = list.filter((e) => e.status === "active");
    return {
      courseIds: new Set(active.map((e) => e.courseId)),
      batchIds: new Set(active.flatMap((e) => (e.batchId ? [e.batchId] : []))),
    };
  };

  /** Course- or batch-scoped item (assignment, test) the student may see. */
  const inScope = (scope: StudentScope, item: { courseId: string; batchId?: string | undefined }): boolean =>
    item.batchId ? scope.batchIds.has(item.batchId) : scope.courseIds.has(item.courseId);

  /** Completed lesson ids of the student (NXA_LessonProgress.IsCompleted, any course). */
  const completedLessons = async (studentUserId: EntityId): Promise<Set<string>> => {
    const list = deps.enrollments ? await deps.enrollments.findByStudent(studentUserId) : [];
    return new Set(list.flatMap((e) => e.completedLessonIds ?? []).map(String));
  };

  /** LMS-004 / LMS-005: the availability of every lesson of a course the student is actively enrolled in. */
  const courseLessonAccess = async (studentUserId: EntityId, courseId: EntityId): Promise<LessonAccess[]> => {
    if (!deps.courses) throw contentLocked();
    const scope = await studentScope(studentUserId);
    if (!scope.courseIds.has(String(courseId))) throw contentLocked();
    const course = await deps.courses.findById(courseId);
    if (!course) throw ApiError.notFound("Course not found");
    return evaluateLessonAccess(course.modules, await completedLessons(studentUserId));
  };

  const refuse = (a: LessonAccess): never => {
    if (a.state === "scheduled") {
      throw new ApiError(HttpStatus.FORBIDDEN, `This lesson opens on ${a.availableAt}.`, "LESSON_NOT_YET_AVAILABLE", [{ field: "availableAt", message: a.availableAt ?? "" }]);
    }
    throw new ApiError(HttpStatus.FORBIDDEN, `Complete "${a.requiresLessonTitle}" first: this lesson unlocks in sequence.`, "LESSON_LOCKED", [
      { field: "requiresLessonId", message: a.requiresLessonId ?? "" },
    ]);
  };

  /**
   * Throws unless the lesson belongs to a course the student is actively enrolled in
   * AND is open to them now (published, past its publish date, previous lesson
   * completed when it unlocks in sequence). Used by every student lesson action.
   */
  const assertLessonAccess = async (studentUserId: EntityId, lessonId: EntityId): Promise<void> => {
    if (!deps.courses || !lessonId) throw contentLocked();
    const scope = await studentScope(studentUserId);
    for (const courseId of scope.courseIds) {
      if (await deps.courses.findLessonById(courseId, lessonId)) {
        const access = (await courseLessonAccess(studentUserId, courseId)).find((a) => String(a.lesson.id) === String(lessonId));
        if (!access) throw ApiError.notFound("Lesson not found");
        if (access.state !== "available") refuse(access);
        return;
      }
    }
    throw contentLocked();
  };

  return {
  // ---- LMS-004 / LMS-005: lessons an enrolled student may open --------------
  /** The course's published lessons in order, each with its availability (no content). */
  async getLessonOutlineForStudent(studentUserId: EntityId, courseId: EntityId) {
    const list = await courseLessonAccess(studentUserId, courseId);
    return list.map((a) => ({
      id: String(a.lesson.id),
      title: a.lesson.title,
      ...(a.lesson.lessonType ? { lessonType: a.lesson.lessonType } : {}),
      durationMinutes: a.lesson.durationMinutes,
      state: a.state,
      isCompleted: a.isCompleted,
      ...(a.availableAt ? { availableAt: a.availableAt } : {}),
      ...(a.requiresLessonId ? { requiresLessonId: a.requiresLessonId, requiresLessonTitle: a.requiresLessonTitle } : {}),
    }));
  },

  /** The lesson content, only when it is open to the student now (403 LESSON_LOCKED / LESSON_NOT_YET_AVAILABLE otherwise). */
  async getLessonForStudent(studentUserId: EntityId, courseId: EntityId, lessonId: EntityId) {
    const access = (await courseLessonAccess(studentUserId, courseId)).find((a) => String(a.lesson.id) === String(lessonId));
    if (!access) throw ApiError.notFound("Lesson not found");
    if (access.state !== "available") refuse(access);
    const l = access.lesson;
    return {
      id: String(l.id),
      title: l.title,
      ...(l.lessonType ? { lessonType: l.lessonType } : {}),
      durationMinutes: l.durationMinutes,
      ...(l.videoUrl ? { videoUrl: l.videoUrl } : {}),
      ...(l.studyMaterialText ? { studyMaterialText: l.studyMaterialText } : {}),
      isDownloadRestricted: l.isDownloadRestricted === true,
      isCompleted: access.isCompleted,
    };
  },

  // ---- Student access to learning content (CRS-010) -----------------------

  async getAssignmentsForStudent(
    studentUserId: EntityId,
    batchId?: EntityId,
    courseId?: EntityId,
  ): Promise<AssignmentRecord[]> {
    const scope = await studentScope(studentUserId);
    const all = await deps.teachers.findAssignments(undefined, batchId, courseId);
    return all.filter((a) => inScope(scope, a));
  },

  async getMaterialsForStudent(studentUserId: EntityId, lessonId: EntityId): Promise<LearningMaterialRecord[]> {
    await assertLessonAccess(studentUserId, lessonId);
    return deps.teachers.findMaterials(lessonId);
  },

  /** A student sees only their own doubts, and only within active enrollments. */
  async getDoubtsForStudent(
    studentUserId: EntityId,
    courseId?: EntityId,
    lessonId?: EntityId,
  ): Promise<LessonDoubtRecord[]> {
    if (courseId) {
      const scope = await studentScope(studentUserId);
      if (!scope.courseIds.has(courseId)) throw contentLocked();
    }
    if (lessonId) await assertLessonAccess(studentUserId, lessonId);
    const list = await deps.teachers.findDoubts(courseId, lessonId);
    return list.filter((d) => d.studentUserId === studentUserId);
  },

  async getOnlineTestsForStudent(
    studentUserId: EntityId,
    batchId?: EntityId,
    courseId?: EntityId,
  ): Promise<OnlineTestRecord[]> {
    const scope = await studentScope(studentUserId);
    const all = await deps.teachers.findTests(undefined, batchId, courseId);
    return all.filter((t) => inScope(scope, t));
  },

  async getTeacherProfile(teacherId: EntityId): Promise<Teacher> {
    const teacher = await deps.teachers.findById(teacherId);
    if (!teacher) {
      throw ApiError.notFound("Teacher profile not found");
    }
    return teacher;
  },

  async updateTeacherProfile(
    teacherId: EntityId,
    input: UpdateTeacherProfileBody,
  ): Promise<Teacher> {
    const teacher = await deps.teachers.findById(teacherId);
    if (!teacher) {
      throw ApiError.notFound("Teacher profile not found");
    }
    return deps.teachers.update(teacherId, input);
  },

  async getAssignedCourses(teacherId: EntityId): Promise<Course[]> {
    return deps.teachers.findAssignedCourses(teacherId);
  },

  async getAssignedBatches(
    teacherId: EntityId,
  ): Promise<Array<{ id: string; courseId: string; batchCode: string; batchName: string; status: string; scheduleDescription?: string }>> {
    return deps.teachers.findAssignedBatches(teacherId);
  },

  async getBatchStudents(teacherId: EntityId, batchId: EntityId): Promise<BatchStudentInfo[]> {
    const isAllocated = await deps.teachers.isAllocatedToBatch(teacherId, batchId);
    if (!isAllocated) {
      throw ApiError.forbidden("You are not allocated to this cohort (BR-TCH-001)");
    }
    return deps.teachers.findBatchStudents(teacherId, batchId);
  },

  async getAllAuthorizedStudents(teacherId: EntityId): Promise<BatchStudentInfo[]> {
    return deps.teachers.findAllAuthorizedStudents(teacherId);
  },

  async recordAttendance(
    teacherId: EntityId,
    input: RecordAttendanceBody,
  ): Promise<ClassSessionRecord> {
    const isAllocated = await deps.teachers.isAllocatedToBatch(teacherId, input.batchId);
    if (!isAllocated) {
      throw ApiError.forbidden("You are not authorized to mark attendance for this cohort");
    }

    return deps.teachers.recordAttendanceSession(
      teacherId,
      {
        batchId: input.batchId,
        courseId: input.courseId,
        sessionTitle: input.sessionTitle,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
      input.records,
    );
  },

  async getAttendanceHistory(
    teacherId: EntityId,
    batchId?: EntityId,
  ): Promise<Array<{ session: ClassSessionRecord; records: AttendanceItem[] }>> {
    if (batchId) {
      const isAllocated = await deps.teachers.isAllocatedToBatch(teacherId, batchId);
      if (!isAllocated) {
        throw ApiError.forbidden("You are not authorized to inspect attendance for this cohort");
      }
    }
    return deps.teachers.findAttendanceHistory(teacherId, batchId);
  },

  async getStudentAttendance(studentUserId: EntityId): Promise<AttendanceItem[]> {
    return deps.teachers.findStudentAttendance(studentUserId);
  },

  async getAssignments(
    teacherId?: EntityId,
    batchId?: EntityId,
    courseId?: EntityId,
  ): Promise<AssignmentRecord[]> {
    return deps.teachers.findAssignments(teacherId, batchId, courseId);
  },

  async createAssignment(
    teacherId: EntityId,
    input: CreateAssignmentBody,
  ): Promise<AssignmentRecord> {
    if (input.batchId) {
      const isAllocated = await deps.teachers.isAllocatedToBatch(teacherId, input.batchId);
      if (!isAllocated) {
        throw ApiError.forbidden("You cannot assign coursework to a cohort outside your portfolio");
      }
    }
    return deps.teachers.createAssignment(teacherId, input);
  },

  async submitAssignment(
    studentUserId: EntityId,
    assignmentId: EntityId,
    input: StudentSubmissionBody,
  ): Promise<AssignmentSubmissionRecord> {
    const scope = await studentScope(studentUserId);
    const assignment = (await deps.teachers.findAssignments()).find((a) => a.id === assignmentId);
    if (!assignment || !inScope(scope, assignment)) {
      // Outside the student's active enrollments, or unknown: indistinguishable.
      throw ApiError.notFound("Assignment not found");
    }
    return deps.teachers.submitAssignment({
      assignmentId,
      studentUserId,
      ...input,
    });
  },

  async evaluateSubmission(
    teacherId: EntityId,
    submissionId: EntityId,
    input: EvaluateSubmissionBody,
  ): Promise<AssignmentSubmissionRecord> {
    try {
      return await deps.teachers.evaluateSubmission(submissionId, teacherId, input.marksAwarded, input.feedback);
    } catch (err) {
      if (err instanceof RecordNotFoundError) throw ApiError.notFound("Submission not found");
      if (err instanceof TeacherAccessError) throw ApiError.forbidden(err.message);
      if (err instanceof TeacherRuleError) throw ApiError.validation([{ field: "marksAwarded", message: err.message }], err.message);
      throw err;
    }
  },

  async getMaterials(lessonId: EntityId): Promise<LearningMaterialRecord[]> {
    return deps.teachers.findMaterials(lessonId);
  },

  async uploadMaterial(
    teacherId: EntityId,
    input: UploadMaterialBody,
  ): Promise<LearningMaterialRecord> {
    return deps.teachers.createMaterial({
      uploadedByUserId: teacherId,
      ...input,
    });
  },

  async deleteMaterial(_teacherId: EntityId, materialId: EntityId): Promise<boolean> {
    return deps.teachers.deleteMaterial(materialId);
  },

  async getDoubts(courseId?: EntityId, lessonId?: EntityId): Promise<LessonDoubtRecord[]> {
    return deps.teachers.findDoubts(courseId, lessonId);
  },

  async postDoubt(studentUserId: EntityId, input: PostDoubtBody): Promise<LessonDoubtRecord> {
    await assertLessonAccess(studentUserId, input.lessonId);
    return deps.teachers.createDoubt({
      studentUserId,
      lessonId: input.lessonId,
      doubtText: input.doubtText,
    });
  },

  async replyDoubt(
    _teacherId: EntityId,
    doubtId: EntityId,
    replyText: string,
  ): Promise<LessonDoubtRecord> {
    return deps.teachers.replyDoubt(doubtId, replyText);
  },

  async recordLessonProgress(
    studentUserId: EntityId,
    lessonId: EntityId,
    input: LessonProgressBody,
  ): Promise<{ isCompleted: boolean; progressPercent: number }> {
    await assertLessonAccess(studentUserId, lessonId);
    return deps.teachers.recordLessonProgress(
      studentUserId,
      lessonId,
      input.isCompleted,
      input.progressPercent,
    );
  },

  async getOnlineTests(
    teacherId?: EntityId,
    batchId?: EntityId,
    courseId?: EntityId,
  ): Promise<OnlineTestRecord[]> {
    return deps.teachers.findTests(teacherId, batchId, courseId);
  },

  async createOnlineTest(
    teacherId: EntityId,
    input: CreateTestBody,
  ): Promise<OnlineTestRecord> {
    if (input.batchId) {
      const isAllocated = await deps.teachers.isAllocatedToBatch(teacherId, input.batchId);
      if (!isAllocated) {
        throw ApiError.forbidden("You cannot create assessments for a cohort outside your portfolio");
      }
    }
    return deps.teachers.createTest({
      createdByTeacherUserId: teacherId,
      ...input,
    });
  },

  async getTestAttempts(
    testId?: EntityId,
    studentUserId?: EntityId,
  ): Promise<TestAttemptRecord[]> {
    return deps.teachers.findTestAttempts(testId, studentUserId);
  },
  };
};

export type TeacherService = ReturnType<typeof createTeacherService>;
