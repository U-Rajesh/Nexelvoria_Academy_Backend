import { Router, type RequestHandler } from "express";

import { requireAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createStudentController } from "./student.controller";
import { createStudentService, type StudentServiceDeps } from "./student.service";
import {
  studentApproveBodySchema,
  studentIdParamsSchema,
  studentListQuerySchema,
  studentRejectBodySchema,
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
 *   POST  /students/:studentId/approve approve registration    5 #6 (Phase 4)
 *   POST  /students/:studentId/reject  reject with remarks     5 #7 (Phase 4)
 *
 * Middleware order per route: AUTHENTICATE, GUARD, then validate - an
 * anonymous caller gets 401, never a 422 describing the expected input, and
 * never a 403 that confirms the route exists for someone.
 *
 * ORDERING NOTE FOR TASK 3.5: `GET /students/me` must be registered ABOVE
 * `GET /:studentId`, or Express will treat "me" as a student id.
 */
export interface StudentRoutesOptions extends StudentServiceDeps {
  /**
   * Authentication middleware, which populates `req.principal`.
   *
   * OPTIONAL, and the default is what production still gets today.
   *
   * ============================= WHY OPTIONAL =============================
   * `createAuthenticate` exists and is tested, but NOTHING in the
   * application wires it - `createApp()` does not install it and this file's
   * previous revision noted that "until Developer 1 ships authentication
   * nothing sets req.user, so every route answers 401. That is intended."
   *
   * That remains true when this option is omitted: `requireAdmin` finds no
   * principal and fails closed with 401. Omitting it therefore changes the
   * behaviour of the existing three routes NOT AT ALL, which is the point -
   * wiring authentication into the production app is a shared architecture
   * decision for the backend lead, not a side effect of adding approval.
   *
   * It matters here specifically because `recordApprovalDecision` needs
   * `decidedByUserId`, and the only legitimate source of that is a verified
   * token. So the approval routes are mounted either way, but they can only
   * SUCCEED where authentication is wired - today, the development harness.
   * ========================================================================
   */
  authenticate?: RequestHandler;
}

export const createStudentRoutes = (options: StudentRoutesOptions): Router => {
  const controller = createStudentController(createStudentService(options));
  const router = Router();

  /**
   * Guards for one route, in order.
   *
   * When no `authenticate` is supplied the chain is just `requireAdmin`,
   * which denies every anonymous request - the pre-existing behaviour.
   */
  const guards: RequestHandler[] =
    options.authenticate === undefined
      ? [requireAdmin]
      : [options.authenticate, requireAdmin];

  router.get("/", ...guards, validate({ query: studentListQuerySchema }), controller.list);

  router.get(
    "/:studentId",
    ...guards,
    validate({ params: studentIdParamsSchema }),
    controller.getById,
  );

  router.patch(
    "/:studentId/status",
    ...guards,
    validate({ params: studentIdParamsSchema, body: studentStatusBodySchema }),
    controller.setStatus,
  );

  // --- BR-002 approval gate (Phase 4) ------------------------------------
  //
  // POST, not PATCH: approving is an ACTION that records an audited
  // decision, not a partial update of a field. api-contracts 5 #6 and #7
  // specify POST, and `recordApprovalDecision` is deliberately separate from
  // `update` in the repository port for the same reason.
  router.post(
    "/:studentId/approve",
    ...guards,
    validate({ params: studentIdParamsSchema, body: studentApproveBodySchema }),
    controller.approve,
  );

  router.post(
    "/:studentId/reject",
    ...guards,
    validate({ params: studentIdParamsSchema, body: studentRejectBodySchema }),
    controller.reject,
  );

  return router;
};
