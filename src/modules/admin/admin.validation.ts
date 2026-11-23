import { z } from "zod";

export const createAdminBodySchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email(),
  mobile: z.string().trim().min(10).max(20),
  department: z.string().trim().max(100).optional(),
  permissions: z.array(z.string().trim()).optional(),
  adminLevel: z.string().trim().max(20).optional(),
  employeeCode: z.string().trim().max(40).optional(),
});

export type CreateAdminBody = z.infer<typeof createAdminBodySchema>;

export const updateAdminBodySchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  mobile: z.string().trim().min(10).max(20).optional(),
  department: z.string().trim().max(100).optional(),
  permissions: z.array(z.string().trim()).optional(),
});

export type UpdateAdminBody = z.infer<typeof updateAdminBodySchema>;

export const adminStatusBodySchema = z.object({
  status: z.enum(["active", "pending", "suspended", "deactivated"]),
});

export type AdminStatusBody = z.infer<typeof adminStatusBodySchema>;

export const createBatchBodySchema = z.object({
  courseId: z.string().trim().min(1),
  batchCode: z.string().trim().min(2).max(40),
  batchName: z.string().trim().min(2).max(150),
  startDate: z.string().trim().optional(),
  endDate: z.string().trim().optional(),
  capacity: z.coerce.number().min(1).max(1000).optional(),
  scheduleDescription: z.string().trim().max(500).optional(),
});

export type CreateBatchBody = z.infer<typeof createBatchBodySchema>;

export const updateBatchBodySchema = z.object({
  batchName: z.string().trim().min(2).max(150).optional(),
  startDate: z.string().trim().optional(),
  endDate: z.string().trim().optional(),
  capacity: z.coerce.number().min(1).max(1000).optional(),
  scheduleDescription: z.string().trim().max(500).optional(),
  status: z.string().trim().optional(),
});

export type UpdateBatchBody = z.infer<typeof updateBatchBodySchema>;

export const allocateTeacherBodySchema = z.object({
  teacherUserId: z.string().trim().min(1),
  courseId: z.string().trim().optional(),
});

export type AllocateTeacherBody = z.infer<typeof allocateTeacherBodySchema>;

export const createEnrollmentAdminBodySchema = z.object({
  studentUserId: z.string().trim().min(1),
  courseId: z.string().trim().min(1),
  batchId: z.string().trim().optional(),
  coursePrice: z.coerce.number().min(0).optional(),
  discountAmount: z.coerce.number().min(0).optional(),
  finalAmount: z.coerce.number().min(0).optional(),
  currencyCode: z.string().trim().default("INR"),
});

export type CreateEnrollmentAdminBody = z.infer<typeof createEnrollmentAdminBodySchema>;

export const auditLogQuerySchema = z.object({
  actorUserId: z.string().trim().optional(),
  moduleCode: z.string().trim().optional(),
  startDate: z.string().trim().optional(),
  endDate: z.string().trim().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const instituteSettingsBodySchema = z.object({
  instituteName: z.string().trim().min(2).max(150).optional(),
  tagline: z.string().trim().max(200).optional(),
  supportEmail: z.string().trim().email().optional(),
  supportPhone: z.string().trim().max(25).optional(),
  whatsappNumber: z.string().trim().max(25).optional(),
  address: z.string().trim().max(500).optional(),
  timezone: z.string().trim().max(50).optional(),
  minAttendancePercentage: z.coerce.number().min(0).max(100).optional(),
  isSmsEnabled: z.boolean().optional(),
  currencySymbol: z.string().trim().max(10).optional(),
  gstNumber: z.string().trim().max(30).optional(),
});

export type InstituteSettingsBody = z.infer<typeof instituteSettingsBodySchema>;

export const systemConfigBodySchema = z.record(z.string(), z.unknown());

export type SystemConfigBody = z.infer<typeof systemConfigBodySchema>;

export const refundDecisionBodySchema = z.object({
  status: z.enum(["approved", "rejected"]),
  remarks: z.string().trim().max(500).optional(),
});

export type RefundDecisionBody = z.infer<typeof refundDecisionBodySchema>;

export const financialOverrideDecisionBodySchema = z.object({
  status: z.enum(["approved", "rejected"]),
  remarks: z.string().trim().max(500).optional(),
});

export type FinancialOverrideDecisionBody = z.infer<typeof financialOverrideDecisionBodySchema>;

export const createRoleBodySchema = z.object({
  roleCode: z.string().trim().min(2).max(40),
  roleName: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).default(""),
  permissions: z.array(z.string().trim()).default([]),
});

export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;

export const updateRolePermissionsBodySchema = z.object({
  permissions: z.array(z.string().trim()),
});

export type UpdateRolePermissionsBody = z.infer<typeof updateRolePermissionsBodySchema>;

export const createTeacherAdminBodySchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email(),
  mobile: z.string().trim().min(10).max(20),
  specialization: z.string().trim().max(200).optional(),
  experienceYears: z.coerce.number().min(0).max(100).optional(),
  qualifications: z.string().trim().max(200).optional(),
  bio: z.string().trim().max(4000).optional(),
});

export type CreateTeacherAdminBody = z.infer<typeof createTeacherAdminBodySchema>;
