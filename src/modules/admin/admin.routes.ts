import { Router, type RequestHandler } from "express";

import { requireAdmin, requireSuperAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createAdminController } from "./admin.controller";
import { createAdminService, type AdminServiceDeps } from "./admin.service";
import {
  adminStatusBodySchema,
  allocateTeacherBodySchema,
  batchStatusBodySchema,
  enrollmentStatusBodySchema,
  createAdminBodySchema,
  createBatchBodySchema,
  createEnrollmentAdminBodySchema,
  createRoleBodySchema,
  createStudentAdminBodySchema,
  createTeacherAdminBodySchema,
  updateTeacherAdminBodySchema,
  teacherStatusBodySchema,
  financialOverrideDecisionBodySchema,
  instituteSettingsBodySchema,
  maintenanceBodySchema,
  refundDecisionBodySchema,
  testEmailBodySchema,
  updateAdminBodySchema,
  updateBatchBodySchema,
  updateRolePermissionsBodySchema,
  placementRateQuerySchema,
} from "./admin.validation";

export interface AdminRoutesOptions extends AdminServiceDeps {
  authenticate?: RequestHandler;
}

export const createAdminRoutes = (options: AdminRoutesOptions): Router => {
  const service = createAdminService(options);
  const controller = createAdminController(service);
  const router = Router();

  const guards: RequestHandler[] =
    options.authenticate === undefined
      ? [requireAdmin]
      : [options.authenticate, requireAdmin];

  // Dashboard stats
  router.get("/dashboard/stats", ...guards, controller.getDashboardStats);
  router.get("/stats", ...guards, controller.getDashboardStats);
  router.get("/dashboard/placement-rate", ...guards, validate({ query: placementRateQuerySchema }), controller.getPlacementRate);

  // Batches
  router.get("/batches", ...guards, controller.getBatches);
  router.get("/batches/:batchId", ...guards, controller.getBatchById);
  router.post(
    "/batches",
    ...guards,
    validate({ body: createBatchBodySchema }),
    controller.createBatch,
  );
  router.put(
    "/batches/:batchId",
    ...guards,
    validate({ body: updateBatchBodySchema }),
    controller.updateBatch,
  );
  router.patch(
    "/batches/:batchId/status",
    ...guards,
    validate({ body: batchStatusBodySchema }),
    controller.setBatchStatus,
  );
  router.post(
    "/batches/:batchId/allocate",
    ...guards,
    validate({ body: allocateTeacherBodySchema }),
    controller.allocateTeacher,
  );
  router.post(
    "/batches/:batchId/allocations",
    ...guards,
    validate({ body: allocateTeacherBodySchema }),
    controller.allocateTeacher,
  );
  router.delete(
    "/batches/:batchId/allocate/:teacherId",
    ...guards,
    controller.unallocateTeacher,
  );
  router.delete(
    "/batches/:batchId/allocations/:teacherId",
    ...guards,
    controller.unallocateTeacher,
  );
  router.get("/batches/:batchId/students", ...guards, controller.getBatchStudents);

  // Enrollments
  router.get("/enrollments", ...guards, controller.getEnrollments);
  router.post(
    "/enrollments",
    ...guards,
    validate({ body: createEnrollmentAdminBodySchema }),
    controller.createEnrollment,
  );
  router.patch(
    "/enrollments/:enrollmentId/status",
    ...guards,
    validate({ body: enrollmentStatusBodySchema }),
    controller.setEnrollmentStatus,
  );

  // Teachers management
  router.get("/teachers", ...guards, controller.getTeachers);
  router.post(
    "/teachers",
    ...guards,
    validate({ body: createTeacherAdminBodySchema }),
    controller.createTeacher,
  );
  router.put(
    "/teachers/:teacherId",
    ...guards,
    validate({ body: updateTeacherAdminBodySchema }),
    controller.updateTeacher,
  );
  router.patch(
    "/teachers/:teacherId/status",
    ...guards,
    validate({ body: teacherStatusBodySchema }),
    controller.setTeacherStatus,
  );

  // Student accounts (ADM-003). Listing, approval and status stay on /students.
  router.post(
    "/students",
    ...guards,
    validate({ body: createStudentAdminBodySchema }),
    controller.createStudent,
  );

  // Settings & Activity Logs
  router.get("/settings", ...guards, controller.getInstituteSettings);
  router.get("/settings/catalog", ...guards, controller.getSettingsCatalog);
  router.put(
    "/settings",
    ...guards,
    validate({ body: instituteSettingsBodySchema }),
    controller.saveInstituteSettings,
  );
  router.get("/activity-logs", ...guards, controller.getAuditLogs);

  // Account unlock
  router.post("/users/:userId/unlock", ...guards, controller.unlockAccount);
  router.post("/students/:userId/unlock", ...guards, controller.unlockAccount);

  return router;
};

