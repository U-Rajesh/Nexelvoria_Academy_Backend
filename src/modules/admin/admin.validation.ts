import { z } from "zod";

import { MOBILE_PATTERN } from "../auth/auth.validation";

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

/**
 * Entity identifier. Kept storage-agnostic here; the SQL Server adapter treats
 * a non-numeric id as "not found" for its BIGINT keys.
 */
const dbId = z.string().trim().min(1).max(40);
/** Calendar date, YYYY-MM-DD. */
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const BATCH_STATUSES = ["upcoming", "ongoing", "completed", "cancelled"] as const;
export type BatchStatusValue = (typeof BATCH_STATUSES)[number];

const endNotBeforeStart = (v: { startDate?: string | undefined; endDate?: string | undefined }) =>
  !v.startDate || !v.endDate || v.endDate >= v.startDate;
const endDateIssue = { message: "End date cannot be before start date", path: ["endDate"] };

export const createBatchBodySchema = z
  .object({
    courseId: dbId,
    batchCode: z.string().trim().min(2).max(40),
    batchName: z.string().trim().min(2).max(150),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    capacity: z.coerce.number().int().min(1).max(1000).optional(),
    scheduleDescription: z.string().trim().max(500).optional(),
  })
  .refine(endNotBeforeStart, endDateIssue);

export type CreateBatchBody = z.infer<typeof createBatchBodySchema>;

export const updateBatchBodySchema = z
  .object({
    batchName: z.string().trim().min(2).max(150).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    capacity: z.coerce.number().int().min(1).max(1000).optional(),
    scheduleDescription: z.string().trim().max(500).optional(),
  })
  .refine(endNotBeforeStart, endDateIssue);

export type UpdateBatchBody = z.infer<typeof updateBatchBodySchema>;

export const batchStatusBodySchema = z.object({
  status: z.enum(BATCH_STATUSES),
});

/**
 * Approved decision: an allocation is always the triple (course, batch,
 * teacher). Course-only allocation is not permitted, and the batch (from the
 * URL) must belong to `courseId`.
 */
export const allocateTeacherBodySchema = z.object({
  teacherUserId: dbId,
  courseId: dbId,
});

export type AllocateTeacherBody = z.infer<typeof allocateTeacherBodySchema>;

/**
 * Admin enrollment. Price is always taken from the course on the server. A
 * discount can only be one the institute has defined (PAY-009 / ADM-010),
 * identified by its code and validated server-side; free-typed amounts are not
 * accepted. Creating an ACTIVE enrollment without payment is an authorized
 * free override (PAY-010, BR-004) and requires a reason, which is audited
 * (BR-017).
 */
export const createEnrollmentAdminBodySchema = z
  .object({
    studentUserId: dbId,
    courseId: dbId,
    batchId: dbId.optional(),
    discountCode: z.string().trim().min(1).max(100).optional(),
    freeAccessOverride: z.boolean().optional(),
    overrideReason: z.string().trim().min(10).max(500).optional(),
    /** D6: required to enroll into a batch that is already at capacity (audited). */
    capacityOverrideReason: z.string().trim().min(10).max(500).optional(),
    /** D4: required when a prerequisite course is not completed (audited). */
    prerequisiteOverrideReason: z.string().trim().min(10).max(500).optional(),
  })
  .refine((v) => !v.freeAccessOverride || !!v.overrideReason, {
    message: "A reason of at least 10 characters is required for a free access override",
    path: ["overrideReason"],
  })
  // Free access already waives the whole fee; a discount code on top would be
  // recorded as a second, meaningless concession.
  .refine((v) => !v.freeAccessOverride || !v.discountCode, {
    message: "A discount code cannot be combined with a free access override",
    path: ["discountCode"],
  });

export type CreateEnrollmentAdminBody = z.infer<typeof createEnrollmentAdminBodySchema>;

export const ENROLLMENT_STATUSES = [
  "pending_approval",
  "approved_unpaid",
  "active",
  "completed",
  "cancelled",
  "suspended",
] as const;

export const enrollmentStatusBodySchema = z.object({
  status: z.enum(ENROLLMENT_STATUSES),
  /** Required when the change grants access without a verified payment. */
  reason: z.string().trim().min(10).max(500).optional(),
});

export type EnrollmentStatusBody = z.infer<typeof enrollmentStatusBodySchema>;

