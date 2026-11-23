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

export interface InstituteSettingsRecord {
  instituteName: string;
  tagline: string;
  supportEmail: string;
  supportPhone: string;
  whatsappNumber: string;
  address: string;
  timezone: string;
  minAttendancePercentage: number;
  isSmsEnabled: boolean;
  currencySymbol: string;
  gstNumber?: string | undefined;
  updatedAt?: string | undefined;
}

export interface SystemConfigRecord {
  institute: {
    name: string;
    code: string;
    affiliation: string;
    supportEmail: string;
    supportPhone: string;
    whatsappNumber: string;
    address: string;
    website: string;
    gstNumber: string;
    currency: string;
    timezone: string;
  };
  branding: {
    logoUrl: string;
    faviconUrl: string;
    primaryColor: string;
    secondaryColor: string;
    tagline: string;
    motto: string;
  };
  academic: {
    currentAcademicYear: string;
    activeTerm: string;
    isRegistrationOpen: boolean;
    isCatalogPublic: boolean;
    maxBatchCapacity: number;
    minAttendancePercentage: number;
    assignmentGracePeriodDays: number;
    passPercentage: number;
  };
  paymentGateway: {
    provider: "razorpay" | "stripe" | "cashfree";
    keyId: string;
    keySecretMasked: string;
    webhookSecretMasked: string;
    isLiveMode: boolean;
    autoReconcile: boolean;
  };
  emailSms: {
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPasswordMasked: string;
    senderName: string;
    senderEmail: string;
    isSmsEnabled: boolean;
    smsProvider: string;
    smsApiKeyMasked: string;
  };
  notifications: {
    emailOnAdmission: boolean;
    emailOnPayment: boolean;
    emailOnExamResult: boolean;
    smsOnClassReminder: boolean;
    pushAnnouncements: boolean;
  };
  security: {
    sessionTimeoutMinutes: number;
    enforceTwoFactor: boolean;
    maxFailedLogins: number;
    passwordExpiryDays: number;
    requireSpecialChars: boolean;
  };
  maintenance: {
    isMaintenanceMode: boolean;
    message: string;
    allowedIps: string;
  };
}

export interface RefundRecord {
  id: string;
  refundReference: string;
  transactionId?: string | undefined;
  requestedByUserId: string;
  amount: number;
  reason: string;
  refundStatus: string;
  gatewayRefundId?: string | undefined;
  requestedAt: string;
  approvedAt?: string | undefined;
  approvedBySuperAdminUserId?: string | undefined;
  completedAt?: string | undefined;
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
  totalRevenueINR: number;
  pendingFeesINR: number;
  certificatesIssued: number;
  placementRate: number;
  activePlacements: number;
  supportTicketsCount: number;
  systemAlertsCount: number;
  totalEnrollments: number;
  placementsCount: number;
}

export interface SuperAdminDashboardStats {
  totalRevenueYTD: number;
  monthlyRecurringRevenue: number;
  totalActiveStudents: number;
  totalFacultyMembers: number;
  totalAdminAccounts: number;
  pendingFinancialOverrides: number;
  pendingRefundRequests: number;
  systemHealthScore: number;
  criticalSecurityAlerts: number;
  activeCourseBatches: number;
  certificatesAwaitingSignoff: number;
  dataIntegrityStatus: "HEALTHY" | "DEGRADED" | "CRITICAL";
}
