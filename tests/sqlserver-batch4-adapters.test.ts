import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type sql from "mssql";

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

describe("SqlServerAdminRepository (unit with mock pool)", () => {
  it("calculates dashboard stats correctly", async () => {
    const pool = createMockPool((q) => {
      if (q.includes("GROUP BY Role, AccountStatus")) {
        return {
          recordset: [
            { role: "student", status: "active", cnt: 85 },
            { role: "student", status: "pending", cnt: 10 },
            { role: "teacher", status: "active", cnt: 12 },
          ],
        };
      }
      if (q.includes("FROM dbo.NXA_Courses")) return { recordset: [{ cnt: 6 }] };
      if (q.includes("FROM dbo.NXA_Batches")) return { recordset: [{ cnt: 4 }] };
      if (q.includes("FROM dbo.NXA_Enrollments")) {
        if (q.includes("SUM")) {
          return { recordset: [{ totalRevenue: 1250000, pendingRevenue: 150000 }] };
        }
        return { recordset: [{ cnt: 95 }] };
      }
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
    assert.equal(stats.totalRevenueINR, 1250000);
    assert.equal(stats.pendingFeesINR, 150000);
  });

  it("calculates super admin dashboard stats correctly", async () => {
    const pool = createMockPool((q) => {
      if (q.includes("GROUP BY Role")) {
        return {
          recordset: [
            { role: "student", cnt: 110 },
            { role: "teacher", cnt: 14 },
            { role: "admin", cnt: 3 },
            { role: "super_admin", cnt: 1 },
          ],
        };
      }
      if (q.includes("FROM dbo.NXA_EnrollmentOverrides")) return { recordset: [{ cnt: 2 }] };
      if (q.includes("FROM dbo.NXA_Refunds")) return { recordset: [{ cnt: 1 }] };
      if (q.includes("FROM dbo.NXA_Batches")) return { recordset: [{ cnt: 5 }] };
      return { recordset: [] };
    });

    const repo = new SqlServerAdminRepository(pool);
    const stats = await repo.getSuperAdminDashboardStats();

    assert.equal(stats.totalActiveStudents, 110);
    assert.equal(stats.totalFacultyMembers, 14);
    assert.equal(stats.totalAdminAccounts, 4);
    assert.equal(stats.pendingFinancialOverrides, 2);
    assert.equal(stats.pendingRefundRequests, 1);
    assert.equal(stats.activeCourseBatches, 5);
  });

  it("manages admin accounts: query, creation, update and status", async () => {
    const mockAdminRow = {
      UserId: 201,
      FullName: "Priya Nair",
      Email: "priya.nair@nexelvoria.edu.in",
      MobileNumber: "9876511223",
      Role: "admin",
      AccountStatus: "active",
      CreatedAt: new Date("2026-06-15T09:30:00Z"),
      EmployeeCode: "EMP-ADM-001",
      AdminLevel: "Admissions",
      IsActive: true,
    };

    let updateExecuted = false;
    const pool = createMockPool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Users")) return { recordset: [{ UserId: 201 }] };
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

    const created = await repo.createAdmin({
      name: "Priya Nair",
      email: "priya.nair@nexelvoria.edu.in",
      mobile: "9876511223",
      department: "Admissions",
    });
    assert.equal(created.id, "201");
    assert.equal(created.email, "priya.nair@nexelvoria.edu.in");

    const updated = await repo.updateAdmin("201", { mobile: "9876599999" });
    assert.equal(updated.name, "Priya Nair");
    assert.equal(updateExecuted, true);

    const suspended = await repo.setAdminStatus("201", "suspended");
    assert.equal(suspended.id, "201");
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
      CreatedAt: new Date("2026-02-01"),
      CollegeName: "BITS Pilani",
      DegreeBranch: "B.Tech CSE",
      PassingYear: "2026",
      CourseInterestedIn: "Full Stack Development",
    };

    const pool = createMockPool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_TeacherAllocations")) {
        allocated = true;
        return { recordset: [] };
      }
      if (q.includes("UPDATE dbo.NXA_TeacherAllocations")) {
        unallocated = true;
        return { recordset: [] };
      }
      return { recordset: [mockStudentRow] };
    });

    const repo = new SqlServerAdminRepository(pool);

    await repo.allocateTeacher("101", "501", "5");
    assert.equal(allocated, true);

    await repo.unallocateTeacher("101", "501");
    assert.equal(unallocated, true);

    const roster = await repo.findBatchStudents("101");
    assert.equal(roster.length, 1);
    assert.equal(roster[0]!.name, "Aarav Sharma");
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

    const pool = createMockPool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Enrollments")) return { recordset: [{ EnrollmentId: 901 }] };
      return { recordset: [mockEnrollmentRow], rowsAffected: [1] };
    });

    const repo = new SqlServerAdminRepository(pool);

    const created = await repo.createEnrollment({
      studentUserId: "301",
      courseId: "5",
      batchId: "101",
      coursePrice: 45000,
      finalAmount: 40000,
    });
    assert.equal(created.id, "901");

    const list = await repo.findEnrollments({ studentId: "301" });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.enrollmentStatus, "active");
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

  it("manages refunds and financial overrides", async () => {
    const mockRefundRow = {
      RefundId: 55,
      RefundReference: "REF-2026-001",
      TransactionId: 1001,
      RequestedByUserId: 301,
      Amount: 15000,
      Reason: "Duplicate course enrollment",
      RefundStatus: "PENDING",
      GatewayRefundId: null,
      RequestedAt: new Date("2026-11-10"),
      ApprovedAt: null,
      ApprovedBySuperAdminUserId: null,
      CompletedAt: null,
    };

    const mockOverrideRow = {
      EnrollmentOverrideId: 77,
      EnrollmentId: 901,
      OverrideType: "merit_scholarship",
      Reason: "State entrance rank holder",
      ApprovedByUserId: null,
      CreatedAt: new Date("2026-11-09"),
    };

    const pool = createMockPool((q) => {
      if (q.includes("FROM dbo.NXA_Refunds")) return { recordset: [mockRefundRow], rowsAffected: [1] };
      if (q.includes("FROM dbo.NXA_EnrollmentOverrides")) return { recordset: [mockOverrideRow], rowsAffected: [1] };
      return { recordset: [], rowsAffected: [1] };
    });

    const repo = new SqlServerAdminRepository(pool);

    const refunds = await repo.findRefunds();
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0]!.refundStatus, "pending");

    const decidedRefund = await repo.updateRefundStatus("55", "approved", "101");
    assert.equal(decidedRefund.id, "55");

    const overrides = await repo.findFinancialOverrides();
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0]!.status, "pending");

    const decidedOverride = await repo.updateFinancialOverride("77", "approved", "101");
    assert.equal(decidedOverride.status, "approved");
  });

  it("retrieves and merges institute settings", async () => {
    const mockSettingRows = [
      { SettingKey: "instituteName", SettingValue: "Nexelvoria Premier Institute" },
      { SettingKey: "minAttendancePercentage", SettingValue: "80" },
    ];

    let merged = false;
    const pool = createMockPool((q) => {
      if (q.includes("MERGE dbo.NXA_InstituteSettings")) {
        merged = true;
        return { recordset: [] };
      }
      return { recordset: mockSettingRows };
    });

    const repo = new SqlServerAdminRepository(pool);

    const settings = await repo.getInstituteSettings();
    assert.equal(settings.instituteName, "Nexelvoria Premier Institute");
    assert.equal(settings.minAttendancePercentage, 80);

    await repo.saveInstituteSettings({ tagline: "New Tagline" }, "101");
    assert.equal(merged, true);
  });

  it("manages global RBAC roles and permissions", async () => {
    const mockRoleRows = [
      {
        RoleId: 1,
        RoleCode: "super_admin",
        RoleName: "Super Administrator",
        Description: "Complete system access",
        IsSystemRole: true,
        IsActive: true,
        CreatedAt: new Date("2026-01-01"),
      },
    ];

    const pool = createMockPool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Roles")) return { recordset: [{ RoleId: 3 }] };
      return { recordset: mockRoleRows };
    });

    const repo = new SqlServerAdminRepository(pool);

    const roles = await repo.findRoles();
    assert.equal(roles.length, 1);
    assert.equal(roles[0]!.roleCode, "super_admin");

    const createdRole = await repo.createRole({
      roleCode: "counselor",
      roleName: "Admissions Counselor",
      description: "Handles student onboarding and enquiries",
      permissions: ["view_students", "manage_enquiries"],
    });
    assert.equal(createdRole.id, "3");
    assert.equal(createdRole.roleCode, "counselor");
  });
});
