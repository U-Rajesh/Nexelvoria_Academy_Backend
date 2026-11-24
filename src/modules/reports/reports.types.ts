import type { ReportColumn } from "./report-files";

/**
 * Report catalog (REP-002). Every category reads existing tables only; the
 * columns are what those tables hold. Access follows the existing role rules
 * (BR-018 fine-grained permissions are not defined yet):
 * - Admin and Super Admin: operational reports and the payments report
 *   (Admins already see payments and collected revenue);
 * - Super Admin only: refunds (BR-006), expenses and the financial summary.
 */
export type ReportCode =
  | "students"
  | "enrollments"
  | "payments"
  | "refunds"
  | "attendance"
  | "attendance-summary"
  | "assessments"
  | "placements"
  | "expenses"
  | "financial-summary";

export type ReportRole = "admin" | "super_admin";

export interface ReportDefinition {
  code: ReportCode;
  title: string;
  description: string;
  /** What the date range filters on. */
  dateField: string;
  /** Whether a status filter applies (values come from the data: GET /reports/:code/statuses). */
  hasStatus: boolean;
  /** Whether free-text search applies, and on what. */
  searchHint: string | null;
  /** Server-side pagination (the financial summary is a fixed set of rows). */
  paginated: boolean;
  roles: readonly ReportRole[];
  columns: ReportColumn[];
}

const BOTH = ["admin", "super_admin"] as const;
const SUPER = ["super_admin"] as const;

