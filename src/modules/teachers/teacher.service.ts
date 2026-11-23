import type { EntityId } from "../../contracts/identifier.contract";
import { ApiError } from "../../utils/api-error";
import type { Course } from "../courses/course.types";
import type { TeacherRepository } from "./teacher.repository";
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
}

export const createTeacherService = (deps: TeacherServiceDeps) => ({
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
    return deps.teachers.evaluateSubmission(
      submissionId,
      teacherId,
      input.marksAwarded,
      input.feedback,
    );
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
});

export type TeacherService = ReturnType<typeof createTeacherService>;
