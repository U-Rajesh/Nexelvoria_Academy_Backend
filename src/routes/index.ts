import { Router } from "express";

import type { AppContainer } from "../container/container";
import { healthRoutes } from "../modules/health/health.routes";

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
  void container;

  router.use(healthRoutes);

  // --- Feature modules are mounted below as they are built. ---
  // Each receives only the repositories it needs, e.g.
  //   router.use("/students", createStudentRoutes({
  //     students: container.repositories.students,
  //   }));
  //
  // router.use("/auth", ...);
  // router.use("/courses", ...);
  // router.use("/enrollments", ...);
  // router.use("/students", ...);
  // router.use("/teachers", ...);

  return router;
};
