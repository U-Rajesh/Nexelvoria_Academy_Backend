import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type sql from "mssql";

import { financialYearLabel, financialYearStart, istMonthStart } from "../src/modules/admin/reporting-period";
import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";

// Mock SQL Request and ConnectionPool
class MockSqlRequest {
  public inputs: Record<string, unknown> = {};
  public handler: (query: string, inputs: Record<string, unknown>) => unknown;

  constructor(handler: (query: string, inputs: Record<string, unknown>) => unknown) {
    this.handler = handler;
  }

  input(name: string, _typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : _typeOrValue;
    return this;
  }

  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) {
      throw res;
    }
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return {
      recordset: r.recordset ?? [],
      rowsAffected: r.rowsAffected ?? [1],
    };
  }
}

const createMockPool = (
  handler: (query: string, inputs: Record<string, unknown>) => unknown,
): sql.ConnectionPool => {
  const pool = {
    request: () => new MockSqlRequest(handler),
    transaction: () => ({
      begin: async () => {},
      commit: async () => {},
      rollback: async () => {},
      request: () => new MockSqlRequest(handler),
    }),
  } as unknown as sql.ConnectionPool;
  return pool;
};

/**
 * The live NXA_Users table has no `Role` column (roles are in NXA_UserRoles /
 * NXA_Roles). Any query selecting, filtering, grouping or inserting it fails
 * at runtime with "Invalid column name 'Role'".
 */