export const REPORTS: Record<ReportCode, ReportDefinition> = {
  students: {
    code: "students",
    title: "Student Register",
    description: "Registered students with profile and approval status.",
    dateField: "Registration date",
    hasStatus: true,
    searchHint: "Name, email, mobile or college",
    paginated: true,
    roles: BOTH,
    columns: [
      { key: "studentId", label: "Student ID", type: "text" },
      { key: "name", label: "Name", type: "text" },
      { key: "email", label: "Email", type: "text" },
      { key: "mobile", label: "Mobile", type: "text" },
      { key: "college", label: "College", type: "text" },
      { key: "degree", label: "Degree", type: "text" },
      { key: "passingYear", label: "Passing Year", type: "int" },
      { key: "approvalStatus", label: "Approval Status", type: "text" },
      { key: "accountStatus", label: "Account Status", type: "text" },
      { key: "registeredAt", label: "Registered At (IST)", type: "datetime" },
    ],
  },
  enrollments: {
    code: "enrollments",
    title: "Enrollments",
    description: "Enrollments with course, batch, status and fee amounts.",
    dateField: "Enrollment date",
    hasStatus: true,
    searchHint: "Enrollment number, student or course",
    paginated: true,
    roles: BOTH,
    columns: [
      { key: "enrollmentNumber", label: "Enrollment No.", type: "text" },
      { key: "studentName", label: "Student", type: "text" },
      { key: "courseName", label: "Course", type: "text" },
      { key: "batchCode", label: "Batch", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "coursePrice", label: "Course Price (INR)", type: "money" },
      { key: "discountAmount", label: "Discount (INR)", type: "money" },
      { key: "finalAmount", label: "Final Amount (INR)", type: "money" },
      { key: "enrolledAt", label: "Enrolled At (IST)", type: "datetime" },
    ],
  },
  payments: {
    code: "payments",
    title: "Payments",
    description: "Gateway transactions and manually recorded payments, each with its own recorded status.",
    dateField: "Recorded date",
    hasStatus: true,
    searchHint: "Reference, student, enrollment number or course",
    paginated: true,
    roles: BOTH,
    columns: [
      { key: "source", label: "Source", type: "text" },
      { key: "reference", label: "Reference", type: "text" },
      { key: "studentName", label: "Student", type: "text" },
      { key: "enrollmentNumber", label: "Enrollment No.", type: "text" },
      { key: "courseName", label: "Course", type: "text" },
      { key: "method", label: "Method", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "amount", label: "Amount (INR)", type: "money" },
      { key: "recordedAt", label: "Recorded At (IST)", type: "datetime" },
    ],
  },
  refunds: {
    code: "refunds",
    title: "Refunds",
    description: "Refund requests with their approval and completion timestamps.",
    dateField: "Request date",
    hasStatus: true,
    searchHint: "Refund reference or student",
    paginated: true,
    roles: SUPER,
    columns: [
      { key: "refundReference", label: "Refund Ref.", type: "text" },
      { key: "studentName", label: "Student", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "amount", label: "Amount (INR)", type: "money" },
      { key: "reason", label: "Reason", type: "text" },
      { key: "requestedAt", label: "Requested At (IST)", type: "datetime" },
      { key: "approvedAt", label: "Approved At (IST)", type: "datetime" },
      { key: "completedAt", label: "Completed At (IST)", type: "datetime" },
    ],
  },
  attendance: {
    code: "attendance",
    title: "Attendance Register",
    description: "Marked attendance per class session and student.",
    dateField: "Session start",
    hasStatus: true,
    searchHint: "Student, batch or session title",
    paginated: true,
    roles: BOTH,
    columns: [
      { key: "sessionStart", label: "Session Start (IST)", type: "datetime" },
      { key: "batchCode", label: "Batch", type: "text" },
      { key: "sessionTitle", label: "Session", type: "text" },
      { key: "studentName", label: "Student", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "markedAt", label: "Marked At (IST)", type: "datetime" },
    ],
  },
  "attendance-summary": {
    code: "attendance-summary",
    title: "Attendance Summary",
    description:
      "Attendance % per student and batch (ATT-010): Present ÷ marked sessions × 100; Leave counts as not attended; unmarked sessions are not counted. Students below the minimum attendance are flagged.",
    dateField: "Session start",
    hasStatus: false,
    searchHint: "Student or batch",
    paginated: true,
    roles: BOTH,
    columns: [
      { key: "batchCode", label: "Batch", type: "text" },
      { key: "batchName", label: "Batch Name", type: "text" },
      { key: "studentName", label: "Student", type: "text" },
      { key: "present", label: "Present", type: "int" },
      { key: "absent", label: "Absent", type: "int" },
      { key: "leave", label: "Leave", type: "int" },
      { key: "markedSessions", label: "Marked Sessions", type: "int" },
      { key: "attendancePercentage", label: "Attendance %", type: "text" },
      { key: "belowMinimum", label: "Below Minimum", type: "text" },
      { key: "otherStatus", label: "Other Status Records", type: "int" },
    ],
  },
  assessments: {
    code: "assessments",
    title: "Assessment Attempts",
    description: "Test attempts with status and marks.",
    dateField: "Attempt start",
    hasStatus: true,
    searchHint: "Student or test title",
    paginated: true,
    roles: BOTH,
    columns: [
      { key: "testTitle", label: "Test", type: "text" },
      { key: "studentName", label: "Student", type: "text" },
      { key: "attemptNumber", label: "Attempt", type: "int" },
      { key: "status", label: "Status", type: "text" },
      { key: "totalMarks", label: "Marks", type: "money" },
      { key: "maximumMarks", label: "Maximum Marks", type: "money" },
      { key: "startedAt", label: "Started At (IST)", type: "datetime" },
      { key: "submittedAt", label: "Submitted At (IST)", type: "datetime" },
    ],
  },
  placements: {
    code: "placements",
    title: "Placement Applications",
    description: "Job applications by student, job and company.",
    dateField: "Application date",
    hasStatus: true,
    searchHint: "Student, job title or company",
    paginated: true,
    roles: BOTH,
    columns: [
      { key: "studentName", label: "Student", type: "text" },
      { key: "jobTitle", label: "Job", type: "text" },
      { key: "companyName", label: "Company", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "appliedAt", label: "Applied At (IST)", type: "datetime" },
    ],
  },
  expenses: {
    code: "expenses",
    title: "Expenses",
    description: "Recorded expenses by category. Expense records carry no status; an approver is shown when one was recorded.",
    dateField: "Expense date",
    hasStatus: false,
    searchHint: "Vendor, description or category",
    paginated: true,
    roles: SUPER,
    columns: [
      { key: "expenseDate", label: "Expense Date", type: "date" },
      { key: "category", label: "Category", type: "text" },
      { key: "vendor", label: "Vendor", type: "text" },
      { key: "description", label: "Description", type: "text" },
      { key: "currency", label: "Currency", type: "text" },
      { key: "amount", label: "Amount", type: "money" },
      { key: "enteredBy", label: "Entered By", type: "text" },
      { key: "approverRecorded", label: "Approver Recorded", type: "text" },
    ],
  },
  "financial-summary": {
    code: "financial-summary",
    title: "Financial Summary",
    description: "Revenue, refunds, discounts, scholarships and expenses reported separately (never netted).",
    dateField: "Each line's own date (see basis)",
    hasStatus: false,
    searchHint: null,
    paginated: false,
    roles: SUPER,
    columns: [
      { key: "section", label: "Section", type: "text" },
      { key: "metric", label: "Metric", type: "text" },
      { key: "count", label: "Count", type: "int" },
      { key: "amount", label: "Amount (INR)", type: "money" },
      { key: "basis", label: "Basis", type: "text" },
    ],
  },
};