export const auditLogQuerySchema = z.object({
  actorUserId: z.string().trim().optional(),
  moduleCode: z.string().trim().optional(),
  startDate: z.string().trim().optional(),
  endDate: z.string().trim().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

/** Indian GSTIN: 2-digit state code, PAN (5 letters, 4 digits, 1 letter), entity number, 'Z', check character. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const phone = z.union([z.literal(""), z.string().trim().regex(/^\+?[0-9 ()-]{7,25}$/, "Enter a valid phone number.")]);

/**
 * Institute settings. An empty string clears an optional value. Unknown keys
 * are refused (.strict). timezone, minAttendancePercentage, isSmsEnabled and
 * currencySymbol are accepted by the schema only so the service can refuse
 * them with the decision they wait on (settings-catalog.ts).
 */
export const instituteSettingsBodySchema = z
  .object({
    instituteName: z.string().trim().min(2).max(150).optional(),
    tagline: z.string().trim().max(200).optional(),
    supportEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(254)]).optional(),
    supportPhone: phone.optional(),
    whatsappNumber: phone.optional(),
    address: z.string().trim().max(500).optional(),
    timezone: z.string().trim().max(50).optional(),
    // D1: BR-011 floors may be raised, never lowered.
    minAttendancePercentage: z.coerce.number().min(75, "The minimum attendance cannot be below BR-011's 75%.").max(100).optional(),
    minExamPercentage: z.coerce.number().min(60, "The minimum examination score cannot be below BR-011's 60%.").max(100).optional(),
    // D9: defaults for newly created lessons.
    defaultLessonSequentialUnlock: z.boolean().optional(),
    defaultLessonDownloadAllowed: z.boolean().optional(),
    // D7: lockout threshold.
    maxFailedLoginAttempts: z.coerce.number().int("Enter a whole number.").min(3).max(10).optional(),
    isSmsEnabled: z.boolean().optional(),
    currencySymbol: z.string().trim().max(10).optional(),
    gstNumber: z
      .union([z.literal(""), z.string().trim().toUpperCase().regex(GSTIN_PATTERN, "Enter a valid 15-character GSTIN, e.g. 36AABCU9603R1ZM.")])
      .optional(),
  })
  .strict();

export const maintenanceBodySchema = z
  .object({
    enabled: z.boolean(),
    message: z.string().trim().max(300).optional(),
  })
  .strict();
export type MaintenanceBody = z.infer<typeof maintenanceBodySchema>;

export type InstituteSettingsBody = z.infer<typeof instituteSettingsBodySchema>;

export const testEmailBodySchema = z.object({
  recipientEmail: z.string().trim().toLowerCase().email().max(254),
});

export type TestEmailBody = z.infer<typeof testEmailBodySchema>;

/** A rejection must say why (shown to the requester and kept in the audit trail). */
const MIN_REJECTION_REASON = 10;

const decisionBodySchema = z
  .object({
    status: z.enum(["approved", "rejected"]),
    remarks: z.string().trim().max(500).optional(),
  })
  .refine((b) => b.status !== "rejected" || (b.remarks?.length ?? 0) >= MIN_REJECTION_REASON, {
    path: ["remarks"],
    message: `A rejection reason of at least ${MIN_REJECTION_REASON} characters is required`,
  });

export const refundDecisionBodySchema = decisionBodySchema;

export type RefundDecisionBody = z.infer<typeof refundDecisionBodySchema>;

export const financialOverrideDecisionBodySchema = decisionBodySchema;

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

/**
 * Admin teacher edit. Email and mobile are sign-in identifiers, so they are
 * not changed here. NXA_Users.FullName nvarchar(150); NXA_TeacherProfiles
 * Specialization / Qualification nvarchar(200), ExperienceYears decimal.
 */
export const updateTeacherAdminBodySchema = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    specialization: z.union([z.string().trim().max(200), z.null()]).optional(),
    experienceYears: z.number().min(0).max(100).optional(),
    qualifications: z.union([z.string().trim().max(200), z.null()]).optional(),
    bio: z.union([z.string().trim().max(4000), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to change" });

export type UpdateTeacherAdminBody = z.infer<typeof updateTeacherAdminBodySchema>;

/** Activation / deactivation uses the existing account statuses. */
export const teacherStatusBodySchema = z
  .object({
    status: z.enum(["active", "deactivated"]),
    reason: z.string().trim().min(5).max(500).optional(),
  })
  .strict();

export type TeacherStatusBody = z.infer<typeof teacherStatusBodySchema>;

/**
 * Admin-created student (ADM-003). Identity rules match self-registration
 * (auth.validation.ts) so the student can later sign in with the same email
 * or mobile. No password is accepted: a one-time temporary password is
 * generated server-side.
 */
export const createStudentAdminBodySchema = z.object({
  name: z.string().trim().min(3).max(150),
  email: z.string().trim().toLowerCase().email().max(254),
  mobile: z.string().trim().regex(MOBILE_PATTERN, "Enter a valid 10-digit Indian mobile number"),
  collegeName: z.string().trim().min(2).max(200).optional(),
  degree: z.string().trim().min(1).max(100).optional(),
  branch: z.string().trim().min(1).max(100).optional(),
  passingYear: z.coerce.number().int().min(1990).max(2040).optional(),
  interestedCourseId: dbId.optional(),
  dateOfBirth: isoDate.optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  state: z.string().trim().min(1).max(100).optional(),
});

export type CreateStudentAdminBody = z.infer<typeof createStudentAdminBodySchema>;

/** D15: placement-rate period, inclusive IST calendar dates. */
export const placementRateQuerySchema = z
  .object({
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  })
  .strict();
