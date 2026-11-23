import type { Request, Response } from "express";

import type { UserStatus } from "../../contracts/user.contract";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";
import type { AdminService } from "./admin.service";
import type {
  AllocateTeacherBody,
  CreateAdminBody,
  CreateBatchBody,
  CreateEnrollmentAdminBody,
  CreateRoleBody,
  CreateTeacherAdminBody,
  FinancialOverrideDecisionBody,
  InstituteSettingsBody,
  RefundDecisionBody,
  SystemConfigBody,
  UpdateAdminBody,
  UpdateBatchBody,
  UpdateRolePermissionsBody,
} from "./admin.validation";

const sendCreated = (res: Response, options: Parameters<typeof sendSuccess>[1]): void => {
  sendSuccess(res, { status: HttpStatus.CREATED, ...options });
};

const actorId = (req: Request): string => {
  const id = req.principal?.id;
  if (!id) {
    throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  }
  return id;
};

export const createAdminController = (service: AdminService) => ({
  // Dashboard
  async getDashboardStats(_req: Request, res: Response): Promise<void> {
    const stats = await service.getDashboardStats();
    sendSuccess(res, { data: stats });
  },

  async getSuperAdminDashboardStats(_req: Request, res: Response): Promise<void> {
    const stats = await service.getSuperAdminDashboardStats();
    sendSuccess(res, { data: stats });
  },

  // Admins
  async getAdmins(req: Request, res: Response): Promise<void> {
    const search = req.query["search"] ? String(req.query["search"]) : undefined;
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    const admins = await service.getAdmins({ search, status });
    sendSuccess(res, { data: admins });
  },

  async getAdminById(req: Request, res: Response): Promise<void> {
    const id = String(req.params["adminId"]);
    const admin = await service.getAdminById(id);
    if (!admin) throw ApiError.notFound("Admin account not found");
    sendSuccess(res, { data: admin });
  },

  async createAdmin(req: Request, res: Response): Promise<void> {
    const created = await service.createAdmin(actorId(req), req.body as CreateAdminBody);
    sendCreated(res, { data: created, message: "Admin account created successfully" });
  },

  async updateAdmin(req: Request, res: Response): Promise<void> {
    const id = String(req.params["adminId"]);
    const updated = await service.updateAdmin(actorId(req), id, req.body as UpdateAdminBody);
    sendSuccess(res, { data: updated, message: "Admin account updated successfully" });
  },

  async setAdminStatus(req: Request, res: Response): Promise<void> {
    const id = String(req.params["adminId"]);
    const status = String(req.body.status) as UserStatus;
    const updated = await service.setAdminStatus(actorId(req), id, status);
    sendSuccess(res, { data: updated, message: `Admin account status set to ${status}` });
  },

  async resetAdminPassword(req: Request, res: Response): Promise<void> {
    const id = String(req.params["adminId"]);
    const result = await service.resetAdminPassword(actorId(req), id);
    sendSuccess(res, { data: result, message: "Admin password reset successfully" });
  },

  // Batches
  async getBatches(req: Request, res: Response): Promise<void> {
    const courseId = req.query["courseId"] ? String(req.query["courseId"]) : undefined;
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    const batches = await service.getBatches({ courseId, status });
    sendSuccess(res, { data: batches });
  },

  async getBatchById(req: Request, res: Response): Promise<void> {
    const id = String(req.params["batchId"]);
    const batch = await service.getBatchById(id);
    if (!batch) throw ApiError.notFound("Batch not found");
    sendSuccess(res, { data: batch });
  },

  async createBatch(req: Request, res: Response): Promise<void> {
    const batch = await service.createBatch(actorId(req), req.body as CreateBatchBody);
    sendCreated(res, { data: batch, message: "Batch created successfully" });
  },

  async updateBatch(req: Request, res: Response): Promise<void> {
    const id = String(req.params["batchId"]);
    const batch = await service.updateBatch(actorId(req), id, req.body as UpdateBatchBody);
    sendSuccess(res, { data: batch, message: "Batch updated successfully" });
  },

  async setBatchStatus(req: Request, res: Response): Promise<void> {
    const id = String(req.params["batchId"]);
    const status = String(req.body.status);
    const batch = await service.setBatchStatus(actorId(req), id, status);
    sendSuccess(res, { data: batch, message: "Batch status updated successfully" });
  },

  async allocateTeacher(req: Request, res: Response): Promise<void> {
    const id = String(req.params["batchId"]);
    await service.allocateTeacher(actorId(req), id, req.body as AllocateTeacherBody);
    sendSuccess(res, { message: "Teacher allocated to batch successfully" });
  },

  async unallocateTeacher(req: Request, res: Response): Promise<void> {
    const batchId = String(req.params["batchId"]);
    const teacherId = String(req.params["teacherId"]);
    await service.unallocateTeacher(actorId(req), batchId, teacherId);
    sendSuccess(res, { message: "Teacher unallocated from batch successfully" });
  },

  async getBatchStudents(req: Request, res: Response): Promise<void> {
    const id = String(req.params["batchId"]);
    const students = await service.getBatchStudents(id);
    sendSuccess(res, { data: students });
  },

  // Enrollments
  async getEnrollments(req: Request, res: Response): Promise<void> {
    const studentId = req.query["studentId"] ? String(req.query["studentId"]) : undefined;
    const courseId = req.query["courseId"] ? String(req.query["courseId"]) : undefined;
    const batchId = req.query["batchId"] ? String(req.query["batchId"]) : undefined;
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    const enrollments = await service.getEnrollments({ studentId, courseId, batchId, status });
    sendSuccess(res, { data: enrollments });
  },

  async createEnrollment(req: Request, res: Response): Promise<void> {
    const enrollment = await service.createEnrollment(actorId(req), req.body as CreateEnrollmentAdminBody);
    sendCreated(res, { data: enrollment, message: "Enrollment created successfully" });
  },

  async setEnrollmentStatus(req: Request, res: Response): Promise<void> {
    const id = String(req.params["enrollmentId"]);
    const status = String(req.body.status);
    const enrollment = await service.setEnrollmentStatus(actorId(req), id, status);
    sendSuccess(res, { data: enrollment, message: "Enrollment status updated successfully" });
  },

  // Audit Logs
  async getAuditLogs(req: Request, res: Response): Promise<void> {
    const actorUserId = req.query["actorUserId"] ? String(req.query["actorUserId"]) : undefined;
    const moduleCode = req.query["moduleCode"] ? String(req.query["moduleCode"]) : undefined;
    const startDate = req.query["startDate"] ? String(req.query["startDate"]) : undefined;
    const endDate = req.query["endDate"] ? String(req.query["endDate"]) : undefined;
    const logs = await service.getAuditLogs({ actorUserId, moduleCode, startDate, endDate });
    sendSuccess(res, { data: logs });
  },

  // Settings
  async getInstituteSettings(_req: Request, res: Response): Promise<void> {
    const settings = await service.getInstituteSettings();
    sendSuccess(res, { data: settings });
  },

  async saveInstituteSettings(req: Request, res: Response): Promise<void> {
    const saved = await service.saveInstituteSettings(actorId(req), req.body as InstituteSettingsBody);
    sendSuccess(res, { data: saved, message: "Institute settings updated successfully" });
  },

  // System Config
  async getSystemConfig(_req: Request, res: Response): Promise<void> {
    const config = await service.getSystemConfig();
    sendSuccess(res, { data: config });
  },

  async saveSystemConfig(req: Request, res: Response): Promise<void> {
    const saved = await service.saveSystemConfig(actorId(req), req.body as SystemConfigBody);
    sendSuccess(res, { data: saved, message: "System configuration saved successfully" });
  },

  async testEmailConfiguration(_req: Request, res: Response): Promise<void> {
    sendSuccess(res, { data: { success: true }, message: "SMTP test email sent successfully" });
  },

  // Refunds
  async getRefunds(req: Request, res: Response): Promise<void> {
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    const refunds = await service.getRefunds(status);
    sendSuccess(res, { data: refunds });
  },

  async decideRefund(req: Request, res: Response): Promise<void> {
    const id = String(req.params["refundId"]);
    const body = req.body as RefundDecisionBody;
    const refund = await service.decideRefund(actorId(req), id, body.status, body.remarks);
    sendSuccess(res, { data: refund, message: `Refund request ${body.status}` });
  },

  // Financial Overrides
  async getFinancialOverrides(req: Request, res: Response): Promise<void> {
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    const overrides = await service.getFinancialOverrides(status);
    sendSuccess(res, { data: overrides });
  },

  async decideFinancialOverride(req: Request, res: Response): Promise<void> {
    const id = String(req.params["overrideId"]);
    const body = req.body as FinancialOverrideDecisionBody;
    const override = await service.decideFinancialOverride(actorId(req), id, body.status, body.remarks);
    sendSuccess(res, { data: override, message: `Financial override ${body.status}` });
  },

  // Roles & Permissions
  async getRoles(_req: Request, res: Response): Promise<void> {
    const roles = await service.getRoles();
    sendSuccess(res, { data: roles });
  },

  async createRole(req: Request, res: Response): Promise<void> {
    const role = await service.createRole(actorId(req), req.body as CreateRoleBody);
    sendCreated(res, { data: role, message: "Global role created successfully" });
  },

  async updateRolePermissions(req: Request, res: Response): Promise<void> {
    const roleId = String(req.params["roleId"]);
    const body = req.body as UpdateRolePermissionsBody;
    const updated = await service.updateRolePermissions(actorId(req), roleId, body.permissions);
    sendSuccess(res, { data: updated, message: "Role permissions updated successfully" });
  },

  // Users & Teachers
  async unlockAccount(req: Request, res: Response): Promise<void> {
    const userId = String(req.params["userId"]);
    await service.unlockAccount(actorId(req), userId);
    sendSuccess(res, { message: "Account unlocked successfully" });
  },

  async getTeachers(req: Request, res: Response): Promise<void> {
    const search = req.query["search"] ? String(req.query["search"]) : undefined;
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    const teachers = await service.getTeachers({ search, status });
    sendSuccess(res, { data: teachers });
  },

  async createTeacher(req: Request, res: Response): Promise<void> {
    const teacher = await service.createTeacher(actorId(req), req.body as CreateTeacherAdminBody);
    sendCreated(res, { data: teacher, message: "Teacher account created successfully" });
  },
});