export const REPORT_CODES = Object.keys(REPORTS) as ReportCode[];

export interface ReportFilter {
  /** Inclusive IST calendar dates (YYYY-MM-DD). */
  from?: string | undefined;
  to?: string | undefined;
  /** Lower-case status value as stored (see /statuses). */
  status?: string | undefined;
  search?: string | undefined;
}

export interface ReportPage {
  page: number;
  pageSize: number;
}

export interface ReportResult {
  rows: Record<string, unknown>[];
  total: number;
}

export interface CountAmount {
  count: number;
  amount: number;
}

export interface StatusLine extends CountAmount {
  status: string;
}

/**
 * REP-008. Each figure keeps its own basis; payments, refund requests and
 * completed refunds are never treated as the same thing, nothing is netted.
 */
export interface FinancialSummary {
  from: string;
  to: string;
  revenue: {
    /** NXA_Transactions with TransactionStatus 'successful' (CreatedAt in range). */
    gatewaySuccessful: CountAmount;
    /** NXA_ManualPaymentRecords with VerificationStatus 'verified' (CreatedAt in range). */
    manualVerified: CountAmount;
    totalCollected: number;
    /** Every other recorded status: shown, never counted as revenue. */
    gatewayNotCounted: StatusLine[];
    manualNotCounted: StatusLine[];
  };
  refunds: {
    /** Requests raised in range (any status). */
    requested: CountAmount;
    /** Of those, still RefundStatus 'PENDING'. */
    pending: CountAmount;
    /** ApprovedAt in range. */
    approved: CountAmount;
    /** CompletedAt in range: money actually returned. */
    completed: CountAmount;
  };
  discounts: {
    /** NXA_Enrollments.DiscountAmount > 0, enrollments created in range, excluding CANCELLED. */
    enrollmentDiscounts: CountAmount;
    /** NXA_CouponRedemptions (RedeemedAt in range), by recorded status. */
    couponRedemptions: StatusLine[];
  };
  scholarships: {
    /** NXA_ScholarshipAwards (CreatedAt in range), by recorded approval status; not assumed to have reduced any fee. */
    awards: StatusLine[];
  };
  expenses: {
    /** NXA_Expenses with ExpenseDate in range, by currency. */
    byCurrency: Array<{ currency: string; count: number; amount: number }>;
    byCategory: Array<{ category: string; currency: string; count: number; amount: number }>;
    /** Expenses with an approver recorded (ApprovedByUserId set). */
    withApprover: CountAmount;
  };
}

export interface MonthPoint {
  /** YYYY-MM (IST). */
  month: string;
  registrations: number;
  enrollments: number;
  /** Same basis as the dashboard revenue: successful gateway + verified manual payments. */
  revenueCollected: number;
}

export interface DashboardAnalytics {
  from: string;
  to: string;
  months: MonthPoint[];
  enrollmentsByStatus: Array<{ status: string; count: number }>;
  /** Raw counts per batch; no attendance percentage (the formula is an open decision). */
  attendanceByBatch: Array<{ batchCode: string; batchName: string; byStatus: Record<string, number>; marked: number }>;
  assessmentsByStatus: Array<{ status: string; count: number }>;
  placementApplicationsByStatus: Array<{ status: string; count: number }>;
  /** Users by role and account status (deleted users excluded). */
  accountsByRole: Array<{ role: string; status: string; count: number }>;
}

export interface ExportRecord {
  actorUserId: string;
  reportCode: ReportCode;
  format: string;
  filter: ReportFilter;
  /** Selected fields when the export is a custom field selection. */
  columns?: string[] | undefined;
  rowCount: number;
}
