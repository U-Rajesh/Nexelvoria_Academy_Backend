import { Router } from "express";

import { requireAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createStudentController } from "./student.controller";
import { createStudentService, type StudentServiceDeps } from "./student.service";
import {
  studentIdParamsSchema,
  studentListQuerySchema,
  studentStatusBodySchema,
} from "./student.validation";

/**
 * Routes owned by the `students` module, mounted at `/students` by
 * src/routes/index.ts (which applies `/api/v1`).
 *
 * Admin + super_admin only:
 *   GET   /students                    list / search / filter  5 #1 (Task 3.1)
 *   GET   /students/:studentId         one student             5 #3 (Task 3.1)
 *   PATCH /students/:studentId/status  set status              5 #4 (Task 3.2)
 *
 * Until Developer 1 ships authentication nothing sets `req.user`, so every
 * route answers 401 in the real application. That is intended.
 *
 * Middleware order per route: GUARD FIRST, then validate - an anonymous
 * caller gets 401, never a 422 describing the expected input.
 *
 * ORDERING NOTE FOR TASK 3.5: `GET /students/me` must be registered ABOVE
 * `GET /:studentId`, or Express will treat "me" as a student id.
 */
export const createStudentRoutes = (deps: StudentServiceDeps): Router => {
  const controller = createStudentController(createStudentService(deps));
  const router = Router();

  router.get("/", requireAdmin, validate({ query: studentListQuerySchema }), controller.list);

  router.get(
    "/:studentId",
    requireAdmin,
    validate({ params: studentIdParamsSchema }),
    controller.getById,
  );

  router.patch(
    "/:studentId/status",
    requireAdmin,
    validate({ params: studentIdParamsSchema, body: studentStatusBodySchema }),
    controller.setStatus,
  );

  return router;
};
