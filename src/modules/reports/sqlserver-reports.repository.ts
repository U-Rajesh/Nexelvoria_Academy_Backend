import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
import type { DateRange, ReportsRepository } from "./reports.repository";
import {
  ReportTooLargeError,
  MAX_EXPORT_ROWS,
  istDayStartUtc,
  monthsBetween,
} from "./reports.rules";
import type {
  CountAmount,
  DashboardAnalytics,
  ExportRecord,
  FinancialSummary,
  ReportCode,
  ReportFilter,
  ReportPage,
  ReportResult,
  StatusLine,
} from "./reports.types";

type TabularCode = Exclude<ReportCode, "financial-summary">;

interface SqlReport {
  /** FROM clause (with joins) and its fixed WHERE conditions. */
  from: string;
  where?: string;
  select: string;
  dateExpr: string;
  dateKind: "datetime" | "date";
  statusExpr: string | null;
  searchExprs: string[];
  orderBy: string;
  /**
   * When the FROM clause aggregates, the date range must filter the rows being
   * aggregated, not the aggregate: the date conditions replace the RANGE
   * marker inside it instead of joining the outer WHERE.
   */
  rangeInFrom?: boolean;
}

/** Placeholder in an aggregating FROM clause for the date-range conditions. */
const RANGE_MARKER = "/*RANGE*/";

/** Same role resolution as login and the dashboards: no role row means student. */
const roleCodeOf = (alias: string): string => `COALESCE((
  SELECT TOP 1 LOWER(r.RoleCode) FROM dbo.NXA_UserRoles ur JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
  WHERE ur.UserId = ${alias}.UserId ORDER BY ur.AssignedAt DESC), 'student')`;

