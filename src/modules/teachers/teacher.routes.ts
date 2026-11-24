import { Router, type RequestHandler } from "express";

import { requireAuth, requireStudent, requireTeacher } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createTeacherController } from "./teacher.controller";
import { createTeacherService, type TeacherServiceDeps } from "./teacher.service";
import {
  createAssignmentBodySchema,
  createTestBodySchema,
  evaluateSubmissionBodySchema,
  lessonProgressBodySchema,
  postDoubtBodySchema,
  recordAttendanceBodySchema,
  replyDoubtBodySchema,
  studentSubmissionBodySchema,
  updateTeacherProfileBodySchema,
  uploadMaterialBodySchema,
} from "./teacher.validation";

export interface TeacherRoutesOptions extends TeacherServiceDeps {
  authenticate?: RequestHandler;
}

export const createTeacherRoutes = (options: TeacherRoutesOptions): Router => {
  const router = Router();
  const service = createTeacherService(options);
  const controller = createTeacherController(service);

  // Authentication alone is not authorization: `requireAuth` must follow, so
  // an unauthenticated request is refused and a limited-access student
  // (CL-001) is denied by default. Previously this was authenticate only.
  const authGuards: RequestHandler[] = options.authenticate
    ? [options.authenticate, requireAuth]
    : [requireAuth];

  const teacherGuards: RequestHandler[] = options.authenticate
    ? [options.authenticate, requireTeacher]
    : [requireTeacher];

  const studentGuards: RequestHandler[] = options.authenticate
    ? [options.authenticate, requireStudent]
    : [requireStudent];

  // 1. Teacher Profile & Allocations
  router.get("/me", ...teacherGuards, controller.getMe);
  router.put(
    "/me",
    ...teacherGuards,
    validate({ body: updateTeacherProfileBodySchema }),
    controller.updateMe,
  );
  router.get("/me/courses", ...teacherGuards, controller.getAssignedCourses);
  router.get("/me/batches", ...teacherGuards, controller.getAssignedBatches);
  router.get("/me/students", ...teacherGuards, controller.getAllAuthorizedStudents);
  router.get("/me/batches/:batchId/students", ...teacherGuards, controller.getBatchStudents);

  // 2. Attendance
  router.post(
    "/attendance",
    ...teacherGuards,
    validate({ body: recordAttendanceBodySchema }),
    controller.recordAttendance,
  );
  router.get("/attendance/history", ...teacherGuards, controller.getAttendanceHistory);
  router.get("/attendance/my", ...studentGuards, controller.getMyStudentAttendance);

  // 3. Coursework & Assignments
  router.get("/assignments", ...authGuards, controller.getAssignments);
  router.post(
    "/assignments",
    ...teacherGuards,
    validate({ body: createAssignmentBodySchema }),
    controller.createAssignment,
  );
  router.post(
    "/assignments/:assignmentId/submit",
    ...studentGuards,
    validate({ body: studentSubmissionBodySchema }),
    controller.submitAssignment,
  );
  router.post(
    "/assignments/submissions/:submissionId/evaluate",
    ...teacherGuards,
    validate({ body: evaluateSubmissionBodySchema }),
    controller.evaluateSubmission,
  );

  // 4. Study Materials
  router.get("/materials", ...authGuards, controller.getMaterials);
  router.post(
    "/materials",
    ...teacherGuards,
    validate({ body: uploadMaterialBodySchema }),
    controller.uploadMaterial,
  );
  router.delete("/materials/:materialId", ...teacherGuards, controller.deleteMaterial);

  // 5. Doubts / Q&A
  router.get("/doubts", ...authGuards, controller.getDoubts);
  router.post(
    "/doubts",
    ...studentGuards,
    validate({ body: postDoubtBodySchema }),
    controller.postDoubt,
  );
  router.post(
    "/doubts/:doubtId/reply",
    ...teacherGuards,
    validate({ body: replyDoubtBodySchema }),
    controller.replyDoubt,
  );

  // 6a. LMS-004 / LMS-005: lessons for an actively enrolled student, enforced on the server.
  router.get("/lms/courses/:courseId/lessons", ...studentGuards, controller.getLessonOutline);
  router.get("/lms/courses/:courseId/lessons/:lessonId", ...studentGuards, controller.getLesson);

  // 6. LMS Lesson Progress
  router.post(
    "/lms/lessons/:lessonId/progress",
    ...studentGuards,
    validate({ body: lessonProgressBodySchema }),
    controller.recordLessonProgress,
  );

  // 7. Tests & Assessments
  router.get("/tests", ...authGuards, controller.getOnlineTests);
  router.post(
    "/tests",
    ...teacherGuards,
    validate({ body: createTestBodySchema }),
    controller.createOnlineTest,
  );
  router.get("/tests/attempts", ...authGuards, controller.getTestAttempts);

  return router;
};
