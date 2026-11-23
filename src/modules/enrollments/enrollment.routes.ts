import { Router, type RequestHandler } from "express";

import { requireStudent } from "../../middleware/authorize.middleware";
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

  router.get("/me", ...studentGuards, controller.getMyEnrollments);
  router.post(
    "/",
    ...studentGuards,
    validate({ body: createEnrollmentBodySchema }),
    controller.requestEnrollment,
  );

  return router;
};