const REPORT_SQL: Record<TabularCode, SqlReport> = {
  students: {
    from: `dbo.NXA_Users u JOIN dbo.NXA_StudentProfiles sp ON sp.UserId = u.UserId`,
    where: `u.DeletedAt IS NULL`,
    select: `CAST(u.UserId AS varchar(30)) AS studentId, u.FullName AS name, u.Email AS email, u.MobileNumber AS mobile,
             sp.CollegeName AS college, sp.Degree AS degree, sp.PassingYear AS passingYear,
             LOWER(sp.ApprovalStatus) AS approvalStatus, LOWER(u.AccountStatus) AS accountStatus, u.CreatedAt AS registeredAt`,
    dateExpr: "u.CreatedAt",
    dateKind: "datetime",
    statusExpr: "sp.ApprovalStatus",
    searchExprs: ["u.FullName", "u.Email", "u.MobileNumber", "sp.CollegeName"],
    orderBy: "u.CreatedAt DESC, u.UserId DESC",
  },
  enrollments: {
    from: `dbo.NXA_Enrollments e
           JOIN dbo.NXA_Users u ON u.UserId = e.StudentUserId
           JOIN dbo.NXA_Courses c ON c.CourseId = e.CourseId
           LEFT JOIN dbo.NXA_Batches b ON b.BatchId = e.BatchId`,
    select: `e.EnrollmentNumber AS enrollmentNumber, u.FullName AS studentName, c.CourseName AS courseName, b.BatchCode AS batchCode,
             LOWER(e.EnrollmentStatus) AS status, e.CoursePrice AS coursePrice, e.DiscountAmount AS discountAmount,
             e.FinalAmount AS finalAmount, e.CreatedAt AS enrolledAt`,
    dateExpr: "e.CreatedAt",
    dateKind: "datetime",
    statusExpr: "e.EnrollmentStatus",
    searchExprs: ["e.EnrollmentNumber", "u.FullName", "c.CourseName"],
    orderBy: "e.CreatedAt DESC, e.EnrollmentId DESC",
  },
  payments: {
    // One row per transaction / manual record; a receipt is attached with TOP 1 so it cannot duplicate rows.
    from: `(
      SELECT 'gateway' AS source, COALESCE(pr.ReceiptNumber, t.GatewayPaymentId, po.OrderReference) AS reference,
             u.FullName AS studentName, e.EnrollmentNumber AS enrollmentNumber, c.CourseName AS courseName,
             t.PaymentMethod AS method, LOWER(t.TransactionStatus) AS status, t.Amount AS amount, t.CreatedAt AS recordedAt,
             'G' + CAST(t.TransactionId AS varchar(30)) AS rowKey
      FROM dbo.NXA_Transactions t
      JOIN dbo.NXA_PaymentOrders po ON po.PaymentOrderId = t.PaymentOrderId
      JOIN dbo.NXA_Enrollments e ON e.EnrollmentId = po.EnrollmentId
      JOIN dbo.NXA_Users u ON u.UserId = po.StudentUserId
      JOIN dbo.NXA_Courses c ON c.CourseId = e.CourseId
      OUTER APPLY (SELECT TOP 1 r.ReceiptNumber FROM dbo.NXA_PaymentReceipts r WHERE r.TransactionId = t.TransactionId ORDER BY r.IssuedAt) pr
      UNION ALL
      SELECT 'manual', m.ReferenceNumber, u.FullName, e.EnrollmentNumber, c.CourseName,
             m.PaymentMode, LOWER(m.VerificationStatus), m.Amount, m.CreatedAt,
             'M' + CAST(m.ManualPaymentRecordId AS varchar(30))
      FROM dbo.NXA_ManualPaymentRecords m
      JOIN dbo.NXA_Enrollments e ON e.EnrollmentId = m.EnrollmentId
      JOIN dbo.NXA_Users u ON u.UserId = m.StudentUserId
      JOIN dbo.NXA_Courses c ON c.CourseId = e.CourseId
    ) p`,
    select: `p.source, p.reference, p.studentName, p.enrollmentNumber, p.courseName, p.method, p.status, p.amount, p.recordedAt`,
    dateExpr: "p.recordedAt",
    dateKind: "datetime",
    statusExpr: "p.status",
    searchExprs: ["p.reference", "p.studentName", "p.enrollmentNumber", "p.courseName"],
    orderBy: "p.recordedAt DESC, p.rowKey DESC",
  },
  refunds: {
    from: `dbo.NXA_Refunds r
           JOIN dbo.NXA_Transactions t ON t.TransactionId = r.TransactionId
           JOIN dbo.NXA_PaymentOrders po ON po.PaymentOrderId = t.PaymentOrderId
           JOIN dbo.NXA_Users u ON u.UserId = po.StudentUserId`,
    select: `r.RefundReference AS refundReference, u.FullName AS studentName, LOWER(r.RefundStatus) AS status, r.Amount AS amount,
             r.Reason AS reason, r.RequestedAt AS requestedAt, r.ApprovedAt AS approvedAt, r.CompletedAt AS completedAt`,
    dateExpr: "r.RequestedAt",
    dateKind: "datetime",
    statusExpr: "r.RefundStatus",
    searchExprs: ["r.RefundReference", "u.FullName"],
    orderBy: "r.RequestedAt DESC, r.RefundId DESC",
  },
  attendance: {
    from: `dbo.NXA_AttendanceRecords ar
           JOIN dbo.NXA_ClassSessions cs ON cs.ClassSessionId = ar.ClassSessionId
           JOIN dbo.NXA_Batches b ON b.BatchId = cs.BatchId
           JOIN dbo.NXA_Users u ON u.UserId = ar.StudentUserId`,
    select: `cs.StartsAt AS sessionStart, b.BatchCode AS batchCode, cs.SessionTitle AS sessionTitle, u.FullName AS studentName,
             LOWER(ar.AttendanceStatus) AS status, ar.MarkedAt AS markedAt`,
    dateExpr: "cs.StartsAt",
    dateKind: "datetime",
    statusExpr: "ar.AttendanceStatus",
    searchExprs: ["u.FullName", "b.BatchCode", "cs.SessionTitle"],
    orderBy: "cs.StartsAt DESC, ar.AttendanceRecordId DESC",
  },
  "attendance-summary": {
    // Raw counts only: the percentage and the below-minimum flag are computed
    // by the routes with the one shared D2 formula.
    from: `(
      SELECT b.BatchId, b.BatchCode AS batchCode, b.BatchName AS batchName, ar.StudentUserId, u.FullName AS studentName,
             SUM(CASE WHEN UPPER(ar.AttendanceStatus) = 'PRESENT' THEN 1 ELSE 0 END) AS present,
             SUM(CASE WHEN UPPER(ar.AttendanceStatus) = 'ABSENT' THEN 1 ELSE 0 END) AS absent,
             SUM(CASE WHEN UPPER(ar.AttendanceStatus) = 'LEAVE' THEN 1 ELSE 0 END) AS leave,
             SUM(CASE WHEN UPPER(ar.AttendanceStatus) NOT IN ('PRESENT', 'ABSENT', 'LEAVE') THEN 1 ELSE 0 END) AS otherStatus
      FROM dbo.NXA_AttendanceRecords ar
      JOIN dbo.NXA_ClassSessions cs ON cs.ClassSessionId = ar.ClassSessionId
      JOIN dbo.NXA_Batches b ON b.BatchId = cs.BatchId
      JOIN dbo.NXA_Users u ON u.UserId = ar.StudentUserId
      WHERE 1 = 1 ${RANGE_MARKER}
      GROUP BY b.BatchId, b.BatchCode, b.BatchName, ar.StudentUserId, u.FullName
    ) s`,
    select: `s.batchCode, s.batchName, s.studentName, s.present, s.absent, s.leave, s.otherStatus`,
    dateExpr: "cs.StartsAt",
    dateKind: "datetime",
    statusExpr: null,
    searchExprs: ["s.studentName", "s.batchCode", "s.batchName"],
    orderBy: "s.batchCode ASC, s.studentName ASC, s.StudentUserId ASC",
    rangeInFrom: true,
  },
  assessments: {
    from: `dbo.NXA_TestAttempts ta
           JOIN dbo.NXA_Tests t ON t.TestId = ta.TestId
           JOIN dbo.NXA_Users u ON u.UserId = ta.StudentUserId`,
    select: `t.Title AS testTitle, u.FullName AS studentName, ta.AttemptNumber AS attemptNumber, LOWER(ta.AttemptStatus) AS status,
             ta.TotalMarks AS totalMarks, t.MaximumMarks AS maximumMarks, ta.StartedAt AS startedAt, ta.SubmittedAt AS submittedAt`,
    dateExpr: "ta.StartedAt",
    dateKind: "datetime",
    statusExpr: "ta.AttemptStatus",
    searchExprs: ["u.FullName", "t.Title"],
    orderBy: "ta.StartedAt DESC, ta.TestAttemptId DESC",
  },
  placements: {
    from: `dbo.NXA_JobApplications ja
           JOIN dbo.NXA_Jobs j ON j.JobId = ja.JobId
           JOIN dbo.NXA_Companies co ON co.CompanyId = j.CompanyId
           JOIN dbo.NXA_Users u ON u.UserId = ja.StudentUserId`,
    select: `u.FullName AS studentName, j.JobTitle AS jobTitle, co.CompanyName AS companyName, LOWER(ja.ApplicationStatus) AS status,
             ja.AppliedAt AS appliedAt`,
    dateExpr: "ja.AppliedAt",
    dateKind: "datetime",
    statusExpr: "ja.ApplicationStatus",
    searchExprs: ["u.FullName", "j.JobTitle", "co.CompanyName"],
    orderBy: "ja.AppliedAt DESC, ja.JobApplicationId DESC",
  },
  expenses: {
    from: `dbo.NXA_Expenses x
           JOIN dbo.NXA_ExpenseCategories ec ON ec.ExpenseCategoryId = x.ExpenseCategoryId
           LEFT JOIN dbo.NXA_Users eu ON eu.UserId = x.EnteredByUserId`,
    select: `x.ExpenseDate AS expenseDate, ec.CategoryName AS category, x.VendorName AS vendor, x.Description AS description,
             x.CurrencyCode AS currency, x.Amount AS amount, eu.FullName AS enteredBy,
             CASE WHEN x.ApprovedByUserId IS NULL THEN 'no' ELSE 'yes' END AS approverRecorded`,
    dateExpr: "x.ExpenseDate",
    dateKind: "date",
    statusExpr: null,
    searchExprs: ["x.VendorName", "x.Description", "ec.CategoryName"],
    orderBy: "x.ExpenseDate DESC, x.ExpenseId DESC",
  },
};

