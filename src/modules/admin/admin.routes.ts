import { Router, type RequestHandler } from "express";

import { requireAdmin, requireSuperAdmin } from "../../middleware/authorize.middleware";
import { validate } from "../../middleware/validate.middleware";
import { createAdminController } from "./admin.controller";
import { createAdminService, type AdminServiceDeps } from "./admin.service";
import {
  adminStatusBodySchema,
  allocateTeacherBodySchema,
  createAdminBodySchema,
  createBatchBodySchema,
  createEnrollmentAdminBodySchema,
  createRoleBodySchema,
  createTeacherAdminBodySchema,
  financialOverrideDecisionBodySchema,
  instituteSettingsBodySchema,
  refundDecisionBodySchema,
  updateAdminBodySchema,
  updateBatchBodySchema,
  updateRolePermissionsBodySchema,
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
  router.patch("/batches/:batchId/status", ...guards, controller.setBatchStatus);
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
  router.patch("/enrollments/:enrollmentId/status", ...guards, controller.setEnrollmentStatus);

  // Teachers management
  router.get("/teachers", ...guards, controller.getTeachers);
  router.post(
    "/teachers",
    ...guards,
    validate({ body: createTeacherAdminBodySchema }),
    controller.createTeacher,
  );

  // Settings & Activity Logs
  router.get("/settings", ...guards, controller.getInstituteSettings);
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
  router.put("/config", ...guards, controller.saveSystemConfig);
  router.put("/system-config", ...guards, controller.saveSystemConfig);
  router.post("/config/test-email", ...guards, controller.testEmailConfiguration);
  router.post("/system-config/test-email", ...guards, controller.testEmailConfiguration);

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
  router.post("/refunds/:refundId/approve", ...guards, async (req, res) => {
    req.body = { status: "approved", remarks: req.body?.remarks || "" };
    return controller.decideRefund(req, res);
  });
  router.post("/refunds/:refundId/reject", ...guards, async (req, res) => {
    req.body = { status: "rejected", remarks: req.body?.mandatoryReason || req.body?.remarks || "" };
    return controller.decideRefund(req, res);
  });

  // Financial Overrides
  router.get("/financial-overrides", ...guards, controller.getFinancialOverrides);
  router.post(
    "/financial-overrides/:overrideId/decide",
    ...guards,
    validate({ body: financialOverrideDecisionBodySchema }),
    controller.decideFinancialOverride,
  );
  router.post("/financial-overrides/:overrideId/approve", ...guards, async (req, res) => {
    req.body = { status: "approved", remarks: req.body?.remarks || "" };
    return controller.decideFinancialOverride(req, res);
  });
  router.post("/financial-overrides/:overrideId/reject", ...guards, async (req, res) => {
    req.body = { status: "rejected", remarks: req.body?.mandatoryReason || req.body?.remarks || "" };
    return controller.decideFinancialOverride(req, res);
  });

  return router;
};
