import { Router, type RequestHandler } from "express";

import { requireStudent, requireStudentAllowingLimited } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createEnrollmentController } from "./enrollment.controller";
import { createEnrollmentService, type EnrollmentServiceDeps } from "./enrollment.service";
import { createEnrollmentBodySchema } from "./enrollment.validation";

export interface EnrollmentRoutesOptions extends EnrollmentServiceDeps {
  authenticate?: RequestHandler;
}

export const createEnrollmentRoutes = (options: EnrollmentRoutesOptions): Router => {
  const controller = createEnrollmentController(createEnrollmentService(options));
  const router = Router();

  const studentGuards: RequestHandler[] =
    options.authenticate === undefined
      ? [requireStudent]
      : [options.authenticate, requireStudent];

  // CL-001 allowlist: also open to students whose approval is pending (limited access).
  const limitedStudentGuards: RequestHandler[] =
    options.authenticate === undefined
      ? [requireStudentAllowingLimited]
      : [options.authenticate, requireStudentAllowingLimited];

  router.get("/me", ...limitedStudentGuards, controller.getMyEnrollments);
  // Selecting a course requires Admin approval (BR-002): default guard.
  router.post(
    "/",
    ...studentGuards,
    validate({ body: createEnrollmentBodySchema }),
    controller.requestEnrollment,
  );

  return router;
};
