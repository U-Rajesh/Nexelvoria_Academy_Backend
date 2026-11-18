import { Router, type RequestHandler } from "express";

import { requireAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createCourseController } from "./course.controller";
import { createCourseService, type CourseServiceDeps } from "./course.service";
import {
  courseIdParamsSchema,
  courseSlugParamsSchema,
  courseStatusBodySchema,
  createCourseBodySchema,
  curriculumBodySchema,
  manageCourseListQuerySchema,
  publicCourseListQuerySchema,
  updateCourseBodySchema,
} from "./course.validation";

/**
 * Routes owned by the `courses` module, mounted at `/courses` by
 * src/routes/index.ts (which applies `/api/v1`).
 *
 * PUBLIC - anonymous, read-only (Step 1):
 *   GET    /courses                       catalogue          api-contracts 7 #1
 *   GET    /courses/:slug                 one course         7 #2
 *
 * MANAGEMENT - admin + super_admin only (Step 2A):
 *   GET    /courses/manage                all incl. drafts   7 #3
 *   GET    /courses/manage/:courseId      read for editing   7 #4
 *   POST   /courses                       create             7 #5
 *   PATCH  /courses/:courseId             update metadata    7 #6
 *   PUT    /courses/:courseId/curriculum  replace tree       7 #7
 *   PATCH  /courses/:courseId/status      lifecycle status   7 #8
 *   PATCH  /courses/:courseId/publish     toggle visibility  7 #9
 *
 * Authorization: `requireAdmin` (ADMIN_ROLES - admin, super_admin).
 * The contract also grants TEACHERS #3, #4, #6, #7 for allocated courses
 * only. That is deferred until the identity contract and allocation lookup
 * exist: adding `teacher` to these guards without the allocation check
 * would let every teacher edit every course the day authentication lands.
 *
 * Middleware order on EVERY management route, each failing closed:
 *   authenticate  -> WHO is calling     (401; 503 if sessions are unavailable)
 *   requireAdmin  -> MAY they do this   (403)
 *   validate      -> is the input valid (422)
 * An anonymous caller therefore gets 401, never a 422 describing the input.
 *
 * `authenticate` is REQUIRED, not optional: `requireAdmin` reads only
 * `req.principal`, which only `authenticate` sets. Before this was wired,
 * every management route answered 401 even to a valid admin token. Making
 * it a required dependency means a router can never again be built without
 * it. The public routes deliberately do NOT run it - they stay anonymous.
 */
export interface CourseRoutesDeps extends CourseServiceDeps {
  /** The existing `createAuthenticate` middleware, built in src/routes/index.ts. */
  authenticate: RequestHandler;
}

export const createCourseRoutes = (deps: CourseRoutesDeps): Router => {
  const controller = createCourseController(createCourseService(deps));
  const router = Router();

  /** authenticate -> requireAdmin, applied identically to all 7 management routes. */
  const adminOnly: RequestHandler[] = [deps.authenticate, requireAdmin];

  // --- static `/manage` paths: MUST be registered before `/:slug` ----------
  // Otherwise Express matches "manage" as a slug. "manage" is also a
  // reserved slug (RESERVED_COURSE_SLUGS), so no course can shadow it.
  router.get(
    "/manage",
    ...adminOnly,
    validate({ query: manageCourseListQuerySchema }),
    controller.listManaged,
  );

  router.get(
    "/manage/:courseId",
    ...adminOnly,
    validate({ params: courseIdParamsSchema }),
    controller.getManagedById,
  );

  // --- public: anonymous, no authenticate ------------------------------------
  router.get("/", validate({ query: publicCourseListQuerySchema }), controller.listPublic);

  router.get("/:slug", validate({ params: courseSlugParamsSchema }), controller.getPublicBySlug);

  // --- management writes -----------------------------------------------------
  router.post("/", ...adminOnly, validate({ body: createCourseBodySchema }), controller.create);

  router.patch(
    "/:courseId",
    ...adminOnly,
    validate({ params: courseIdParamsSchema, body: updateCourseBodySchema }),
    controller.update,
  );

  router.put(
    "/:courseId/curriculum",
    ...adminOnly,
    validate({ params: courseIdParamsSchema, body: curriculumBodySchema }),
    controller.replaceCurriculum,
  );

  router.patch(
    "/:courseId/status",
    ...adminOnly,
    validate({ params: courseIdParamsSchema, body: courseStatusBodySchema }),
    controller.setStatus,
  );

  // No body schema: the toggle reads no client input beyond the id.
  router.patch(
    "/:courseId/publish",
    ...adminOnly,
    validate({ params: courseIdParamsSchema }),
    controller.togglePublish,
  );

  return router;
};
