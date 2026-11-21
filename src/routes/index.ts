import { Router, type RequestHandler } from "express";

import type { AppContainer } from "../container/container";
// KEPT FOR REFERENCE, INACTIVE (ownership decision 2026-11-20: Rajesh owns
// authentication). Used only by the commented-out nex_b_main production
// `/auth` mount and shared-middleware fallback below.
// import { env } from "../config/env";
// import { createAuthenticate } from "../middleware/authenticate.middleware";
// import { createAuthRoutes } from "../modules/auth/auth.routes";
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
  /**
   * Authentication middleware, handed to the modules whose routes need an
   * identity.
   *
   * ALWAYS UNDEFINED IN PRODUCTION today - `src/server.ts` calls
   * `createApp()` with no options. Nothing in the application wires
   * `createAuthenticate` yet, so passing it here is how the development
   * harness gets real admin authentication without changing what production
   * does. Omitted, every guarded route keeps failing closed with 401.
   *
   * Wiring this in production is a SHARED ARCHITECTURE DECISION for the
   * backend lead: with no session adapter registered, `authenticate`
   * answers 503 rather than 401, which changes the response every existing
   * guarded route gives today.
   */
  authenticate?: RequestHandler,
): Router => {
  const router = Router();

  // `health` takes no dependencies by design: a liveness probe must answer
  // even when every downstream service, including the database, is down.
  // It is therefore mounted without touching the container.
  router.use(healthRoutes);

  // AUTHENTICATION FOLLOWS nex_b_development (Rajesh owns it).
  //
  // The ONLY authentication middleware is the `authenticate` parameter
  // above. It is injected by `createApp({ authenticate })` - the dev harness
  // passes `createDevAuthenticate(container)` - and handed unchanged to every
  // guarded module below (courses, students, teachers), so all of them
  // validate sessions identically. Production passes nothing, so every
  // guarded route fails closed with 401 until the backend lead wires it.
  //
  // KEPT FOR REFERENCE, INACTIVE: nex_b_main's fallback that built its own
  // instance when none was injected. Re-enabling it would create a second
  // construction path for the middleware.
  //
  // const sharedAuthenticate: RequestHandler =
  //   authenticate ??
  //   createAuthenticate({
  //     sessions: () => container.repositories.sessions,
  //   });

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
  // the build. Mounting it HERE would ship it. That dev router is also the
  // ONLY `/auth/login` (with `/register`, `/otp/email/verify` and
  // `/otp/email/resend`) - Rajesh's implementation.
  //
  // router.use("/auth", ...);
  //
  // KEPT FOR REFERENCE, INACTIVE: nex_b_main's production `/auth` router
  // (login / refresh / logout / me with refresh tokens,
  // src/modules/auth/auth.routes.ts). Mounted here it would answer
  // `POST /auth/login` before the dev router and shadow Rajesh's login, so
  // it stays off by the 2026-11-20 ownership decision: Rajesh's
  // authentication (the dev `/auth` router and the injected `authenticate`)
  // is the active implementation. The old implementation - that module,
  // its controller and its tests - is INACTIVE and is NOT part of this
  // integration commit; it is retained only outside it, pending a decision
  // on whether to retire it. The block below is kept for reference only.
  //
  // router.use(
  //   "/auth",
  //   createAuthRoutes({
  //     get users() {
  //       return container.repositories.users;
  //     },
  //     get credentials() {
  //       return container.repositories.credentials;
  //     },
  //     get sessions() {
  //       return container.repositories.sessions;
  //     },
  //     authenticate: sharedAuthenticate,
  //     maxFailedLoginAttempts: env.MAX_FAILED_LOGIN_ATTEMPTS,
  //   }),
  // );
  router.use(
    "/courses",
    createCourseRoutes({
      get courses() {
        return container.repositories.courses;
      },
      // Rajesh's injected middleware, applied by the course router to its 7
      // management routes only; the public catalogue routes stay anonymous.
      ...(authenticate === undefined ? {} : { authenticate }),
    }),
  );
  // router.use("/enrollments", ...);
  router.use(
    "/students",
    createStudentRoutes({
      get students() {
        return container.repositories.students;
      },
      ...(authenticate === undefined ? {} : { authenticate }),
    }),
  );
  router.use(
    "/teachers",
    createTeacherRoutes({
      get teachers() {
        return container.repositories.teachers;
      },
      // Same rule as /courses and /students: Rajesh's injected middleware,
      // applied to all 3 teacher routes. Omitted (production today),
      // `requireAdmin` fails closed with 401.
      ...(authenticate === undefined ? {} : { authenticate }),
    }),
  );

  // Last, so a module route always wins over anything passed in, and still
  // ahead of the 404 handler that `createApp` registers after this router.
  if (extraRoutes !== undefined) {
    router.use(extraRoutes);
  }

  return router;
};
