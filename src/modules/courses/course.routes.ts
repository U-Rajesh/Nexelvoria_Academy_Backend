import { Router } from "express";

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
 * Until Developer 1 ships authentication, nothing sets `req.user`, so every
 * management route answers 401 in the real application. That is intended.
 *
 * Middleware order per route: GUARD FIRST, then validate. An anonymous
 * caller must get 401 - never a 422 that describes the expected input.
 */
export const createCourseRoutes = (deps: CourseServiceDeps): Router => {
  const controller = createCourseController(createCourseService(deps));
  const router = Router();

  // --- static `/manage` paths: MUST be registered before `/:slug` ----------
  // Otherwise Express matches "manage" as a slug. "manage" is also a
  // reserved slug (RESERVED_COURSE_SLUGS), so no course can shadow it.
  router.get(
    "/manage",
    requireAdmin,
    validate({ query: manageCourseListQuerySchema }),
    controller.listManaged,
  );

  router.get(
    "/manage/:courseId",
    requireAdmin,
    validate({ params: courseIdParamsSchema }),
    controller.getManagedById,
  );

  // --- public ----------------------------------------------------------------
  router.get("/", validate({ query: publicCourseListQuerySchema }), controller.listPublic);

  router.get("/:slug", validate({ params: courseSlugParamsSchema }), controller.getPublicBySlug);

  // --- management writes -----------------------------------------------------
  router.post("/", requireAdmin, validate({ body: createCourseBodySchema }), controller.create);

  router.patch(
    "/:courseId",
    requireAdmin,
    validate({ params: courseIdParamsSchema, body: updateCourseBodySchema }),
    controller.update,
  );

  router.put(
    "/:courseId/curriculum",
    requireAdmin,
    validate({ params: courseIdParamsSchema, body: curriculumBodySchema }),
    controller.replaceCurriculum,
  );

  router.patch(
    "/:courseId/status",
    requireAdmin,
    validate({ params: courseIdParamsSchema, body: courseStatusBodySchema }),
    controller.setStatus,
  );

  // No body schema: the toggle reads no client input beyond the id.
  router.patch(
    "/:courseId/publish",
    requireAdmin,
    validate({ params: courseIdParamsSchema }),
    controller.togglePublish,
  );

  return router;
};
