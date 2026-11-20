import { Router } from "express";

import type { AppContainer } from "../container/container";
import { createAuthenticate } from "../middleware/authenticate.middleware";
import { createCourseRoutes } from "../modules/courses/course.routes";
import { healthRoutes } from "../modules/health/health.routes";
import { createStudentRoutes } from "../modules/students/student.routes";
import { createTeacherRoutes } from "../modules/teachers/teacher.routes";

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
export const createApiV1Router = (
  container: AppContainer,
  /**
   * Additional routes, mounted last but still before the 404 handler.
   *
   * ALWAYS UNDEFINED IN PRODUCTION - `src/server.ts` calls `createApp()`
   * with no options. See the note on `CreateAppOptions.extraV1Routes`: this
   * is a seam for the development-only registration harness in `dev/`, not
   * a second route registry. A feature module is registered below, by name,
   * where it can be reviewed.
   */
  extraRoutes?: Router,
): Router => {
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
  // `/auth` IS DELIBERATELY NOT MOUNTED, and that is not an oversight.
  //
  // `registration.service.ts` performs three sequential writes (user,
  // credential, student profile) with no unit of work, so a failure part way
  // through leaves partial state an operator must repair. Until
  // open-questions **Q-X1** delivers a transaction - or
  // `dbo.USP_NXA_Register_Student` collapses the three writes into one call -
  // there must be no production registration endpoint. The service file says
  // the same thing in capitals.
  //
  // The endpoint is exercised locally through `dev/server.dev.ts`, which
  // passes its own `/auth` router as `extraV1Routes` and is excluded from
  // the build. Mounting it HERE would ship it.
  //
  // router.use("/auth", ...);
  router.use(
    "/courses",
    createCourseRoutes({
      get courses() {
        return container.repositories.courses;
      },
      // The existing authentication middleware, unchanged, applied by the
      // course router to its 7 management routes only (public routes stay
      // anonymous). Its `sessions` dependency is a lazy resolver, so nothing
      // is resolved at boot: with no session adapter registered, a request
      // carrying a token gets 503 and one without gets 401 - fail closed.
      authenticate: createAuthenticate({
        sessions: () => container.repositories.sessions,
      }),
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
  router.use(
    "/teachers",
    createTeacherRoutes({
      get teachers() {
        return container.repositories.teachers;
      },
      // The existing authentication middleware, unchanged. Its `sessions`
      // dependency is already a lazy resolver, so nothing is resolved at
      // boot: with no session adapter registered, a request carrying a
      // token gets 503 and one without a token gets 401 - fail closed.
      authenticate: createAuthenticate({
        sessions: () => container.repositories.sessions,
      }),
    }),
  );

  // Last, so a module route always wins over anything passed in, and still
  // ahead of the 404 handler that `createApp` registers after this router.
  if (extraRoutes !== undefined) {
    router.use(extraRoutes);
  }

  return router;
};