/** LIKE pattern with the user's % _ [ treated literally. */
const likePattern = (s: string): string => `%${s.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`;

export class SqlServerReportsRepository implements ReportsRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  private conditions(def: SqlReport, filter: ReportFilter, req: sql.Request): { from: string; where: string } {
    const conds: string[] = def.where ? [def.where] : [];
    const dateConds: string[] = [];
    if (filter.from) {
      if (def.dateKind === "date") {
        req.input("fromDate", sql.Date, filter.from);
        dateConds.push(`${def.dateExpr} >= @fromDate`);
      } else {
        req.input("fromUtc", sql.DateTime2, istDayStartUtc(filter.from));
        dateConds.push(`${def.dateExpr} >= @fromUtc`);
      }
    }
    if (filter.to) {
      if (def.dateKind === "date") {
        req.input("toDate", sql.Date, filter.to);
        dateConds.push(`${def.dateExpr} <= @toDate`);
      } else {
        // Inclusive "to" day: everything before 00:00 IST of the next day.
        req.input("toUtc", sql.DateTime2, istDayStartUtc(filter.to, 1));
        dateConds.push(`${def.dateExpr} < @toUtc`);
      }
    }
    if (filter.status && def.statusExpr) {
      req.input("status", sql.VarChar(40), filter.status);
      conds.push(`LOWER(${def.statusExpr}) = @status`);
    }
    if (filter.search && def.searchExprs.length) {
      req.input("search", sql.NVarChar(210), likePattern(filter.search));
      conds.push(`(${def.searchExprs.map((e) => `${e} LIKE @search ESCAPE '\\'`).join(" OR ")})`);
    }
    let from = def.from;
    if (def.rangeInFrom) from = from.replace(RANGE_MARKER, dateConds.map((c) => `AND ${c}`).join(" "));
    else conds.push(...dateConds);
    return { from, where: conds.length ? `WHERE ${conds.join(" AND ")}` : "" };
  }

  async runReport(code: TabularCode, filter: ReportFilter, page: ReportPage | null): Promise<ReportResult> {
    const def = REPORT_SQL[code];
    const pool = await this.getPool();

    const countReq = pool.request();
    const countQ = this.conditions(def, filter, countReq);
    const count = await countReq.query<{ total: number }>(`SELECT COUNT(1) AS total FROM ${countQ.from} ${countQ.where}`);
    const total = Number(count.recordset[0]?.total ?? 0);
    if (!page && total > MAX_EXPORT_ROWS) throw new ReportTooLargeError(total);
    if (total === 0) return { rows: [], total: 0 };

    const req = pool.request();
    const { from, where } = this.conditions(def, filter, req);
    let paging = "";
    if (page) {
      req.input("offset", sql.Int, (page.page - 1) * page.pageSize);
      req.input("size", sql.Int, page.pageSize);
      paging = "OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY";
    }
    const result = await req.query(`SELECT ${def.select} FROM ${from} ${where} ORDER BY ${def.orderBy} ${paging}`);
    return { rows: result.recordset.map(normalizeRow), total };
  }

  async listStatuses(code: TabularCode): Promise<string[]> {
    const def = REPORT_SQL[code];
    if (!def.statusExpr) return [];
    const pool = await this.getPool();
    const r = await pool
      .request()
      .query<{ status: string }>(
        `SELECT DISTINCT LOWER(${def.statusExpr}) AS status FROM ${def.from.replace(RANGE_MARKER, "")} ${def.where ? `WHERE ${def.where} AND` : "WHERE"} ${def.statusExpr} IS NOT NULL ORDER BY status`,
      );
    return r.recordset.map((x) => x.status);
  }

  private rangeRequest(pool: sql.ConnectionPool, range: DateRange): sql.Request {
    return pool
      .request()
      .input("fromUtc", sql.DateTime2, istDayStartUtc(range.from))
      .input("toUtc", sql.DateTime2, istDayStartUtc(range.to, 1))
      .input("fromDate", sql.Date, range.from)
      .input("toDate", sql.Date, range.to);
  }

  async financialSummary(range: DateRange): Promise<FinancialSummary> {
    const pool = await this.getPool();
    const q = <T>(text: string) => this.rangeRequest(pool, range).query<T>(text);
    const inRange = (col: string) => `${col} >= @fromUtc AND ${col} < @toUtc`;
    type SL = { status: string | null; cnt: number; amt: number | null };

    const [tx, manual, refunds, enrollDisc, coupons, awards, expCur, expCat, expAppr] = await Promise.all([
      q<SL>(`SELECT LOWER(TransactionStatus) AS status, COUNT(1) AS cnt, SUM(Amount) AS amt FROM dbo.NXA_Transactions WHERE ${inRange("CreatedAt")} GROUP BY LOWER(TransactionStatus)`),
      q<SL>(`SELECT LOWER(VerificationStatus) AS status, COUNT(1) AS cnt, SUM(Amount) AS amt FROM dbo.NXA_ManualPaymentRecords WHERE ${inRange("CreatedAt")} GROUP BY LOWER(VerificationStatus)`),
      q<{ reqCnt: number; reqAmt: number | null; penCnt: number; penAmt: number | null; apCnt: number; apAmt: number | null; coCnt: number; coAmt: number | null }>(`
        SELECT
          SUM(CASE WHEN ${inRange("RequestedAt")} THEN 1 ELSE 0 END) AS reqCnt,
          SUM(CASE WHEN ${inRange("RequestedAt")} THEN Amount ELSE 0 END) AS reqAmt,
          SUM(CASE WHEN ${inRange("RequestedAt")} AND UPPER(RefundStatus) = 'PENDING' THEN 1 ELSE 0 END) AS penCnt,
          SUM(CASE WHEN ${inRange("RequestedAt")} AND UPPER(RefundStatus) = 'PENDING' THEN Amount ELSE 0 END) AS penAmt,
          SUM(CASE WHEN ${inRange("ApprovedAt")} THEN 1 ELSE 0 END) AS apCnt,
          SUM(CASE WHEN ${inRange("ApprovedAt")} THEN Amount ELSE 0 END) AS apAmt,
          SUM(CASE WHEN ${inRange("CompletedAt")} THEN 1 ELSE 0 END) AS coCnt,
          SUM(CASE WHEN ${inRange("CompletedAt")} THEN Amount ELSE 0 END) AS coAmt
        FROM dbo.NXA_Refunds`),
      q<{ cnt: number; amt: number | null }>(`
        SELECT COUNT(1) AS cnt, SUM(DiscountAmount) AS amt FROM dbo.NXA_Enrollments
        WHERE DiscountAmount > 0 AND UPPER(EnrollmentStatus) <> 'CANCELLED' AND ${inRange("CreatedAt")}`),
      q<SL>(`SELECT LOWER(RedemptionStatus) AS status, COUNT(1) AS cnt, SUM(DiscountAmount) AS amt FROM dbo.NXA_CouponRedemptions WHERE ${inRange("RedeemedAt")} GROUP BY LOWER(RedemptionStatus)`),
      q<SL>(`SELECT LOWER(ApprovalStatus) AS status, COUNT(1) AS cnt, SUM(AwardAmount) AS amt FROM dbo.NXA_ScholarshipAwards WHERE ${inRange("CreatedAt")} GROUP BY LOWER(ApprovalStatus)`),
      q<{ currency: string; cnt: number; amt: number | null }>(`SELECT CurrencyCode AS currency, COUNT(1) AS cnt, SUM(Amount) AS amt FROM dbo.NXA_Expenses WHERE ExpenseDate >= @fromDate AND ExpenseDate <= @toDate GROUP BY CurrencyCode`),
      q<{ category: string; currency: string; cnt: number; amt: number | null }>(`
        SELECT ec.CategoryName AS category, x.CurrencyCode AS currency, COUNT(1) AS cnt, SUM(x.Amount) AS amt
        FROM dbo.NXA_Expenses x JOIN dbo.NXA_ExpenseCategories ec ON ec.ExpenseCategoryId = x.ExpenseCategoryId
        WHERE x.ExpenseDate >= @fromDate AND x.ExpenseDate <= @toDate GROUP BY ec.CategoryName, x.CurrencyCode ORDER BY ec.CategoryName`),
      q<{ cnt: number; amt: number | null }>(`SELECT COUNT(1) AS cnt, SUM(Amount) AS amt FROM dbo.NXA_Expenses WHERE ApprovedByUserId IS NOT NULL AND ExpenseDate >= @fromDate AND ExpenseDate <= @toDate`),
    ]);

    const lines = (rows: SL[]): StatusLine[] => rows.map((r) => ({ status: r.status ?? "", count: Number(r.cnt), amount: money(r.amt) }));
    const pick = (rows: StatusLine[], status: string): CountAmount => {
      const x = rows.find((l) => l.status === status);
      return { count: x?.count ?? 0, amount: x?.amount ?? 0 };
    };
    const txLines = lines(tx.recordset);
    const manualLines = lines(manual.recordset);
    const gatewaySuccessful = pick(txLines, "successful");
    const manualVerified = pick(manualLines, "verified");
    const rf = refunds.recordset[0];

    return {
      from: range.from,
      to: range.to,
      revenue: {
        gatewaySuccessful,
        manualVerified,
        totalCollected: money(gatewaySuccessful.amount + manualVerified.amount),
        gatewayNotCounted: txLines.filter((l) => l.status !== "successful"),
        manualNotCounted: manualLines.filter((l) => l.status !== "verified"),
      },
      refunds: {
        requested: { count: Number(rf?.reqCnt ?? 0), amount: money(rf?.reqAmt) },
        pending: { count: Number(rf?.penCnt ?? 0), amount: money(rf?.penAmt) },
        approved: { count: Number(rf?.apCnt ?? 0), amount: money(rf?.apAmt) },
        completed: { count: Number(rf?.coCnt ?? 0), amount: money(rf?.coAmt) },
      },
      discounts: {
        enrollmentDiscounts: { count: Number(enrollDisc.recordset[0]?.cnt ?? 0), amount: money(enrollDisc.recordset[0]?.amt) },
        couponRedemptions: lines(coupons.recordset),
      },
      scholarships: { awards: lines(awards.recordset) },
      expenses: {
        byCurrency: expCur.recordset.map((r) => ({ currency: r.currency, count: Number(r.cnt), amount: money(r.amt) })),
        byCategory: expCat.recordset.map((r) => ({ category: r.category, currency: r.currency, count: Number(r.cnt), amount: money(r.amt) })),
        withApprover: { count: Number(expAppr.recordset[0]?.cnt ?? 0), amount: money(expAppr.recordset[0]?.amt) },
      },
    };
  }

  async analytics(range: DateRange): Promise<DashboardAnalytics> {
    const pool = await this.getPool();
    const q = <T>(text: string) => this.rangeRequest(pool, range).query<T>(text);
    const month = (col: string) => `CONVERT(char(7), DATEADD(minute, 330, ${col}), 126)`;
    const inRange = (col: string) => `${col} >= @fromUtc AND ${col} < @toUtc`;
    type MC = { m: string; cnt: number };
    type SC = { status: string | null; cnt: number };

    const [regs, enrolls, txRev, manRev, enrollStatus, attendance, attempts, apps, roles] = await Promise.all([
      q<MC>(`SELECT ${month("u.CreatedAt")} AS m, COUNT(1) AS cnt FROM dbo.NXA_Users u JOIN dbo.NXA_StudentProfiles sp ON sp.UserId = u.UserId
             WHERE u.DeletedAt IS NULL AND ${inRange("u.CreatedAt")} GROUP BY ${month("u.CreatedAt")}`),
      q<MC>(`SELECT ${month("CreatedAt")} AS m, COUNT(1) AS cnt FROM dbo.NXA_Enrollments WHERE ${inRange("CreatedAt")} GROUP BY ${month("CreatedAt")}`),
      q<{ m: string; amt: number | null }>(`SELECT ${month("CreatedAt")} AS m, SUM(Amount) AS amt FROM dbo.NXA_Transactions
             WHERE LOWER(TransactionStatus) = 'successful' AND ${inRange("CreatedAt")} GROUP BY ${month("CreatedAt")}`),
      q<{ m: string; amt: number | null }>(`SELECT ${month("CreatedAt")} AS m, SUM(Amount) AS amt FROM dbo.NXA_ManualPaymentRecords
             WHERE LOWER(VerificationStatus) = 'verified' AND ${inRange("CreatedAt")} GROUP BY ${month("CreatedAt")}`),
      q<SC>(`SELECT LOWER(EnrollmentStatus) AS status, COUNT(1) AS cnt FROM dbo.NXA_Enrollments WHERE ${inRange("CreatedAt")} GROUP BY LOWER(EnrollmentStatus)`),
      q<{ batchCode: string; batchName: string; status: string | null; cnt: number }>(`
        SELECT b.BatchCode AS batchCode, b.BatchName AS batchName, LOWER(ar.AttendanceStatus) AS status, COUNT(1) AS cnt
        FROM dbo.NXA_AttendanceRecords ar
        JOIN dbo.NXA_ClassSessions cs ON cs.ClassSessionId = ar.ClassSessionId
        JOIN dbo.NXA_Batches b ON b.BatchId = cs.BatchId
        WHERE ${inRange("cs.StartsAt")}
        GROUP BY b.BatchCode, b.BatchName, LOWER(ar.AttendanceStatus)`),
      q<SC>(`SELECT LOWER(AttemptStatus) AS status, COUNT(1) AS cnt FROM dbo.NXA_TestAttempts WHERE ${inRange("StartedAt")} GROUP BY LOWER(AttemptStatus)`),
      q<SC>(`SELECT LOWER(ApplicationStatus) AS status, COUNT(1) AS cnt FROM dbo.NXA_JobApplications WHERE ${inRange("AppliedAt")} GROUP BY LOWER(ApplicationStatus)`),
      pool.request().query<{ role: string; status: string; cnt: number }>(`
        SELECT x.role, x.status, COUNT(1) AS cnt FROM (
          SELECT ${roleCodeOf("u")} AS role, LOWER(u.AccountStatus) AS status FROM dbo.NXA_Users u WHERE u.DeletedAt IS NULL
        ) x GROUP BY x.role, x.status`),
    ]);

    const byMonth = (rows: Array<{ m: string; cnt?: number; amt?: number | null }>, key: "cnt" | "amt") =>
      new Map(rows.map((r) => [r.m, Number(r[key] ?? 0)]));
    const regMap = byMonth(regs.recordset, "cnt");
    const enrMap = byMonth(enrolls.recordset, "cnt");
    const txMap = byMonth(txRev.recordset, "amt");
    const manMap = byMonth(manRev.recordset, "amt");

    const batches = new Map<string, { batchCode: string; batchName: string; byStatus: Record<string, number>; marked: number }>();
    for (const r of attendance.recordset) {
      const b = batches.get(r.batchCode) ?? { batchCode: r.batchCode, batchName: r.batchName, byStatus: {}, marked: 0 };
      const s = r.status ?? "";
      b.byStatus[s] = (b.byStatus[s] ?? 0) + Number(r.cnt);
      b.marked += Number(r.cnt);
      batches.set(r.batchCode, b);
    }
    const statusCounts = (rows: SC[]) => rows.map((r) => ({ status: r.status ?? "", count: Number(r.cnt) })).sort((a, b) => b.count - a.count);

    return {
      from: range.from,
      to: range.to,
      months: monthsBetween(range.from, range.to).map((m) => ({
        month: m,
        registrations: regMap.get(m) ?? 0,
        enrollments: enrMap.get(m) ?? 0,
        revenueCollected: money((txMap.get(m) ?? 0) + (manMap.get(m) ?? 0)),
      })),
      enrollmentsByStatus: statusCounts(enrollStatus.recordset),
      attendanceByBatch: [...batches.values()].sort((a, b) => a.batchCode.localeCompare(b.batchCode)),
      assessmentsByStatus: statusCounts(attempts.recordset),
      placementApplicationsByStatus: statusCounts(apps.recordset),
      accountsByRole: roles.recordset
        .map((r) => ({ role: r.role, status: r.status, count: Number(r.cnt) }))
        .sort((a, b) => a.role.localeCompare(b.role) || a.status.localeCompare(b.status)),
    };
  }

  async recordExport(entry: ExportRecord): Promise<void> {
    const pool = await this.getPool();
    await writeAuditLog(pool.request(), {
      actorUserId: entry.actorUserId,
      actionType: "REPORT_EXPORT",
      moduleCode: "REPORTS",
      entityName: "Report",
      entityId: entry.reportCode,
      newValues: JSON.stringify({ format: entry.format, filter: entry.filter, ...(entry.columns ? { columns: entry.columns } : {}), rowCount: entry.rowCount }),
    });
  }
}

const money = (v: number | null | undefined): number => Math.round(Number(v ?? 0) * 100) / 100;

/** Decimal columns arrive as numbers; BIGINT ids are cast to text in SQL. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}