export const createSuperAdminRoutes = (options: AdminRoutesOptions): Router => {
  const service = createAdminService(options);
  const controller = createAdminController(service);
  const router = Router();

  const guards: RequestHandler[] =
    options.authenticate === undefined
      ? [requireSuperAdmin]
      : [options.authenticate, requireSuperAdmin];

  // Super Admin Dashboard stats
  router.get("/dashboard/stats", ...guards, controller.getSuperAdminDashboardStats);
  router.get("/stats", ...guards, controller.getSuperAdminDashboardStats);

  // Admin Account Management
  router.get("/admins", ...guards, controller.getAdmins);
  router.get("/admins/:adminId", ...guards, controller.getAdminById);
  router.post(
    "/admins",
    ...guards,
    validate({ body: createAdminBodySchema }),
    controller.createAdmin,
  );
  router.put(
    "/admins/:adminId",
    ...guards,
    validate({ body: updateAdminBodySchema }),
    controller.updateAdmin,
  );
  router.patch(
    "/admins/:adminId/status",
    ...guards,
    validate({ body: adminStatusBodySchema }),
    controller.setAdminStatus,
  );
  router.post("/admins/:adminId/reset-password", ...guards, controller.resetAdminPassword);

  // Roles & Permissions
  router.get("/roles", ...guards, controller.getRoles);
  router.post(
    "/roles",
    ...guards,
    validate({ body: createRoleBodySchema }),
    controller.createRole,
  );
  router.put(
    "/roles/:roleId/permissions",
    ...guards,
    validate({ body: updateRolePermissionsBodySchema }),
    controller.updateRolePermissions,
  );

  // System Configuration
  router.get("/config", ...guards, controller.getSystemConfig);
  router.get("/system-config", ...guards, controller.getSystemConfig);
  // CFG-20: maintenance mode (Super Admin only; enforced by the maintenance guard).
  router.get("/maintenance", ...guards, controller.getMaintenance);
  router.put("/maintenance", ...guards, validate({ body: maintenanceBodySchema }), controller.setMaintenance);
  router.put("/config", ...guards, controller.saveSystemConfig);
  router.put("/system-config", ...guards, controller.saveSystemConfig);
  router.post("/config/test-email", ...guards, validate({ body: testEmailBodySchema }), controller.testEmailConfiguration);
  router.post(
    "/system-config/test-email",
    ...guards,
    validate({ body: testEmailBodySchema }),
    controller.testEmailConfiguration,
  );

  // Audit Logs
  router.get("/audit-logs", ...guards, controller.getAuditLogs);

  // Refunds
  router.get("/refunds", ...guards, controller.getRefunds);
  router.post(
    "/refunds/:refundId/decide",
    ...guards,
    validate({ body: refundDecisionBodySchema }),
    controller.decideRefund,
  );
  router.post(
    "/refunds/:refundId/approve",
    ...guards,
    asDecision("approved"),
    validate({ body: refundDecisionBodySchema }),
    controller.decideRefund,
  );
  router.post(
    "/refunds/:refundId/reject",
    ...guards,
    asDecision("rejected"),
    validate({ body: refundDecisionBodySchema }),
    controller.decideRefund,
  );

  // Financial Overrides
  router.get("/financial-overrides", ...guards, controller.getFinancialOverrides);
  router.post(
    "/financial-overrides/:overrideId/decide",
    ...guards,
    validate({ body: financialOverrideDecisionBodySchema }),
    controller.decideFinancialOverride,
  );
  router.post(
    "/financial-overrides/:overrideId/approve",
    ...guards,
    asDecision("approved"),
    validate({ body: financialOverrideDecisionBodySchema }),
    controller.decideFinancialOverride,
  );
  router.post(
    "/financial-overrides/:overrideId/reject",
    ...guards,
    asDecision("rejected"),
    validate({ body: financialOverrideDecisionBodySchema }),
    controller.decideFinancialOverride,
  );

  return router;
};

/**
 * Normalises the approve/reject alias bodies into the `{status, remarks}`
 * decision shape so they go through the same validation as `/decide`
 * (including the mandatory rejection reason). The UI sends the rejection
 * reason as `mandatoryReason`.
 */
const asDecision =
  (status: "approved" | "rejected"): RequestHandler =>
  (req, _res, next) => {
    const body = (req.body ?? {}) as { remarks?: unknown; mandatoryReason?: unknown };
    const remarks = body.mandatoryReason ?? body.remarks;
    req.body = remarks === undefined ? { status } : { status, remarks };
    next();
  };
