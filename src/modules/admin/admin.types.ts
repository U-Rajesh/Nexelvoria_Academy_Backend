import type { UserRole, UserStatus } from "../../contracts/user.contract";

export interface AdminProfile {
  id: string;
  userId: string;
  name: string;
  email: string;
  mobile: string;
  role: UserRole;
  status: UserStatus;
  department: string;
  permissions: string[];
  employeeCode?: string | undefined;
  adminLevel?: string | undefined;
  lastLoginIp?: string | undefined;
  createdAt: string;
}

export interface SuperAdminProfile extends AdminProfile {
  isPrimaryOwner: boolean;
  canOverrideFinancials: boolean;
}

export interface BatchRecord {
  id: string;
  courseId: string;
  courseName?: string | undefined;
  batchCode: string;
  batchName: string;
  startDate?: string | undefined;
  endDate?: string | undefined;
  capacity?: number | undefined;
  scheduleDescription?: string | undefined;
  status: string;
  timeZoneId?: string | undefined;
  currentEnrollments?: number | undefined;
  allocatedTeacherIds?: string[] | undefined;
  allocatedTeacherNames?: string[] | undefined;
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface EnrollmentAdminRecord {
  id: string;
  studentUserId: string;
  studentName?: string | undefined;
  studentEmail?: string | undefined;
  courseId: string;
  courseTitle?: string | undefined;
  batchId?: string | undefined;
  batchCode?: string | undefined;
  enrollmentNumber: string;
  enrollmentStatus: string;
  coursePrice: number;
  discountAmount: number;
  finalAmount: number;
  currencyCode: string;
  enrollmentSource: string;
  activatedAt?: string | undefined;
  completedAt?: string | undefined;
  createdAt: string;
}

export interface AuditLogRecord {
  id: string;
  timestamp: string;
  actorUserId: string;
  actorName?: string | undefined;
  actorRole?: string | undefined;
  actionType: string;
  moduleCode: string;
  entityName: string;
  entityId: string;
  oldValues?: string | undefined;
  newValues?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
  details?: string | undefined;
}

/**
 * Institute settings as stored in NXA_InstituteSettings. A field the institute
 * has never saved is absent - no placeholder values are invented.
 */
export interface InstituteSettingsRecord {
  instituteName?: string | undefined;
  tagline?: string | undefined;
  supportEmail?: string | undefined;
  supportPhone?: string | undefined;
  whatsappNumber?: string | undefined;
  address?: string | undefined;
  /** Institute time zone; Asia/Kolkata unless explicitly saved otherwise. */
  timezone: string;
  minAttendancePercentage?: number | undefined;
  /** D1 / D9: stored, floor 60. */
  minExamPercentage?: number | undefined;
  /** D9: starting values for newly created lessons. */
  defaultLessonSequentialUnlock?: boolean | undefined;
  defaultLessonDownloadAllowed?: boolean | undefined;
  /** D7: lockout threshold, 3-10. */
  maxFailedLoginAttempts?: number | undefined;
  isSmsEnabled?: boolean | undefined;
  currencySymbol?: string | undefined;
  gstNumber?: string | undefined;
  /** CFG-20: enforced by the maintenance guard (Super Admin only). */
  maintenanceMode?: boolean | undefined;
  maintenanceMessage?: string | undefined;
  updatedAt?: string | undefined;
}

export type { SystemConfigStatus } from "./system-config";

export interface RefundRecord {
  id: string;
  refundReference: string;
  transactionId?: string | undefined;
  requestedByUserId: string;
  requestedByName?: string | undefined;
  requestedByEmail?: string | undefined;
  amount: number;
  reason: string;
  refundStatus: string;
  gatewayRefundId?: string | undefined;
  requestedAt: string;
  approvedAt?: string | undefined;
  approvedBySuperAdminUserId?: string | undefined;
  completedAt?: string | undefined;
}

/**
 * A student account created by an admin (ADM-003). It always starts unverified
 * and unapproved: BR-001 email and mobile verification, then BR-002 approval.
 */
export interface AdminCreatedStudent {
  id: string;
  name: string;
  email: string;
  mobile: string;
  accountStatus: "pending";
  approvalStatus: "pending";
  isEmailVerified: false;
  isMobileVerified: false;
  accountState: "pending_verification";
  createdAt: string;
}

export interface FinancialOverrideRecord {
  id: string;
  studentId: string;
  studentName?: string | undefined;
  studentEmail?: string | undefined;
  courseId: string;
  courseTitle?: string | undefined;
  enrollmentId: string;
  originalAmountINR: number;
  proposedAmountINR: number;
  discountOrWaiverINR: number;
  adjustmentType: string;
  reason: string;
  requestedByAdminId: string;
  requestedByAdminName?: string | undefined;
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string | undefined;
  decidedBySuperAdminId?: string | undefined;
  superAdminRemarks?: string | undefined;
}

export interface GlobalRoleRecord {
  id: string;
  roleCode: string;
  roleName: string;
  description: string;
  isSystemRole: boolean;
  isActive: boolean;
  /**
   * Always empty until the verified permission catalog and role-permission
   * mapping are available - never invented.
   */
  permissions: string[];
  createdAt: string;
}

export interface DashboardStats {
  totalStudents: number;
  activeStudents: number;
  pendingApprovals: number;
  totalCourses: number;
  activeBatches: number;
  totalTeachers: number;
  /**
   * `null` means "not available": the metric's source table could not be read
   * or no data source / approved formula exists. Never a placeholder number.
   */
  totalRevenueINR: number | null;
  /** Collected revenue since 1 April of the current Indian financial year (IST). */
  revenueFinancialYearINR: number | null;
  /** e.g. "FY 2026-27". */
  financialYearLabel: string;
  pendingFeesINR: number;
  certificatesIssued: number | null;
  /** D15 placement rate % (unrounded) for `placementRatePeriod`; null for an empty cohort. */
  placementRate: number | null;
  /** IST calendar dates the placement rate covers (current financial year to date). */
  placementRatePeriod?: { from: string; to: string };
  placementCohort?: { completedStudents: number; placedStudents: number };
  /** Open job postings. */
  activePlacements: number | null;
  supportTicketsCount: number | null;
  /** D15: total of the open action queues in `systemAlerts`. */
  systemAlertsCount: number | null;
  systemAlerts?: { pendingStudentApprovals: number; pendingRefundRequests: number; pendingFinancialOverrides: number };
  totalEnrollments: number;
  placementsCount: number | null;
}

export interface SuperAdminDashboardStats {
  /** Collected revenue since 1 April of the current Indian financial year (IST). */
  totalRevenueYTD: number | null;
  /** e.g. "FY 2026-27". */
  financialYearLabel: string;
  /** Collected revenue since the first day of the current month. */
  revenueThisMonth: number | null;
  totalActiveStudents: number;
  totalFacultyMembers: number;
  totalAdminAccounts: number;
  pendingFinancialOverrides: number | null;
  pendingRefundRequests: number | null;
  systemHealthScore: number | null;
  criticalSecurityAlerts: number | null;
  activeCourseBatches: number;
  certificatesAwaitingSignoff: number | null;
  dataIntegrityStatus: "HEALTHY" | "DEGRADED" | "CRITICAL" | null;
}