const assertNoUsersRoleColumn = (q: string): void => {
  assert.doesNotMatch(q, /\bu\.Role\b|SELECT\s+Role\b|GROUP BY\s+Role\b|\bRole\s+IN\s*\(|,\s*Role\s*,/i);
};

describe("SqlServerAdminRepository (unit with mock pool)", () => {
  it("calculates dashboard stats correctly", async () => {
    const pool = createMockPool((q) => {
      assertNoUsersRoleColumn(q);
      if (q.includes("GROUP BY x.role, x.status, x.approval")) {
        // Roles resolve through NXA_UserRoles -> NXA_Roles, never NXA_Users.Role.
        assert.match(q, /NXA_UserRoles/);
        return {
          recordset: [
            { role: "student", status: "active", approval: "approved", cnt: 85 },
            { role: "student", status: "pending", approval: "pending", cnt: 10 },
            { role: "teacher", status: "active", approval: null, cnt: 12 },
          ],
        };
      }
      if (q.includes("FROM dbo.NXA_Courses")) return { recordset: [{ cnt: 6 }] };
      if (q.includes("FROM dbo.NXA_Batches")) return { recordset: [{ cnt: 4 }] };
      if (q.includes("FROM dbo.NXA_Enrollments")) {
        assert.match(q, /APPROVED_UNPAID/, "pending fees come from approved-but-unpaid enrollments");
        return { recordset: [{ total: 95, pendingFees: 150000 }] };
      }
      if (q.includes("NXA_Transactions")) {
        assert.match(q, /'successful'/);
        assert.match(q, /NXA_ManualPaymentRecords/);
        return { recordset: [{ total: 1250000 }] };
      }
      if (q.includes("FROM dbo.NXA_Certificates")) return { recordset: [{ cnt: 40 }] };
      if (q.includes("FROM dbo.NXA_Jobs")) return { recordset: [{ cnt: 7 }] };
      if (q.includes("FROM dbo.NXA_PlacementRecords")) return { recordset: [{ cnt: 21 }] };
      if (q.includes("FROM dbo.NXA_SupportTickets")) return { recordset: [{ cnt: 3 }] };
      return { recordset: [] };
    });

    const repo = new SqlServerAdminRepository(pool);
    const stats = await repo.getDashboardStats();

    assert.equal(stats.totalStudents, 95);
    assert.equal(stats.activeStudents, 85);
    assert.equal(stats.pendingApprovals, 10);
    assert.equal(stats.totalTeachers, 12);
    assert.equal(stats.totalCourses, 6);
    assert.equal(stats.activeBatches, 4);
    assert.equal(stats.totalEnrollments, 95);
    assert.equal(stats.totalRevenueINR, 1250000);
    assert.equal(stats.revenueFinancialYearINR, 1250000);
    assert.match(stats.financialYearLabel, /^FY \d{4}-\d{2}$/);
    assert.equal(stats.pendingFeesINR, 150000);
    assert.equal(stats.certificatesIssued, 40);
    assert.equal(stats.activePlacements, 7);
    assert.equal(stats.placementsCount, 21);
    assert.equal(stats.supportTicketsCount, 3);
    // No approved formula / source: reported as unavailable, never invented.
    assert.equal(stats.placementRate, null);
    assert.equal(stats.systemAlertsCount, null);
  });

  it("reports an unreadable KPI as null instead of failing the dashboard or inventing a number", async () => {
    const pool = createMockPool((q) => {
      if (q.includes("GROUP BY x.role")) return { recordset: [{ role: "student", status: "active", approval: "approved", cnt: 1 }] };
      if (q.includes("FROM dbo.NXA_Enrollments")) return { recordset: [{ total: 1, pendingFees: 0 }] };
      if (q.includes("FROM dbo.NXA_Certificates")) return new Error("Invalid object name 'dbo.NXA_Certificates'.");
      return { recordset: [{ cnt: 0, total: 0 }] };
    });
    const stats = await new SqlServerAdminRepository(pool).getDashboardStats();
    assert.equal(stats.certificatesIssued, null);
    assert.equal(stats.totalStudents, 1);
  });

  it("calculates super admin dashboard stats correctly", async () => {
    const sinceValues: number[] = [];
    const pool = createMockPool((q, inputs) => {
      assertNoUsersRoleColumn(q);
      if (q.includes("GROUP BY x.role")) {
        return {
          recordset: [
            { role: "student", cnt: 110 },
            { role: "teacher", cnt: 14 },
            { role: "admin", cnt: 3 },
            { role: "super_admin", cnt: 1 },
          ],
        };
      }
      // ApprovedByUserId is NOT NULL in the live schema: no override can be pending.
      assert.doesNotMatch(q, /NXA_EnrollmentOverrides/, "no pending-override query against a NOT NULL approver");
      if (q.includes("FROM dbo.NXA_Refunds")) return { recordset: [{ cnt: 1 }] };
      if (q.includes("FROM dbo.NXA_Batches")) return { recordset: [{ cnt: 5 }] };
      if (q.includes("NXA_Transactions")) {
        assert.match(q, /@since/, "revenue is date-bounded");
        const since = (inputs["since"] as Date).getTime();
        sinceValues.push(since);
        return { recordset: [{ total: since === financialYearStart().getTime() ? 2400000 : 900000 }] };
      }
      return { recordset: [] };
    });

    const repo = new SqlServerAdminRepository(pool);
    const stats = await repo.getSuperAdminDashboardStats();
    assert.ok(sinceValues.includes(financialYearStart().getTime()), "YTD is bounded by the financial-year start");
    assert.ok(sinceValues.includes(istMonthStart().getTime()), "month revenue is bounded by the IST month start");

    assert.equal(stats.totalActiveStudents, 110);
    assert.equal(stats.totalFacultyMembers, 14);
    assert.equal(stats.totalAdminAccounts, 4);
    assert.equal(stats.pendingFinancialOverrides, 0);
    assert.equal(stats.pendingRefundRequests, 1);
    assert.equal(stats.activeCourseBatches, 5);
    assert.equal(stats.totalRevenueYTD, 2400000);
    assert.equal(stats.financialYearLabel, financialYearLabel());
    assert.equal(stats.revenueThisMonth, 900000);
    assert.equal(stats.systemHealthScore, null);
    assert.equal(stats.dataIntegrityStatus, null);
  });

  it("manages admin accounts: query, creation, update and status", async () => {
    const mockAdminRow = {
      UserId: 201,
      FullName: "Priya Nair",
      Email: "priya.nair@nexelvoria.edu.in",
      MobileNumber: "9876511223",
      RoleCode: "admin",
      AccountStatus: "active",
      CreatedAt: new Date("2026-06-15T09:30:00Z"),
      EmployeeCode: "EMP-ADM-001",
      AdminLevel: "Admissions",
    };

    let updateExecuted = false;
    const executed: string[] = [];
    let userInsertInputs: Record<string, unknown> = {};
    let roleInsertInputs: Record<string, unknown> = {};
    const pool = createMockPool((q, inputs) => {
      assertNoUsersRoleColumn(q);
      executed.push(q);
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
      if (q.includes("FROM dbo.NXA_Roles WHERE")) return { recordset: [{ RoleId: 2 }] };
      if (q.includes("INSERT INTO dbo.NXA_Users")) {
        userInsertInputs = { ...inputs };
        return { recordset: [{ UserId: 201 }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_UserRoles")) {
        roleInsertInputs = { ...inputs };
        return { recordset: [] };
      }
      if (q.includes("INSERT INTO dbo.NXA_AdminProfiles")) return { recordset: [] };
      if (q.includes("UPDATE dbo.NXA_Users")) {
        updateExecuted = true;
        return { recordset: [], rowsAffected: [1] };
      }
      return { recordset: [mockAdminRow] };
    });

    const repo = new SqlServerAdminRepository(pool);

    const admins = await repo.findAdmins();
    assert.equal(admins.length, 1);
    assert.equal(admins[0]!.name, "Priya Nair");
    assert.equal(admins[0]!.role, "admin");
    assert.deepEqual(admins[0]!.permissions, [], "permissions are never fabricated");

    const created = await repo.createAdmin({
      name: "Priya Nair",
      email: "Priya.Nair@nexelvoria.edu.in",
      mobile: "9876511223",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$stub$stub",
      assignedByUserId: "1",
      department: "Admissions",
    });
    assert.equal(created.id, "201");
    // The user row carries a real hash and normalised identifiers.
    assert.equal(userInsertInputs["passwordHash"], "$argon2id$v=19$m=19456,t=2,p=1$stub$stub");
    assert.equal(userInsertInputs["normalizedEmail"], "priya.nair@nexelvoria.edu.in");
    assert.equal(userInsertInputs["normalizedMobile"], "+919876511223");
    // The role is assigned through NXA_UserRoles, by the acting super admin.
    assert.equal(roleInsertInputs["roleId"], 2);
    assert.equal(roleInsertInputs["assignedBy"], "1");
    const order = ["UPDLOCK", "FROM dbo.NXA_Roles", "INSERT INTO dbo.NXA_Users", "INSERT INTO dbo.NXA_UserRoles", "INSERT INTO dbo.NXA_AdminProfiles"]
      .map((s) => executed.findIndex((q) => q.includes(s)));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "create runs dup-check, role lookup, user, role, profile in order");

    const updated = await repo.updateAdmin("201", { mobile: "9876599999" });
    assert.equal(updated.name, "Priya Nair");
    assert.equal(updateExecuted, true);

    const suspended = await repo.setAdminStatus("201", "suspended");
    assert.equal(suspended.id, "201");

    await repo.setAdminPassword("201", "$argon2id$new");
    const pwUpdate = executed.filter((q) => q.includes("SET PasswordHash")).pop() ?? "";
    assert.match(pwUpdate, /FailedLoginAttempts = 0/);
    assert.match(pwUpdate, /IsLocked = 0/);
  });

  it("refuses to create an admin whose email is already registered", async () => {
    let inserted = false;
    const pool = createMockPool((q) => {
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) {
        return { recordset: [{ NormalizedEmail: "taken@nexelvoria.edu.in", NormalizedMobile: "+919000000000" }] };
      }
      if (q.includes("INSERT INTO")) inserted = true;
      return { recordset: [] };
    });
    const repo = new SqlServerAdminRepository(pool);
    await assert.rejects(
      repo.createAdmin({
        name: "Dup",
        email: "Taken@nexelvoria.edu.in",
        mobile: "9111111111",
        passwordHash: "$argon2id$x",
        assignedByUserId: "1",
      }),
      (err: Error) => err.name === "DuplicateRecordError" || /already exists/.test(err.message),
    );
    assert.equal(inserted, false, "nothing is written when the email is taken");
  });

  it("fails loudly when the admin role is not seeded instead of creating a role-less user", async () => {
    let inserted = false;
    const pool = createMockPool((q) => {
      if (q.includes("FROM dbo.NXA_Roles WHERE")) return { recordset: [] };
      if (q.includes("INSERT INTO")) inserted = true;
      return { recordset: [] };
    });
    const repo = new SqlServerAdminRepository(pool);
    await assert.rejects(
      repo.createAdmin({ name: "X", email: "x@y.in", mobile: "9222222222", passwordHash: "h", assignedByUserId: "1" }),
      /not seeded/,
    );
    assert.equal(inserted, false);
  });

  it("unlock clears the lockout without activating the account", async () => {
    let unlockSql = "";
    const pool = createMockPool((q) => {
      if (q.includes("UPDATE dbo.NXA_Users")) unlockSql = q;
      return { recordset: [], rowsAffected: [1] };
    });
    await new SqlServerAdminRepository(pool).unlockUserAccount("42");
    assert.match(unlockSql, /FailedLoginAttempts = 0/);
    assert.match(unlockSql, /IsLocked = 0/);
    assert.doesNotMatch(unlockSql, /AccountStatus/, "unlock must not bypass approval or suspension");
  });

  it("manages batches: creation, retrieval, updates and status changes", async () => {
    const mockBatchRow = {
      BatchId: 101,
      CourseId: 5,
      BatchCode: "BAT-PY-01",
      BatchName: "Python Full Stack Spring 2026",
      StartDate: new Date("2026-03-01"),
      EndDate: new Date("2026-07-01"),
      Capacity: 45,
      ScheduleDescription: "MWF 10:00 AM - 12:00 PM IST",
      Status: "ongoing",
      TimeZoneId: "Asia/Kolkata",
      CreatedAt: new Date("2026-01-15"),
      UpdatedAt: null,
      CurrentEnrollments: 28,
    };

    const pool = createMockPool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Batches")) return { recordset: [{ BatchId: 101 }] };
      return { recordset: [mockBatchRow], rowsAffected: [1] };
    });

    const repo = new SqlServerAdminRepository(pool);

    const created = await repo.createBatch({
      courseId: "5",
      batchCode: "BAT-PY-01",
      batchName: "Python Full Stack Spring 2026",
      capacity: 45,
    });
    assert.equal(created.id, "101");
    assert.equal(created.batchCode, "BAT-PY-01");

    const batches = await repo.findBatches({ courseId: "5" });
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.currentEnrollments, 28);

    const updated = await repo.updateBatch("101", { batchName: "Python Elite Batch" });
    assert.equal(updated.id, "101");

    const statusUpdated = await repo.setBatchStatus("101", "completed");
    assert.equal(statusUpdated.id, "101");
  });

  it("handles teacher allocations and batch student roster", async () => {
    let allocated = false;
    let unallocated = false;

    const mockStudentRow = {
      UserId: 301,
      FullName: "Aarav Sharma",
      Email: "aarav@test.local",
      MobileNumber: "9876543210",
      AccountStatus: "active",
      EmailVerified: true,
      MobileVerified: false,
      CreatedAt: new Date("2026-02-01"),
      CollegeName: "BITS Pilani",
      Degree: "B.Tech",
      Branch: "CSE",
      PassingYear: 2026,
      InterestedCourseId: 5,
      DateOfBirth: new Date("2004-05-01"),
      Gender: "Male",
      AddressLine1: "Hyderabad",
      ApprovalStatus: "APPROVED",
      EnrolledCourseIds: "5",
    };

    const pool = createMockPool((q) => {
      if (q.includes("FROM dbo.NXA_Batches WITH (UPDLOCK)")) return { recordset: [{ CourseId: 5, Status: "ongoing" }] };
      if (q.includes("SELECT u.AccountStatus")) {
        assert.match(q, /NXA_UserRoles/, "teacher role resolved through NXA_UserRoles");
        return { recordset: [{ AccountStatus: "active" }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_TeacherAllocations")) {
        allocated = true;
        assert.match(q, /CourseId/);
        return { recordset: [{ AlreadyAllocated: false }] };
      }
      if (q.includes("UPDATE dbo.NXA_TeacherAllocations")) {
        unallocated = true;
        return { recordset: [], rowsAffected: [1] };
      }
      if (q.includes("FROM dbo.NXA_Enrollments e")) {
        assert.doesNotMatch(q, /DegreeBranch|CourseInterestedIn/, "only live NXA_StudentProfiles columns");
        return { recordset: [mockStudentRow] };
      }
      return { recordset: [] };
    });

    const repo = new SqlServerAdminRepository(pool);

    await repo.allocateTeacher({ batchId: "101", courseId: "5", teacherUserId: "501", allocatedByUserId: "1" });
    assert.equal(allocated, true);

    await repo.unallocateTeacher("101", "501");
    assert.equal(unallocated, true);

    const roster = await repo.findBatchStudents("101");
    assert.equal(roster.length, 1);
    assert.equal(roster[0]!.name, "Aarav Sharma");
    assert.equal(roster[0]!.degreeBranch, "B.Tech - CSE");
    assert.equal(roster[0]!.adminApprovalStatus, "approved");
    assert.deepEqual(roster[0]!.enrolledCourseIds, ["5"]);
  });

  it("rejects an allocation whose batch belongs to a different course, writing nothing", async () => {
    let inserted = false;
    const pool = createMockPool((q) => {
      if (q.includes("FROM dbo.NXA_Batches WITH (UPDLOCK)")) return { recordset: [{ CourseId: 7, Status: "ongoing" }] };
      if (q.includes("INSERT INTO")) inserted = true;
      return { recordset: [{ AccountStatus: "active" }] };
    });
    await assert.rejects(
      new SqlServerAdminRepository(pool).allocateTeacher({ batchId: "101", courseId: "5", teacherUserId: "501", allocatedByUserId: "1" }),
      (err: Error & { code?: string }) => err.code === "BATCH_COURSE_MISMATCH",
    );
    assert.equal(inserted, false);
  });

  it("rejects allocating a user who is not a teacher", async () => {
    const pool = createMockPool((q) => {
      if (q.includes("FROM dbo.NXA_Batches WITH (UPDLOCK)")) return { recordset: [{ CourseId: 5, Status: "ongoing" }] };
      return { recordset: [] };
    });
    await assert.rejects(
      new SqlServerAdminRepository(pool).allocateTeacher({ batchId: "101", courseId: "5", teacherUserId: "999", allocatedByUserId: "1" }),
      (err: Error & { code?: string }) => err.code === "NOT_A_TEACHER",
    );
  });

  it("unallocating a teacher who is not allocated reports not-found", async () => {
    const pool = createMockPool(() => ({ recordset: [], rowsAffected: [0] }));
    await assert.rejects(new SqlServerAdminRepository(pool).unallocateTeacher("101", "501"), /not found/);
  });

  it("manages administrative enrollments", async () => {
    const mockEnrollmentRow = {
      EnrollmentId: 901,
      StudentUserId: 301,
      StudentName: "Aarav Sharma",
      StudentEmail: "aarav@test.local",
      CourseId: 5,
      CourseTitle: "Full Stack Python",
      BatchId: 101,
      BatchCode: "BAT-PY-01",
      EnrollmentNumber: "ENR-2026-001",
      EnrollmentStatus: "ACTIVE",
      CoursePrice: 45000,
      DiscountAmount: 5000,
      FinalAmount: 40000,
      CurrencyCode: "INR",
      EnrollmentSource: "ADMIN_MANUAL",
      ActivatedAt: new Date("2026-02-15"),
      CompletedAt: null,
      CreatedAt: new Date("2026-02-15"),
    };

    let insertInputs: Record<string, unknown> = {};
    let auditInputs: Record<string, unknown> = {};
    let couponLookup: { query: string; code: unknown } | null = null;
    const order: string[] = [];
    const pool = createMockPool((q, inputs) => {
      if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "APPROVED", AccountStatus: "active" }] };
      if (q.includes("SELECT ListPrice")) return { recordset: [{ ListPrice: 45000, CurrencyCode: "INR" }] };
      if (q.includes("SELECT CourseId, Status FROM dbo.NXA_Batches")) return { recordset: [{ CourseId: 5, Status: "upcoming" }] };
      if (q.includes("FROM dbo.NXA_Coupons c WITH (UPDLOCK, HOLDLOCK)")) {
        couponLookup = { query: q, code: inputs["code"] };
        return {
          recordset: [{
            CouponId: 12, CouponCode: "MERIT5K", CouponActive: true, UsageLimit: 100, PerUserLimit: null, UsageCount: 3,
            DiscountId: 7, DiscountName: "Merit 5K", DiscountType: "fixed_amount", DiscountValue: 5000,
            StartsAt: null, EndsAt: null, DiscountActive: true,
          }],
        };
      }
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
      if (q.includes("INSERT INTO dbo.NXA_Enrollments")) {
        order.push("enrollment");
        insertInputs = { ...inputs };
        return { recordset: [{ EnrollmentId: 901 }] };
      }
      if (q.includes("NXA_EnrollmentOverrides")) order.push("override");
      if (q.includes("INSERT INTO dbo.NXA_CouponRedemptions")) {
        order.push("redemption");
        return { recordset: [{ CouponRedemptionId: 44 }] };
      }
      if (q.includes("UPDATE dbo.NXA_Coupons")) {
        order.push("usage");
        return { recordset: [], rowsAffected: [1] };
      }
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        order.push("audit");
        auditInputs = { ...inputs };
        return { recordset: [{ AuditLogId: 1 }] };
      }
      return { recordset: [mockEnrollmentRow], rowsAffected: [1] };
    });

    const repo = new SqlServerAdminRepository(pool);

    const created = await repo.createEnrollment({
      studentUserId: "301",
      courseId: "5",
      batchId: "101",
      discountCode: "merit5k",
      status: "approved_unpaid",
      createdByUserId: "1",
      audit: { actorUserId: "1", actionType: "MANUAL_ENROLLMENT" },
    });
    assert.equal(created.id, "901");
    // Price is the course's ListPrice, never client-supplied.
    assert.equal(insertInputs["price"], 45000);
    assert.equal(insertInputs["final"], 40000);
    assert.equal(insertInputs["status"], "APPROVED_UNPAID");
    assert.equal(insertInputs["createdBy"], "1");
    // The code is looked up in NXA_Coupons.CouponCode (upper-cased), joined to its discount.
    assert.equal(couponLookup!.code, "MERIT5K");
    assert.match(couponLookup!.query, /JOIN dbo\.NXA_Discounts d ON d\.DiscountId = c\.DiscountId/);
    assert.match(couponLookup!.query, /WHERE c\.CouponCode = @code/);
    // Redemption and usage count are written with the enrollment, before the audit,
    // and a paid enrollment records no override.
    assert.deepEqual(order, ["enrollment", "redemption", "usage", "audit"]);
    assert.equal(auditInputs["action"], "MANUAL_ENROLLMENT");
    assert.match(String(auditInputs["newVal"]), /"enrollmentNumber":"ENR-/);
    // The applied coupon is a defined record, identified in the audit trail.
    const auditJson = JSON.parse(String(auditInputs["newVal"]));
    assert.equal(auditJson.coupon.code, "MERIT5K");
    assert.equal(auditJson.coupon.couponId, "12");
    assert.equal(auditJson.coupon.redemptionId, "44");

    const list = await repo.findEnrollments({ studentId: "301" });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.enrollmentStatus, "active");
  });

  it("waives the full price for a free access override, atomically with its audit", async () => {
    let insertInputs: Record<string, unknown> = {};
    let auditInputs: Record<string, unknown> = {};
    let discountQueried = false;
    let overrideQuery = "";
    let overrideInputs: Record<string, unknown> = {};
    const order: string[] = [];
    const pool = createMockPool((q, inputs) => {
      if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "APPROVED", AccountStatus: "active" }] };
      if (q.includes("SELECT ListPrice")) return { recordset: [{ ListPrice: 45000, CurrencyCode: "INR" }] };
      if (q.includes("FROM dbo.NXA_Discounts")) discountQueried = true;
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
      if (q.includes("INSERT INTO dbo.NXA_Enrollments")) {
        order.push("enrollment");
        insertInputs = { ...inputs };
        return { recordset: [{ EnrollmentId: 902 }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_EnrollmentOverrides")) {
        order.push("override");
        overrideQuery = q;
        overrideInputs = { ...inputs };
        return { recordset: [{ EnrollmentOverrideId: 55 }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        order.push("audit");
        auditInputs = { ...inputs };
        return { recordset: [{ AuditLogId: 3 }] };
      }
      return {
        recordset: [{
          EnrollmentId: 902, StudentUserId: 301, StudentName: null, StudentEmail: null, CourseId: 5, CourseTitle: null,
          BatchId: null, BatchCode: null, EnrollmentNumber: "E", EnrollmentStatus: "ACTIVE", CoursePrice: 45000,
          DiscountAmount: 45000, FinalAmount: 0, CurrencyCode: "INR", EnrollmentSource: "ADMIN", ActivatedAt: new Date(),
          CompletedAt: null, CreatedAt: new Date(),
        }],
        rowsAffected: [1],
      };
    });
    const repo = new SqlServerAdminRepository(pool);
    await repo.createEnrollment({
      studentUserId: "301", courseId: "5", status: "active", freeAccess: true, createdByUserId: "7",
      audit: { actorUserId: "7", actionType: "FREE_ACCESS_OVERRIDE", reason: "Scholarship approved by board" },
    });
    assert.equal(discountQueried, false);
    assert.equal(insertInputs["status"], "ACTIVE");
    assert.equal(insertInputs["discount"], 45000);
    assert.equal(insertInputs["final"], 0);
    assert.equal(auditInputs["action"], "FREE_ACCESS_OVERRIDE");
    assert.equal(auditInputs["actorId"], "7");
    const audit = JSON.parse(String(auditInputs["newVal"]));
    assert.equal(audit.freeAccess, true);
    assert.equal(audit.waivedAmount, 45000);
    assert.equal(audit.requestedByUserId, "7");
    assert.equal(audit.reason, "Scholarship approved by board");
    assert.equal(audit.overrideId, "55");
    assert.equal(audit.overrideType, "FREE_ACCESS");

    // The grant is recorded in NXA_EnrollmentOverrides, between the enrollment
    // insert and the audit, in the same transaction.
    assert.deepEqual(order, ["enrollment", "override", "audit"]);
    const cols = /NXA_EnrollmentOverrides\s*\(([^)]*)\)/.exec(overrideQuery)?.[1]?.split(",").map((c) => c.trim());
    // Exactly the live columns: every NOT NULL column without a default is supplied.
    assert.deepEqual(cols, ["EnrollmentId", "OverrideType", "Reason", "ApprovedByUserId", "CreatedAt"]);
    assert.equal(overrideInputs["enrollmentId"], "902");
    assert.equal(overrideInputs["overrideType"], "FREE_ACCESS");
    assert.equal(overrideInputs["reason"], "Scholarship approved by board");
    assert.equal(overrideInputs["approvedBy"], "7", "the granting user authorizes the override");

    await assert.rejects(
      repo.createEnrollment({
        studentUserId: "301", courseId: "5", status: "active", freeAccess: true, createdByUserId: "7",
        audit: { actorUserId: "7", actionType: "FREE_ACCESS_OVERRIDE" },
      }),
      (err: Error & { code?: string }) => err.code === "REASON_REQUIRED",
    );
  });

  it("rolls back the free access enrollment when the override row cannot be written", async () => {
    const state = { committed: false, rolledBack: false, audited: false };
    const handler = (q: string) => {
      if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "APPROVED", AccountStatus: "active" }] };
      if (q.includes("SELECT ListPrice")) return { recordset: [{ ListPrice: 45000, CurrencyCode: "INR" }] };
      if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
      if (q.includes("INSERT INTO dbo.NXA_Enrollments")) return { recordset: [{ EnrollmentId: 903 }] };
      if (q.includes("INSERT INTO dbo.NXA_EnrollmentOverrides")) {
        return new Error("The INSERT statement conflicted with the FOREIGN KEY constraint");
      }
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) state.audited = true;
      return { recordset: [] };
    };
    const pool = {
      request: () => new MockSqlRequest(handler),
      transaction: () => ({
        begin: async () => {},
        commit: async () => {
          state.committed = true;
        },
        rollback: async () => {
          state.rolledBack = true;
        },
        request: () => new MockSqlRequest(handler),
      }),
    } as unknown as sql.ConnectionPool;

    await assert.rejects(
      new SqlServerAdminRepository(pool).createEnrollment({
        studentUserId: "301", courseId: "5", status: "active", freeAccess: true, createdByUserId: "7",
        audit: { actorUserId: "7", actionType: "FREE_ACCESS_OVERRIDE", reason: "Scholarship approved by board" },
      }),
      /FOREIGN KEY/,
    );
    assert.ok(state.rolledBack && !state.committed, "no ACTIVE free enrollment without its override record");
    assert.equal(state.audited, false);
  });

  it("refuses to enroll an unapproved student (BR-002)", async () => {
    let inserted = false;
    const pool = createMockPool((q) => {
      if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "PENDING", AccountStatus: "pending" }] };
      if (q.includes("INSERT INTO")) inserted = true;
      return { recordset: [] };
    });
    await assert.rejects(
      new SqlServerAdminRepository(pool).createEnrollment({
        studentUserId: "301", courseId: "5", status: "approved_unpaid", createdByUserId: "1",
        audit: { actorUserId: "1", actionType: "MANUAL_ENROLLMENT" },
      }),
      (err: Error & { code?: string }) => err.code === "STUDENT_NOT_APPROVED",
    );
    assert.equal(inserted, false);
  });

  it("refuses an enrollment whose batch belongs to another course", async () => {
    const pool = createMockPool((q) => {
      if (q.includes("SELECT sp.ApprovalStatus")) return { recordset: [{ ApprovalStatus: "APPROVED", AccountStatus: "active" }] };
      if (q.includes("SELECT ListPrice")) return { recordset: [{ ListPrice: 45000, CurrencyCode: "INR" }] };
      if (q.includes("SELECT CourseId, Status FROM dbo.NXA_Batches")) return { recordset: [{ CourseId: 9, Status: "upcoming" }] };
      return { recordset: [] };
    });
    await assert.rejects(
      new SqlServerAdminRepository(pool).createEnrollment({
        studentUserId: "301", courseId: "5", batchId: "101", status: "approved_unpaid", createdByUserId: "1",
        audit: { actorUserId: "1", actionType: "MANUAL_ENROLLMENT" },
      }),
      (err: Error & { code?: string }) => err.code === "BATCH_COURSE_MISMATCH",
    );
  });

  it("records old and new status when an enrollment status changes", async () => {
    let auditInputs: Record<string, unknown> = {};
    const pool = createMockPool((q, inputs) => {
      if (q.includes("SELECT EnrollmentStatus, ActivatedAt FROM dbo.NXA_Enrollments WITH (UPDLOCK)")) {
        return { recordset: [{ EnrollmentStatus: "SUSPENDED", ActivatedAt: new Date("2026-10-01") }] };
      }
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        auditInputs = { ...inputs };
        return { recordset: [{ AuditLogId: 2 }] };
      }
      return {
        recordset: [{
          EnrollmentId: 901, StudentUserId: 301, StudentName: null, StudentEmail: null, CourseId: 5, CourseTitle: null,
          BatchId: null, BatchCode: null, EnrollmentNumber: "E", EnrollmentStatus: "ACTIVE", CoursePrice: 1,
          DiscountAmount: 0, FinalAmount: 1, CurrencyCode: "INR", EnrollmentSource: "ADMIN", ActivatedAt: new Date(),
          CompletedAt: null, CreatedAt: new Date(),
        }],
        rowsAffected: [1],
      };
    });
    const enr = await new SqlServerAdminRepository(pool).setEnrollmentStatus("901", "active", {
      actorUserId: "1", actionType: "RESUME_ENROLLMENT", reason: "Suspension lifted after review",
    });
    assert.equal(enr.enrollmentStatus, "active");
    assert.match(String(auditInputs["oldVal"]), /suspended/);
    assert.match(String(auditInputs["newVal"]), /active/);
  });

  it("refuses to activate an enrollment that was never activated by payment or free access", async () => {
    let updated = false;
    const pool = createMockPool((q) => {
      if (q.includes("WITH (UPDLOCK)")) return { recordset: [{ EnrollmentStatus: "APPROVED_UNPAID", ActivatedAt: null }] };
      if (q.includes("UPDATE dbo.NXA_Enrollments")) updated = true;
      return { recordset: [] };
    });
    await assert.rejects(
      new SqlServerAdminRepository(pool).setEnrollmentStatus("901", "active", {
        actorUserId: "1", actionType: "RESUME_ENROLLMENT", reason: "Bank transfer verified by finance",
      }),
      (err: Error & { code?: string }) => err.code === "ACTIVATION_REQUIRES_PAYMENT",
    );
    assert.equal(updated, false);
  });

  it("records and queries administrative audit logs", async () => {
    const mockAuditRow = {
      AuditLogId: 88,
      ActorUserId: 201,
      ActorName: "Priya Nair",
      ActorRole: "admin",
      ActionType: "STUDENT_APPROVED",
      ModuleCode: "APPROVALS",
      EntityName: "StudentProfile",
      EntityId: "301",
      OldValues: JSON.stringify({ status: "pending" }),
      NewValues: JSON.stringify({ status: "approved" }),
      IpAddress: "192.168.1.100",
      UserAgent: "Mozilla/5.0",
      CorrelationId: "f768b314-1234-4567-89ab-cdef01234567",
      CreatedAt: new Date("2026-11-22T08:00:00Z"),
    };

    let logInserted = false;
    const pool = createMockPool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        logInserted = true;
        return { recordset: [{ AuditLogId: 88 }] };
      }
      return { recordset: [mockAuditRow] };
    });

    const repo = new SqlServerAdminRepository(pool);

    const logged = await repo.createAuditLog({
      actorUserId: "201",
      actionType: "STUDENT_APPROVED",
      moduleCode: "APPROVALS",
      entityName: "StudentProfile",
      entityId: "301",
      details: "Approved student registration",
    });
    assert.equal(logged.id, "88");
    assert.equal(logInserted, true);

    const logs = await repo.findAuditLogs({ actorUserId: "201" });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.actionType, "STUDENT_APPROVED");
  });

  describe("admin-created students (ADM-003)", () => {
    const trackedPool = (handler: (q: string, inputs: Record<string, unknown>) => unknown) => {
      const state = { committed: false, rolledBack: false };
      const pool = {
        request: () => new MockSqlRequest(handler),
        transaction: () => ({
          begin: async () => {},
          commit: async () => {
            state.committed = true;
          },
          rollback: async () => {
            state.rolledBack = true;
          },
          request: () => new MockSqlRequest(handler),
        }),
      } as unknown as sql.ConnectionPool;
      return { pool, state };
    };

    const input = {
      name: "Ravi Kumar",
      email: "Ravi.Kumar@Test.Local",
      mobile: "9123456780",
      passwordHash: "$argon2id$v=19$m=47104,t=1,p=1$c2FsdA$aGFzaA",
      createdByUserId: "7",
      collegeName: "Osmania University",
      passingYear: 2025,
      interestedCourseId: "5",
    };

    it("creates a pending, unverified student with the student role, profile and audit in one transaction", async () => {
      const order: string[] = [];
      let userInputs: Record<string, unknown> = {};
      let profileQuery = "";
      let roleCode: unknown;
      let auditInputs: Record<string, unknown> = {};
      const { pool, state } = trackedPool((q, inputs) => {
        assertNoUsersRoleColumn(q);
        if (q.includes("FROM dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
        if (q.includes("FROM dbo.NXA_Roles")) {
          roleCode = inputs["roleCode"];
          return { recordset: [{ RoleId: 3 }] };
        }
        if (q.includes("INSERT INTO dbo.NXA_Users")) {
          order.push("user");
          userInputs = { ...inputs };
          assert.match(q, /@accountStatus/);
          assert.match(q, /PasswordHash/);
          return { recordset: [{ UserId: 501 }] };
        }
        if (q.includes("INSERT INTO dbo.NXA_UserRoles")) {
          order.push("role");
          return { recordset: [] };
        }
        if (q.includes("FROM dbo.NXA_Courses")) return { recordset: [{ x: 1 }] };
        if (q.includes("INSERT INTO dbo.NXA_StudentProfiles")) {
          order.push("profile");
          profileQuery = q;
          return { recordset: [] };
        }
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
          order.push("audit");
          auditInputs = { ...inputs };
          return { recordset: [{ AuditLogId: 1 }] };
        }
        return { recordset: [] };
      });

      const created = await new SqlServerAdminRepository(pool).createStudentUser(input);

      assert.equal(created.id, "501");
      assert.equal(created.accountState, "pending_verification");
      assert.equal(roleCode, "student");
      assert.equal(userInputs["accountStatus"], "pending", "never active just because an admin created it");
      assert.equal(userInputs["normalizedEmail"], "ravi.kumar@test.local");
      assert.equal(userInputs["normalizedMobile"], "+919123456780");
      assert.equal(userInputs["passwordHash"], input.passwordHash);
      assert.match(profileQuery, /'pending'/, "approval starts pending");
      assert.deepEqual(order, ["user", "role", "profile", "audit"]);
      assert.equal(auditInputs["action"], "CREATE_STUDENT");
      assert.equal(auditInputs["actorId"], "7");
      assert.doesNotMatch(String(auditInputs["newVal"]), /argon2/, "the hash is never audited");
      assert.ok(state.committed && !state.rolledBack);
    });

    it("rolls back when the interested course does not exist", async () => {
      let profileWritten = false;
      const { pool, state } = trackedPool((q) => {
        if (q.includes("FROM dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
        if (q.includes("FROM dbo.NXA_Roles")) return { recordset: [{ RoleId: 3 }] };
        if (q.includes("INSERT INTO dbo.NXA_Users")) return { recordset: [{ UserId: 502 }] };
        if (q.includes("FROM dbo.NXA_Courses")) return { recordset: [] };
        if (q.includes("INSERT INTO dbo.NXA_StudentProfiles")) profileWritten = true;
        return { recordset: [] };
      });
      await assert.rejects(
        new SqlServerAdminRepository(pool).createStudentUser(input),
        (err: Error & { code?: string }) => err.code === "COURSE_NOT_FOUND",
      );
      assert.equal(profileWritten, false);
      assert.ok(state.rolledBack && !state.committed);
    });

    it("reports a duplicate email and refuses an unseeded student role", async () => {
      const { pool: dupPool } = trackedPool((q) =>
        q.includes("FROM dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")
          ? { recordset: [{ NormalizedEmail: "ravi.kumar@test.local", NormalizedMobile: "+919000000000" }] }
          : { recordset: [] },
      );
      await assert.rejects(
        new SqlServerAdminRepository(dupPool).createStudentUser(input),
        (err: Error & { field?: string }) => err.name === "DuplicateRecordError" && err.field === "email",
      );

      const { pool: noRolePool, state } = trackedPool(() => ({ recordset: [] }));
      await assert.rejects(new SqlServerAdminRepository(noRolePool).createStudentUser(input), /not seeded/);
      assert.ok(state.rolledBack);
    });
  });

  describe("refunds and financial overrides", () => {
    const refundRow = (status: string) => ({
      RefundId: 55,
      RefundReference: "REF-2026-001",
      TransactionId: 1001,
      RequestedByUserId: 301,
      Amount: 15000,
      Reason: "Duplicate course enrollment",
      RefundStatus: status,
      GatewayRefundId: null,
      RequestedAt: new Date("2026-11-10"),
      ApprovedAt: status === "APPROVED" ? new Date("2026-11-12") : null,
      ApprovedBySuperAdminUserId: status === "APPROVED" ? 101 : null,
      CompletedAt: null,
    });

    const overrideRow = (approvedBy: number) => ({
      EnrollmentOverrideId: 77,
      EnrollmentId: 901,
      OverrideType: "FREE_ACCESS",
      Reason: "State entrance rank holder",
      ApprovedByUserId: approvedBy,
      CreatedAt: new Date("2026-11-09"),
      StudentUserId: 301,
      StudentName: "Asha Rao",
      StudentEmail: "asha@example.com",
      CourseId: 5,
      CourseTitle: "Full Stack Java",
      CoursePrice: 45000,
      DiscountAmount: 45000,
      FinalAmount: 0,
    });

    /** Mock pool that also records whether the transaction committed or rolled back. */
    const trackedPool = (handler: (q: string, inputs: Record<string, unknown>) => unknown) => {
      const state = { committed: false, rolledBack: false };
      const pool = {
        request: () => new MockSqlRequest(handler),
        transaction: () => ({
          begin: async () => {},
          commit: async () => {
            state.committed = true;
          },
          rollback: async () => {
            state.rolledBack = true;
          },
          request: () => new MockSqlRequest(handler),
        }),
      } as unknown as sql.ConnectionPool;
      return { pool, state };
    };

    it("lists refunds with explicit columns", async () => {
      const { pool } = trackedPool((q) => {
        assert.doesNotMatch(q, /SELECT \*/);
        return { recordset: [refundRow("PENDING")] };
      });
      const refunds = await new SqlServerAdminRepository(pool).findRefunds();
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0]!.refundStatus, "pending");
    });

    it("approves a pending refund under a lock and audits it in the same transaction", async () => {
      let decided = false;
      let updateInputs: Record<string, unknown> = {};
      let auditInputs: Record<string, unknown> = {};
      const { pool, state } = trackedPool((q, inputs) => {
        if (q.includes("WITH (UPDLOCK)")) return { recordset: [{ RefundStatus: "PENDING", Amount: 15000 }] };
        if (q.includes("UPDATE dbo.NXA_Refunds")) {
          assert.match(q, /UPPER\(RefundStatus\) = 'PENDING'/, "the update itself is guarded");
          decided = true;
          updateInputs = { ...inputs };
          return { recordset: [], rowsAffected: [1] };
        }
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
          assert.ok(decided, "audit is written after the update");
          auditInputs = { ...inputs };
          return { recordset: [{ AuditLogId: 9 }] };
        }
        return { recordset: [refundRow(decided ? "APPROVED" : "PENDING")] };
      });

      const refund = await new SqlServerAdminRepository(pool).updateRefundStatus("55", "approved", "101", "Policy clause 4.2");
      assert.equal(refund.refundStatus, "approved");
      assert.equal(updateInputs["status"], "APPROVED");
      assert.equal(auditInputs["action"], "APPROVE_REFUND");
      assert.equal(auditInputs["module"], "FINANCE");
      assert.match(String(auditInputs["oldVal"]), /pending/);
      assert.match(String(auditInputs["newVal"]), /Policy clause 4\.2/);
      assert.ok(state.committed && !state.rolledBack);
    });

    it("rejects deciding a refund that is not pending and rolls back", async () => {
      let updated = false;
      const { pool, state } = trackedPool((q) => {
        if (q.includes("WITH (UPDLOCK)")) return { recordset: [{ RefundStatus: "APPROVED", Amount: 15000 }] };
        if (q.includes("UPDATE dbo.NXA_Refunds") || q.includes("INSERT INTO dbo.NXA_AuditLogs")) updated = true;
        return { recordset: [] };
      });
      await assert.rejects(
        new SqlServerAdminRepository(pool).updateRefundStatus("55", "rejected", "101", "Outside refund window"),
        (err: Error & { code?: string; status?: number }) => err.code === "REFUND_ALREADY_DECIDED" && err.status === 409,
      );
      assert.equal(updated, false);
      assert.ok(state.rolledBack && !state.committed);
    });

    it("reports an unknown refund as not found", async () => {
      const { pool } = trackedPool(() => ({ recordset: [] }));
      await assert.rejects(
        new SqlServerAdminRepository(pool).updateRefundStatus("56", "approved", "101"),
        (err: Error) => err.name === "RecordNotFoundError",
      );
      await assert.rejects(
        new SqlServerAdminRepository(pool).updateRefundStatus("ref-x", "approved", "101"),
        (err: Error) => err.name === "RecordNotFoundError",
      );
    });

    it("lists overrides as a read-only history with the granting user", async () => {
      let listQuery = "";
      const { pool } = trackedPool((q) => {
        listQuery = q;
        return { recordset: [{ ...overrideRow(7), ApprovedByName: "Ravi Admin" }] };
      });
      const [o] = await new SqlServerAdminRepository(pool).findFinancialOverrides();
      assert.match(listQuery, /JOIN dbo\.NXA_Enrollments/);
      assert.match(listQuery, /au\.UserId = fo\.ApprovedByUserId/);
      assert.doesNotMatch(listQuery, /ApprovedByUserId IS NULL/, "the live column is NOT NULL");
      assert.doesNotMatch(listQuery, /OverrideType = @status/, "status is not matched against the override type");
      assert.equal(o!.studentId, "301");
      assert.equal(o!.studentName, "Asha Rao");
      assert.equal(o!.courseTitle, "Full Stack Java");
      assert.equal(o!.originalAmountINR, 45000);
      assert.equal(o!.proposedAmountINR, 0);
      assert.equal(o!.discountOrWaiverINR, 45000);
      assert.equal(o!.adjustmentType, "FREE_ACCESS");
      assert.equal(o!.requestedByAdminId, "7", "ApprovedByUserId is the user who granted the override");
      assert.equal(o!.requestedByAdminName, "Ravi Admin");
      assert.equal(o!.status, "approved");
      assert.equal(o!.decidedAt, new Date("2026-11-09").toISOString());
      assert.equal(o!.decidedBySuperAdminId, undefined, "the granting user is not presented as a Super Admin decision");
    });

    it("returns no overrides for the pending or rejected filters", async () => {
      const queries: string[] = [];
      const { pool } = trackedPool((q) => {
        queries.push(q);
        return { recordset: [] };
      });
      const repo = new SqlServerAdminRepository(pool);
      assert.deepEqual(await repo.findFinancialOverrides("pending"), []);
      assert.deepEqual(await repo.findFinancialOverrides("rejected"), []);
      assert.equal(queries.length, 2);
      for (const q of queries) assert.match(q, /1=0/);
    });

    it("refuses to approve an override again and writes nothing", async () => {
      const writes: string[] = [];
      const { pool, state } = trackedPool((q) => {
        if (/\b(UPDATE|INSERT|DELETE|MERGE)\b/.test(q)) writes.push(q);
        return { recordset: [overrideRow(7)] };
      });
      await assert.rejects(
        new SqlServerAdminRepository(pool).updateFinancialOverride("77", "approved", "101"),
        (err: Error & { code?: string; status?: number }) => err.code === "OVERRIDE_ALREADY_DECIDED" && err.status === 409,
      );
      assert.deepEqual(writes, []);
      assert.ok(!state.committed, "no transaction is committed");

      const { pool: emptyPool } = trackedPool(() => ({ recordset: [] }));
      await assert.rejects(
        new SqlServerAdminRepository(emptyPool).updateFinancialOverride("78", "approved", "101"),
        (err: Error) => err.name === "RecordNotFoundError",
      );
    });

    it("refuses override rejection without touching the database", async () => {
      let queried = false;
      const { pool } = trackedPool(() => {
        queried = true;
        return { recordset: [] };
      });
      await assert.rejects(
        new SqlServerAdminRepository(pool).updateFinancialOverride("77", "rejected", "101", "Criteria not met"),
        (err: Error & { code?: string }) => err.code === "OVERRIDE_REJECTION_UNSUPPORTED",
      );
      assert.equal(queried, false);
    });
  });

  it("reads institute settings without inventing values for unset keys", async () => {
    const pool = createMockPool(() => ({
      recordset: [
        { SettingKey: "instituteName", SettingValue: "Nexelvoria Premier Institute" },
        { SettingKey: "minAttendancePercentage", SettingValue: "80" },
      ],
    }));
    const settings = await new SqlServerAdminRepository(pool).getInstituteSettings();
    assert.equal(settings.instituteName, "Nexelvoria Premier Institute");
    assert.equal(settings.minAttendancePercentage, 80);
    assert.equal(settings.timezone, "Asia/Kolkata");
    assert.equal(settings.gstNumber, undefined, "no placeholder GST number");
    assert.equal(settings.supportPhone, undefined, "no placeholder phone");
  });

  it("saves only changed settings, attributed and audited in one transaction", async () => {
    const merged: string[] = [];
    let auditInputs: Record<string, unknown> = {};
    const pool = createMockPool((q, inputs) => {
      if (q.includes("FROM dbo.NXA_InstituteSettings WITH (UPDLOCK)")) {
        return { recordset: [{ SettingKey: "tagline", SettingValue: "Old Tagline" }, { SettingKey: "timezone", SettingValue: "Asia/Kolkata" }] };
      }
      if (q.includes("MERGE dbo.NXA_InstituteSettings")) {
        merged.push(String(inputs["key"]));
        assert.equal(inputs["userId"], "101");
        return { recordset: [] };
      }
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        auditInputs = { ...inputs };
        return { recordset: [{ AuditLogId: 5 }] };
      }
      return { recordset: [] };
    });

    await new SqlServerAdminRepository(pool).saveInstituteSettings({ tagline: "New Tagline", timezone: "Asia/Kolkata" }, "101");
    assert.deepEqual(merged, ["tagline"], "an unchanged key is not rewritten");
    assert.equal(auditInputs["action"], "UPDATE_SETTINGS");
    assert.equal(auditInputs["actorId"], "101");
    assert.equal(auditInputs["oldVal"], JSON.stringify({ tagline: "Old Tagline" }));
    assert.equal(auditInputs["newVal"], JSON.stringify({ tagline: "New Tagline" }));
  });

  it("lists NXA_Roles rows with no invented permissions", async () => {
    const pool = createMockPool(() => ({
      recordset: [{
        RoleId: 1, RoleCode: "super_admin", RoleName: "Super Administrator", Description: null,
        IsSystemRole: true, IsActive: true, CreatedAt: new Date("2026-01-01"),
      }],
    }));
    const roles = await new SqlServerAdminRepository(pool).findRoles();
    assert.equal(roles.length, 1);
    assert.equal(roles[0]!.roleCode, "super_admin");
    assert.deepEqual(roles[0]!.permissions, []);
  });
});
