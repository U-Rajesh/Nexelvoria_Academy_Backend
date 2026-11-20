import { Router, type RequestHandler } from "express";

import { requireAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createTeacherController } from "./teacher.controller";
import { createTeacherService, type TeacherServiceDeps } from "./teacher.service";
import {
  teacherIdParamsSchema,
  teacherListQuerySchema,
  updateTeacherBodySchema,
} from "./teacher.validation";

/**
 * Routes owned by the `teachers` module, mounted at `/teachers` by
 * src/routes/index.ts (which applies `/api/v1`).
 *
 * Admin + super_admin only:
 *   GET   /teachers              list / search / filter / sort   6 #1
 *   GET   /teachers/:teacherId   one teacher                      6 #3
 *   PATCH /teachers/:teacherId   update profile fields            6 #4
 *
 * Middleware order per route, each failing closed:
 *   authenticate  -> WHO is calling     (401; 503 if sessions are unavailable)
 *   requireAdmin  -> MAY they do this   (403)
 *   validate      -> is the input valid (422)
 * so an anonymous caller gets 401 and never a 422 describing the input.
 *
 * `authenticate` is the existing `createAuthenticate` middleware, built once
 * in src/routes/index.ts and passed in - this module neither creates nor
 * modifies middleware.
 *
 * ORDERING NOTE FOR LATER TASKS: static paths such as `GET /me` and
 * `GET /public` (api-contracts 6 #5, #13) must be registered ABOVE
 * `/:teacherId`, or Express will treat "me"/"public" as a teacher id.
 */
export interface TeacherRoutesDeps extends TeacherServiceDeps {
  authenticate: RequestHandler;
}

export const createTeacherRoutes = (deps: TeacherRoutesDeps): Router => {
  const controller = createTeacherController(createTeacherService(deps));
  const router = Router();
  const { authenticate } = deps;

  router.get(
    "/",
    authenticate,
    requireAdmin,
    validate({ query: teacherListQuerySchema }),
    controller.list,
  );

  router.get(
    "/:teacherId",
    authenticate,
    requireAdmin,
    validate({ params: teacherIdParamsSchema }),
    controller.getById,
  );

  router.patch(
    "/:teacherId",
    authenticate,
    requireAdmin,
    validate({ params: teacherIdParamsSchema, body: updateTeacherBodySchema }),
    controller.update,
  );

  return router;
};
