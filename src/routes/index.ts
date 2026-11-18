import { Router } from "express";

import type { AppContainer } from "../container/container";
import { createCourseRoutes } from "../modules/courses/course.routes";
import { healthRoutes } from "../modules/health/health.routes";
import { createStudentRoutes } from "../modules/students/student.routes";

/**
 * The API v1 route registry - the ONLY place module routers are mounted.
 *
 * It is a FACTORY taking the container, so each module receives its
 * dependencies explicitly instead of importing a global. That is what
 * lets a test build the same router over in-memory repositories.
 *
 * Adding a module is a one-line change here. Keep the list alphabetical
 * (health aside) so two developers adding modules in parallel touch
 * different lines and git can merge both without a conflict.
 */
export const createApiV1Router = (container: AppContainer): Router => {
  const router = Router();

  // `health` takes no dependencies by design: a liveness probe must answer
  // even when every downstream service, including the database, is down.
  // It is therefore mounted without touching the container.
  router.use(healthRoutes);

  // --- Feature modules are mounted below as they are built. ---
  // Each receives only the repositories it needs.
  //
  // Dependencies are passed as GETTERS, not values. Writing
  // `{ courses: container.repositories.courses }` would resolve the
  // repository right here, at boot - and the production container has no
  // adapters yet, so that throws RepositoryNotConfiguredError and the app
  // (health included) never starts. A getter defers resolution to the
  // first request that needs it.
  //
  // router.use("/auth", ...);
  router.use(
    "/courses",
    createCourseRoutes({
      get courses() {
        return container.repositories.courses;
      },
    }),
  );
  // router.use("/enrollments", ...);
  router.use(
    "/students",
    createStudentRoutes({
      get students() {
        return container.repositories.students;
      },
    }),
  );
  // router.use("/teachers", ...);

  return router;
};
