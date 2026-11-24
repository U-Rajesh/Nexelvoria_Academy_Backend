import type { Request, Response } from "express";

import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";
import type { TeacherService } from "./teacher.service";

const sendCreated = <T>(res: Response, options: { data?: T; message?: string }): void => {
  sendSuccess(res, { status: HttpStatus.CREATED, ...options });
};
import type {
  CreateAssignmentBody,
  CreateTestBody,
  EvaluateSubmissionBody,
  LessonProgressBody,
  PostDoubtBody,
  RecordAttendanceBody,
  ReplyDoubtBody,
  StudentSubmissionBody,
  UpdateTeacherProfileBody,
  UploadMaterialBody,
} from "./teacher.validation";

const actorId = (req: Request): string => {
  const id = req.principal?.id;
  if (!id) {
    throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  }
  return id;
};

export const createTeacherController = (service: TeacherService) => ({
  async getMe(req: Request, res: Response): Promise<void> {
    const teacher = await service.getTeacherProfile(actorId(req));
    sendSuccess(res, { data: teacher });
  },

  async updateMe(req: Request, res: Response): Promise<void> {
    const updated = await service.updateTeacherProfile(
      actorId(req),
      req.body as UpdateTeacherProfileBody,
    );
    sendSuccess(res, { data: updated, message: "Teacher profile updated successfully" });
  },

  async getAssignedCourses(req: Request, res: Response): Promise<void> {
    const courses = await service.getAssignedCourses(actorId(req));
    sendSuccess(res, { data: courses });
  },

  async getAssignedBatches(req: Request, res: Response): Promise<void> {
    const batches = await service.getAssignedBatches(actorId(req));
    sendSuccess(res, { data: batches });
  },

  async getBatchStudents(req: Request, res: Response): Promise<void> {
    const batchId = String(req.params["batchId"]);
    const students = await service.getBatchStudents(actorId(req), batchId);
    sendSuccess(res, { data: students });
  },

  async getAllAuthorizedStudents(req: Request, res: Response): Promise<void> {
    const students = await service.getAllAuthorizedStudents(actorId(req));
    sendSuccess(res, { data: students });
  },

  async recordAttendance(req: Request, res: Response): Promise<void> {
    const session = await service.recordAttendance(
      actorId(req),
      req.body as RecordAttendanceBody,
    );
    sendCreated(res, { data: session, message: "Attendance recorded successfully" });
  },

  async getAttendanceHistory(req: Request, res: Response): Promise<void> {
    const batchId = req.query["batchId"] ? String(req.query["batchId"]) : undefined;
    const history = await service.getAttendanceHistory(actorId(req), batchId);
    sendSuccess(res, { data: history });
  },

  async getMyStudentAttendance(req: Request, res: Response): Promise<void> {
    const records = await service.getStudentAttendance(actorId(req));
    const total = records.length;
    const present = records.filter((r) => r.status === "present").length;
    const absent = records.filter((r) => r.status === "absent").length;
    const leave = records.filter((r) => r.status === "leave").length;
    const percentage = total > 0 ? Math.round((present / total) * 100) : 0;
    sendSuccess(res, {
      data: {
        total,
        present,
        absent,
        leave,
        percentage,
        sessions: records,
        records,
      },
    });
  },

  async getAssignments(req: Request, res: Response): Promise<void> {
    const batchId = req.query["batchId"] ? String(req.query["batchId"]) : undefined;
    const courseId = req.query["courseId"] ? String(req.query["courseId"]) : undefined;
    const teacherId = req.principal?.role === "teacher" ? req.principal.id : undefined;
    const assignments =
      req.principal?.role === "student"
        ? await service.getAssignmentsForStudent(req.principal.id, batchId, courseId)
        : await service.getAssignments(teacherId, batchId, courseId);
    sendSuccess(res, { data: assignments });
  },

  async createAssignment(req: Request, res: Response): Promise<void> {
    const assignment = await service.createAssignment(
      actorId(req),
      req.body as CreateAssignmentBody,
    );
    sendCreated(res, { data: assignment, message: "Assignment created successfully" });
  },

  async submitAssignment(req: Request, res: Response): Promise<void> {
    const assignmentId = String(req.params["assignmentId"]);
    const submission = await service.submitAssignment(
      actorId(req),
      assignmentId,
      req.body as StudentSubmissionBody,
    );
    sendCreated(res, { data: submission, message: "Assignment submitted successfully" });
  },

  async evaluateSubmission(req: Request, res: Response): Promise<void> {
    const submissionId = String(req.params["submissionId"]);
    const evaluated = await service.evaluateSubmission(
      actorId(req),
      submissionId,
      req.body as EvaluateSubmissionBody,
    );
    sendSuccess(res, { data: evaluated, message: "Submission evaluated successfully" });
  },

  async getMaterials(req: Request, res: Response): Promise<void> {
    const lessonId = String(req.query["lessonId"] ?? "");
    const materials =
      req.principal?.role === "student"
        ? await service.getMaterialsForStudent(req.principal.id, lessonId)
        : await service.getMaterials(lessonId);
    sendSuccess(res, { data: materials });
  },

  async uploadMaterial(req: Request, res: Response): Promise<void> {
    const material = await service.uploadMaterial(
      actorId(req),
      req.body as UploadMaterialBody,
    );
    sendCreated(res, { data: material, message: "Study material uploaded successfully" });
  },

  async deleteMaterial(req: Request, res: Response): Promise<void> {
    const materialId = String(req.params["materialId"]);
    await service.deleteMaterial(actorId(req), materialId);
    sendSuccess(res, { data: { success: true }, message: "Material deleted successfully" });
  },

  async getDoubts(req: Request, res: Response): Promise<void> {
    const courseId = req.query["courseId"] ? String(req.query["courseId"]) : undefined;
    const lessonId = req.query["lessonId"] ? String(req.query["lessonId"]) : undefined;
    const doubts =
      req.principal?.role === "student"
        ? await service.getDoubtsForStudent(req.principal.id, courseId, lessonId)
        : await service.getDoubts(courseId, lessonId);
    sendSuccess(res, { data: doubts });
  },

  async postDoubt(req: Request, res: Response): Promise<void> {
    const doubt = await service.postDoubt(
      actorId(req),
      req.body as PostDoubtBody,
    );
    sendCreated(res, { data: doubt, message: "Doubt submitted successfully" });
  },

  async replyDoubt(req: Request, res: Response): Promise<void> {
    const doubtId = String(req.params["doubtId"]);
    const body = req.body as ReplyDoubtBody;
    const doubt = await service.replyDoubt(actorId(req), doubtId, body.replyText);
    sendSuccess(res, { data: doubt, message: "Doubt resolved with instructor reply" });
  },

  // LMS-004 / LMS-005
  async getLessonOutline(req: Request, res: Response): Promise<void> {
    sendSuccess(res, { data: await service.getLessonOutlineForStudent(actorId(req), String(req.params["courseId"])) });
  },

  async getLesson(req: Request, res: Response): Promise<void> {
    sendSuccess(res, { data: await service.getLessonForStudent(actorId(req), String(req.params["courseId"]), String(req.params["lessonId"])) });
  },

  async recordLessonProgress(req: Request, res: Response): Promise<void> {
    const lessonId = String(req.params["lessonId"]);
    const progress = await service.recordLessonProgress(
      actorId(req),
      lessonId,
      req.body as LessonProgressBody,
    );
    sendSuccess(res, { data: progress, message: "Lesson progress recorded" });
  },

  async getOnlineTests(req: Request, res: Response): Promise<void> {
    const batchId = req.query["batchId"] ? String(req.query["batchId"]) : undefined;
    const courseId = req.query["courseId"] ? String(req.query["courseId"]) : undefined;
    const teacherId = req.principal?.role === "teacher" ? req.principal.id : undefined;
    const tests =
      req.principal?.role === "student"
        ? await service.getOnlineTestsForStudent(req.principal.id, batchId, courseId)
        : await service.getOnlineTests(teacherId, batchId, courseId);
    sendSuccess(res, { data: tests });
  },

  async createOnlineTest(req: Request, res: Response): Promise<void> {
    const test = await service.createOnlineTest(
      actorId(req),
      req.body as CreateTestBody,
    );
    sendCreated(res, { data: test, message: "Online test created successfully" });
  },

  async getTestAttempts(req: Request, res: Response): Promise<void> {
    const testId = req.query["testId"] ? String(req.query["testId"]) : undefined;
    const studentUserId = req.principal?.role === "student" ? req.principal.id : undefined;
    const attempts = await service.getTestAttempts(testId, studentUserId);
    sendSuccess(res, { data: attempts });
  },
});

export type TeacherController = ReturnType<typeof createTeacherController>;
