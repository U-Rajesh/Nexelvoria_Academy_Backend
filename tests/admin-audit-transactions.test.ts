import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import type { StaffAudit } from "../src/modules/admin/admin.repository";
import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Batch 3 item 10C: SEC audit logs. Admin account, batch, teacher allocation,
 * account unlock and teacher creation changes are audited in the SAME
 * transaction as the change: both commit or neither does, a failed audit
 * write fails the request, and a no-op writes neither.
 *
 * Mock pools and in-memory fakes only - live SQL Server behaviour is not
 * exercised here.
 */

// ------------------------------------------------------------------ mock pool
interface Executed {
  q: string;
  inputs: Record<string, unknown>;
}

const makePool = (handler: (q: string) => unknown, opts: { failAudit?: boolean } = {}) => {
  const state = { tx: [] as Executed[], pool: [] as Executed[], begins: 0, commits: 0, rollbacks: 0 };
  class Req {
    inputs: Record<string, unknown> = {};
    constructor(private readonly where: "tx" | "pool") {}
    input(name: string, typeOrValue: unknown, value?: unknown): this {
      this.inputs[name] = value !== undefined ? value : typeOrValue;
      return this;
    }
    async query(q: string) {
      state[this.where].push({ q, inputs: { ...this.inputs } });
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) {
        if (opts.failAudit) throw new Error("audit write failed");
        return { recordset: [{ AuditLogId: 9001 }], rowsAffected: [1] };
      }
      const r = (handler(q) ?? {}) as { recordset?: unknown[]; rowsAffected?: number[] };
      return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
    }
  }
  const pool = {
    request: () => new Req("pool"),
    transaction: () => ({
      begin: async () => void state.begins++,
      commit: async () => void state.commits++,
      rollback: async () => void state.rollbacks++,
      request: () => new Req("tx"),
    }),
  } as unknown as sql.ConnectionPool;
  return { repo: new SqlServerAdminRepository(pool), state };
};

const auditsIn = (list: Executed[]) => list.filter((e) => e.q.includes("INSERT INTO dbo.NXA_AuditLogs"));
const ACTOR = "9";
const audit = (actionType: string, moduleCode: string, entityName: string, details: string): StaffAudit => ({
  actorUserId: ACTOR,
  actionType,
  moduleCode,
  entityName,
  details,
});

const adminRow = {
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
const batchRow = {
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

const staffCreateHandler = (q: string) => {
  if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
  if (q.includes("FROM dbo.NXA_Roles WHERE")) return { recordset: [{ RoleId: 2 }] };
  if (q.includes("INSERT INTO dbo.NXA_Users")) return { recordset: [{ UserId: 201 }] };
  if (q.includes("INSERT INTO")) return { recordset: [] };
  return { recordset: [{ ...adminRow, Specialization: "Python", ExperienceYears: 4 }] };
};
const adminHandler = (q: string) => {
  if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [] };
  return { recordset: [adminRow] };
};
const batchHandler = (q: string) => {
  if (q.includes("INSERT INTO dbo.NXA_Batches")) return { recordset: [{ BatchId: 101 }] };
  return { recordset: [batchRow] };
};
const allocationHandler = (q: string) => {
  if (q.includes("AlreadyAllocated")) return { recordset: [{ AlreadyAllocated: false }] };
  if (q.includes("FROM dbo.NXA_Batches WITH (UPDLOCK)")) return { recordset: [{ CourseId: 5, Status: "ongoing" }] };
  if (q.includes("SELECT u.AccountStatus")) return { recordset: [{ AccountStatus: "active" }] };
  return { recordset: [] };
};

interface Op {
  name: string;
  handler: (q: string) => unknown;
  /** A query that IS the change; it must run in the transaction before the audit. */
  mutation: RegExp;
  entityId: string;
  entry: StaffAudit;
  run: (repo: SqlServerAdminRepository, a: StaffAudit) => Promise<unknown>;
}

const OPS: Op[] = [
  {
    name: "createAdmin",
    handler: staffCreateHandler,
    mutation: /INSERT INTO dbo\.NXA_AdminProfiles/,
    entityId: "201",
    entry: audit("CREATE_ADMIN", "ADMIN_MGMT", "AdminProfile", "Created admin priya.nair@nexelvoria.edu.in"),
    run: (r, a) =>
      r.createAdmin({ name: "Priya Nair", email: "priya.nair@nexelvoria.edu.in", mobile: "9876511223", passwordHash: "$argon2id$secret-hash", assignedByUserId: ACTOR }, a),
  },
  {
    name: "updateAdmin",
    handler: adminHandler,
    mutation: /UPDATE dbo\.NXA_Users\s+SET FullName/,
    entityId: "201",
    entry: audit("UPDATE_ADMIN", "ADMIN_MGMT", "AdminProfile", "Updated admin details"),
    run: (r, a) => r.updateAdmin("201", { mobile: "9876599999" }, a),
  },
  {
    name: "setAdminStatus",
    handler: adminHandler,
    mutation: /SET AccountStatus = @status/,
    entityId: "201",
    entry: audit("SET_ADMIN_STATUS", "ADMIN_MGMT", "AdminProfile", "Status set to suspended"),
    run: (r, a) => r.setAdminStatus("201", "suspended", a),
  },
  {
    name: "setAdminPassword",
    handler: adminHandler,
    mutation: /SET PasswordHash = @passwordHash/,
    entityId: "201",
    entry: audit("RESET_ADMIN_PASSWORD", "ADMIN_MGMT", "AdminProfile", "Temporary password issued; sessions revoked"),
    run: (r, a) => r.setAdminPassword("201", "$argon2id$secret-hash", a),
  },
  {
    name: "createBatch",
    handler: batchHandler,
    mutation: /INSERT INTO dbo\.NXA_Batches/,
    entityId: "101",
    entry: audit("CREATE_BATCH", "BATCH_MGMT", "Batch", "Created batch BAT-PY-01"),
    run: (r, a) => r.createBatch({ courseId: "5", batchCode: "BAT-PY-01", batchName: "Python Full Stack Spring 2026" }, a),
  },
  {
    name: "updateBatch",
    handler: batchHandler,
    mutation: /UPDATE dbo\.NXA_Batches\s+SET BatchName/,
    entityId: "101",
    entry: audit("UPDATE_BATCH", "BATCH_MGMT", "Batch", "Updated batch"),
    run: (r, a) => r.updateBatch("101", { batchName: "Python Full Stack Autumn 2026" }, a),
  },
  {
    name: "setBatchStatus",
    handler: batchHandler,
    mutation: /UPDATE dbo\.NXA_Batches\s+SET Status/,
    entityId: "101",
    entry: audit("SET_BATCH_STATUS", "BATCH_MGMT", "Batch", "Batch status set to completed"),
    run: (r, a) => r.setBatchStatus("101", "completed", a),
  },
  {
    name: "allocateTeacher",
    handler: allocationHandler,
    mutation: /INSERT INTO dbo\.NXA_TeacherAllocations/,
    entityId: "101",
    entry: audit("ALLOCATE_TEACHER", "TEACHER_ALLOC", "TeacherAllocation", "Allocated teacher 301 to course 5, batch 101"),
    run: (r, a) => r.allocateTeacher({ batchId: "101", courseId: "5", teacherUserId: "301", allocatedByUserId: ACTOR }, a),
  },
  {
    name: "unallocateTeacher",
    handler: () => ({ recordset: [] }),
    mutation: /SET IsActive = 0/,
    entityId: "101",
    entry: audit("UNALLOCATE_TEACHER", "TEACHER_ALLOC", "TeacherAllocation", "Unallocated teacher 301"),
    run: (r, a) => r.unallocateTeacher("101", "301", a),
  },
  {
    name: "unlockUserAccount",
    handler: () => ({ recordset: [] }),
    mutation: /SET FailedLoginAttempts = 0, IsLocked = 0/,
    entityId: "42",
    entry: audit("UNLOCK_ACCOUNT", "USER_MGMT", "User", "Cleared login lockout"),
    run: (r, a) => r.unlockUserAccount("42", a),
  },
  {
    name: "createTeacherUser",
    handler: staffCreateHandler,
    mutation: /INSERT INTO dbo\.NXA_TeacherProfiles/,
    entityId: "201",
    entry: audit("CREATE_TEACHER", "TEACHER_MGMT", "Teacher", "Created faculty priya.nair@nexelvoria.edu.in"),
    run: (r, a) =>
      r.createTeacherUser({ name: "Priya Nair", email: "priya.nair@nexelvoria.edu.in", mobile: "9876511223", passwordHash: "$argon2id$secret-hash", assignedByUserId: ACTOR }, a),
  },
];

describe("SEC audit: change and audit share one SQL transaction (mock pool)", () => {
  for (const op of OPS) {
    it(`${op.name}: commits the change and its audit row together, with actor and entity`, async () => {
      const { repo, state } = makePool(op.handler);
      await op.run(repo, op.entry);

      const audits = auditsIn(state.tx);
      assert.equal(audits.length, 1, "exactly one audit row, written on the transaction");
      assert.equal(auditsIn(state.pool).length, 0, "no audit written outside the transaction");
      assert.equal(state.commits, 1);
      assert.equal(state.rollbacks, 0);

      const mutationAt = state.tx.findIndex((e) => op.mutation.test(e.q));
      const auditAt = state.tx.indexOf(audits[0]!);
      assert.ok(mutationAt >= 0, "the change runs on the same transaction");
      assert.ok(mutationAt < auditAt, "the audit row follows the change, before commit");

      const i = audits[0]!.inputs;
      assert.equal(i["actorId"], ACTOR);
      assert.equal(i["action"], op.entry.actionType);
      assert.equal(i["module"], op.entry.moduleCode);
      assert.equal(i["ename"], op.entry.entityName);
      assert.equal(i["eid"], op.entityId);
      assert.equal(i["newVal"], JSON.stringify({ note: op.entry.details }));
      assert.doesNotMatch(JSON.stringify(i), /argon2id|secret-hash/, "no password hash in the audit row");
    });

    it(`${op.name}: an audit write failure rolls the change back and fails the call`, async () => {
      const { repo, state } = makePool(op.handler, { failAudit: true });
      await assert.rejects(op.run(repo, op.entry), /audit write failed/);
      assert.equal(state.commits, 0, "nothing is committed");
      assert.equal(state.rollbacks, 1, "the change is rolled back");
    });
  }

  it("is unchanged for callers that pass no audit entry (no audit row)", async () => {
    const { repo, state } = makePool(batchHandler);
    await repo.createBatch({ courseId: "5", batchCode: "BAT-PY-01", batchName: "Python" });
    assert.equal(auditsIn(state.tx).length, 0);
    assert.equal(state.commits, 1);
  });

  // ---------------------------------------------------------------- no-ops
  it("no-op saves write nothing and are not audited", async () => {
    const a = audit("X", "Y", "Z", "n");

    const sameAdmin = makePool(adminHandler);
    await sameAdmin.repo.updateAdmin("201", { name: "Priya Nair", mobile: "9876511223", department: "Admissions" }, a);
    assert.equal(sameAdmin.state.begins, 0, "unchanged admin: no transaction, no write");
    assert.equal(auditsIn(sameAdmin.state.tx).length, 0);

    const sameBatch = makePool(batchHandler);
    await sameBatch.repo.updateBatch("101", { batchName: batchRow.BatchName, capacity: 45 }, a);
    assert.equal(sameBatch.state.begins, 0, "unchanged batch: no transaction, no write");
    assert.equal(auditsIn(sameBatch.state.tx).length, 0);

    // The conditional UPDATE matches no row when the value is already set.
    const noRow = (pattern: RegExp, fallback: (q: string) => unknown) => (q: string) =>
      pattern.test(q) ? { recordset: [], rowsAffected: [0] } : fallback(q);

    const sameAdminStatus = makePool(noRow(/SET AccountStatus = @status/, adminHandler));
    const admin = await sameAdminStatus.repo.setAdminStatus("201", "active", a);
    assert.equal(admin.id, "201");
    assert.equal(auditsIn(sameAdminStatus.state.tx).length, 0, "same admin status: no audit");
    assert.match(sameAdminStatus.state.tx[0]!.q, /<> @status/, "the update itself only matches a real change");

    const sameBatchStatus = makePool(noRow(/SET Status = @status/, batchHandler));
    await sameBatchStatus.repo.setBatchStatus("101", "ongoing", a);
    assert.equal(auditsIn(sameBatchStatus.state.tx).length, 0, "same batch status: no audit");

    const notLocked = makePool((q) =>
      /SET FailedLoginAttempts/.test(q) ? { recordset: [], rowsAffected: [0] } : { recordset: [{ x: 1 }] },
    );
    await notLocked.repo.unlockUserAccount("42", a);
    assert.equal(auditsIn(notLocked.state.tx).length, 0, "nothing to unlock: no audit");
    assert.match(notLocked.state.tx[0]!.q, /LockoutUntil IS NOT NULL/);
    assert.doesNotMatch(notLocked.state.tx[0]!.q, /AccountStatus/, "unlock never changes the account status");
  });

  // ---------------------------------------------------------------- business failures
  it("business failures roll back and write no audit row", async () => {
    const a = audit("X", "Y", "Z", "n");

    const noCourse = makePool((q) => (q.includes("FROM dbo.NXA_Courses") ? { recordset: [] } : batchHandler(q)));
    await assert.rejects(noCourse.repo.createBatch({ courseId: "5", batchCode: "B1", batchName: "Batch" }, a), /not found/);
    assert.equal(noCourse.state.tx.some((e) => e.q.includes("INSERT INTO dbo.NXA_Batches")), false);
    assert.equal(auditsIn(noCourse.state.tx).length, 0);
    assert.equal(noCourse.state.rollbacks, 1);

    const throwingDup = makePool((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Batches")) throw Object.assign(new Error("Violation of UNIQUE KEY"), { number: 2627 });
      return batchHandler(q);
    });
    await assert.rejects(throwingDup.repo.createBatch({ courseId: "5", batchCode: "B1", batchName: "Batch" }, a), (e: Error) => e.name === "DuplicateRecordError");
    assert.equal(auditsIn(throwingDup.state.tx).length, 0);
    assert.equal(throwingDup.state.commits, 0);

    const already = makePool((q) => (q.includes("AlreadyAllocated") ? { recordset: [{ AlreadyAllocated: true }] } : allocationHandler(q)));
    await assert.rejects(already.repo.allocateTeacher({ batchId: "101", courseId: "5", teacherUserId: "301", allocatedByUserId: ACTOR }, a), (e: Error) => e.name === "DuplicateRecordError");
    assert.equal(auditsIn(already.state.tx).length, 0);
    assert.equal(already.state.rollbacks, 1);

    const mismatch = makePool((q) => (q.includes("FROM dbo.NXA_Batches WITH (UPDLOCK)") ? { recordset: [{ CourseId: 6, Status: "ongoing" }] } : allocationHandler(q)));
    await assert.rejects(mismatch.repo.allocateTeacher({ batchId: "101", courseId: "5", teacherUserId: "301", allocatedByUserId: ACTOR }, a), /does not belong/);
    assert.equal(auditsIn(mismatch.state.tx).length, 0);

    const noAllocation = makePool(() => ({ recordset: [], rowsAffected: [0] }));
    await assert.rejects(noAllocation.repo.unallocateTeacher("101", "301", a), /not found/);
    assert.equal(auditsIn(noAllocation.state.tx).length, 0);
    assert.equal(noAllocation.state.rollbacks, 1);

    const noUser = makePool(() => ({ recordset: [], rowsAffected: [0] }));
    await assert.rejects(noUser.repo.unlockUserAccount("42", a), /not found/);
    assert.equal(auditsIn(noUser.state.tx).length, 0);

    const noAdmin = makePool(() => ({ recordset: [], rowsAffected: [0] }));
    await assert.rejects(noAdmin.repo.setAdminPassword("201", "$argon2id$x", a), /not found/);
    assert.equal(auditsIn(noAdmin.state.tx).length, 0);
    assert.equal(noAdmin.state.rollbacks, 1);

    const takenEmail = makePool((q) =>
      q.includes("WITH (UPDLOCK, HOLDLOCK)") ? { recordset: [{ NormalizedEmail: "priya.nair@nexelvoria.edu.in", NormalizedMobile: "+910000000000" }] } : staffCreateHandler(q),
    );
    await assert.rejects(
      takenEmail.repo.createAdmin({ name: "P", email: "priya.nair@nexelvoria.edu.in", mobile: "9876511223", passwordHash: "h", assignedByUserId: ACTOR }, a),
      (e: Error) => e.name === "DuplicateRecordError",
    );
    assert.equal(auditsIn(takenEmail.state.tx).length, 0);
    assert.equal(takenEmail.state.commits, 0);
  });
});

// ------------------------------------------------------------------ HTTP (service + routes, in-memory fake)
describe("SEC audit: Admin / Super Admin routes (in-memory fake)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const auth = (who: string) => ({ headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" } });
  const USERS: Record<string, { id: string; role: "admin" | "super_admin" | "teacher" | "student" }> = {
    admin: { id: "201", role: "admin" },
    super: { id: "202", role: "super_admin" },
    teacher: { id: "301", role: "teacher" },
    student: { id: "401", role: "student" },
  };
  const audits = (action: string) => harness.admin.auditLogs.filter((l) => l.actionType === action);

  beforeEach(async () => {
    harness = createTestHarness();
    for (const [key, u] of Object.entries(USERS)) {
      const session = await harness.sessions.create({ userId: u.id, refreshTokenHash: Buffer.alloc(64, 7).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[key] = issueAccessToken({ userId: u.id, role: u.role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  const newAdmin = { name: "Asha Rao", email: "Asha.Rao@nexelvoria.edu.in", mobile: "9876500001", department: "Admissions" };

  it("Admin account create / update / status / password reset: audited with the Super Admin as actor", async () => {
    const created = await server.post("/api/v1/super-admin/admins", newAdmin, auth("super"));
    assert.equal(created.status, 201);
    const body = await json(created);
    const adminId = String(body["data"]["account"]?.id ?? body["data"]["id"]);
    const temp = JSON.stringify(body["data"]).match(/"temporaryPassword":"([^"]+)"/)?.[1];
    const [c] = audits("CREATE_ADMIN");
    assert.ok(c);
    assert.equal(c.actorUserId, "202");
    assert.equal(c.entityId, adminId);
    assert.equal(c.moduleCode, "ADMIN_MGMT");
    assert.equal(c.entityName, "AdminProfile");

    assert.equal((await server.put(`/api/v1/super-admin/admins/${adminId}`, { name: "Asha R. Rao" }, auth("super"))).status, 200);
    assert.equal(audits("UPDATE_ADMIN").length, 1);
    assert.equal((await server.put(`/api/v1/super-admin/admins/${adminId}`, { name: "Asha R. Rao" }, auth("super"))).status, 200);
    assert.equal(audits("UPDATE_ADMIN").length, 1, "the same values again: no audit");

    assert.equal((await server.patch(`/api/v1/super-admin/admins/${adminId}/status`, { status: "suspended" }, auth("super"))).status, 200);
    assert.equal((await server.patch(`/api/v1/super-admin/admins/${adminId}/status`, { status: "suspended" }, auth("super"))).status, 200);
    assert.equal(audits("SET_ADMIN_STATUS").length, 1, "an unchanged status is not audited");
    assert.equal(audits("SET_ADMIN_STATUS")[0]!.entityId, adminId);

    const reset = await server.post(`/api/v1/super-admin/admins/${adminId}/reset-password`, {}, auth("super"));
    assert.equal(reset.status, 200);
    const resetTemp = (await json(reset))["data"]["temporaryPassword"];
    assert.equal(audits("RESET_ADMIN_PASSWORD").length, 1);
    const trail = JSON.stringify(harness.admin.auditLogs);
    for (const secret of [temp, resetTemp].filter(Boolean)) assert.ok(!trail.includes(secret), "temporary passwords never reach the audit trail");
    assert.doesNotMatch(trail, /argon2/);
  });

  it("an audit write failure fails the request and leaves nothing changed", async () => {
    harness.admin.failStaffAudit = true;
    const before = harness.admin.admins.length;
    const res = await server.post("/api/v1/super-admin/admins", newAdmin, auth("super"));
    assert.ok(res.status >= 500, `got ${res.status}`);
    assert.equal(harness.admin.admins.length, before, "no admin account without its audit");

    const teacher = await server.post("/api/v1/admin/teachers", { name: "Tara T", email: "tara@nexelvoria.edu.in", mobile: "9876500002" }, auth("admin"));
    assert.ok(teacher.status >= 500);
    assert.equal(harness.admin.teachers.some((t) => t.email === "tara@nexelvoria.edu.in"), false, "no teacher without its audit");

    const batch = await server.post("/api/v1/admin/batches", { courseId: "c1", batchCode: "B-01", batchName: "Batch One" }, auth("admin"));
    assert.ok(batch.status >= 500);
    assert.equal(harness.admin.batches.length, 0, "no batch without its audit");

    harness.admin.lockedUserIds.add("401");
    const unlock = await server.post("/api/v1/admin/users/401/unlock", {}, auth("admin"));
    assert.ok(unlock.status >= 500);
    assert.equal(harness.admin.lockedUserIds.has("401"), true, "still locked: the unlock rolled back");
    assert.equal(harness.admin.auditLogs.length, 0);
  });

  it("batch, allocation, unlock and teacher create are audited with the Admin as actor; no-ops are not", async () => {
    const b = await server.post("/api/v1/admin/batches", { courseId: "c1", batchCode: "B-01", batchName: "Batch One" }, auth("admin"));
    assert.ok(b.status < 300, `got ${b.status}`);
    const batchId = String((await json(b))["data"]["id"]);
    assert.deepEqual(
      audits("CREATE_BATCH").map((l) => [l.actorUserId, l.entityId, l.moduleCode, l.entityName]),
      [["201", batchId, "BATCH_MGMT", "Batch"]],
    );

    assert.equal((await server.put(`/api/v1/admin/batches/${batchId}`, { batchName: "Batch One" }, auth("admin"))).status, 200);
    assert.equal(audits("UPDATE_BATCH").length, 0, "same values: no audit");
    assert.equal((await server.put(`/api/v1/admin/batches/${batchId}`, { batchName: "Batch One (Evening)" }, auth("admin"))).status, 200);
    assert.equal(audits("UPDATE_BATCH").length, 1);

    assert.equal((await server.patch(`/api/v1/admin/batches/${batchId}/status`, { status: "upcoming" }, auth("admin"))).status, 200);
    assert.equal(audits("SET_BATCH_STATUS").length, 0, "already upcoming: no audit");
    assert.equal((await server.patch(`/api/v1/admin/batches/${batchId}/status`, { status: "ongoing" }, auth("admin"))).status, 200);
    assert.equal(audits("SET_BATCH_STATUS").length, 1);

    harness.admin.activeTeacherIds.add("301");
    assert.ok((await server.post(`/api/v1/admin/batches/${batchId}/allocate`, { teacherUserId: "301", courseId: "c1" }, auth("admin"))).status < 300);
    assert.deepEqual(audits("ALLOCATE_TEACHER").map((l) => [l.actorUserId, l.entityId]), [["201", batchId]]);
    const dup = await server.post(`/api/v1/admin/batches/${batchId}/allocate`, { teacherUserId: "301", courseId: "c1" }, auth("admin"));
    assert.equal(dup.status, 409);
    assert.equal(audits("ALLOCATE_TEACHER").length, 1, "a refused allocation is not audited");

    harness.admin.failStaffAudit = true;
    assert.ok((await server.delete(`/api/v1/admin/batches/${batchId}/allocations/301`, auth("admin"))).status >= 500);
    assert.deepEqual(harness.admin.teacherAllocationsMap.get(batchId), ["301"], "unallocation rolled back with its audit");
    harness.admin.failStaffAudit = false;
    assert.ok((await server.delete(`/api/v1/admin/batches/${batchId}/allocations/301`, auth("admin"))).status < 300);
    assert.equal(audits("UNALLOCATE_TEACHER").length, 1);
    assert.equal((await server.delete(`/api/v1/admin/batches/${batchId}/allocations/301`, auth("admin"))).status, 404);
    assert.equal(audits("UNALLOCATE_TEACHER").length, 1, "nothing to unallocate: no audit");

    assert.ok((await server.post("/api/v1/admin/users/401/unlock", {}, auth("admin"))).status < 300);
    assert.equal(audits("UNLOCK_ACCOUNT").length, 0, "not locked: nothing cleared, no audit");
    harness.admin.lockedUserIds.add("401");
    assert.ok((await server.post("/api/v1/admin/users/401/unlock", {}, auth("admin"))).status < 300);
    assert.deepEqual(audits("UNLOCK_ACCOUNT").map((l) => [l.actorUserId, l.entityId, l.moduleCode, l.entityName]), [["201", "401", "USER_MGMT", "User"]]);
    assert.equal(harness.admin.lockedUserIds.has("401"), false);

    const t = await server.post("/api/v1/admin/teachers", { name: "Tara T", email: "tara@nexelvoria.edu.in", mobile: "9876500002" }, auth("admin"));
    assert.equal(t.status, 201);
    const teacherBody = await json(t);
    const teacherId = String(teacherBody["data"]["account"]?.id ?? teacherBody["data"]["id"]);
    assert.deepEqual(audits("CREATE_TEACHER").map((l) => [l.actorUserId, l.entityId, l.moduleCode]), [["201", teacherId, "TEACHER_MGMT"]]);
    assert.doesNotMatch(JSON.stringify(audits("CREATE_TEACHER")), /temporaryPassword|argon2/);
  });

  it("refused callers change nothing and leave no audit", async () => {
    const before = { admins: harness.admin.admins.length, batches: harness.admin.batches.length, teachers: harness.admin.teachers.length };
    assert.equal((await server.post("/api/v1/super-admin/admins", newAdmin, auth("admin"))).status, 403, "an Admin cannot create admins");
    assert.equal((await server.post("/api/v1/super-admin/admins", newAdmin, auth("teacher"))).status, 403);
    assert.equal((await server.post("/api/v1/admin/batches", { courseId: "c1", batchCode: "B-01", batchName: "Batch One" }, auth("teacher"))).status, 403);
    assert.equal((await server.post("/api/v1/admin/teachers", { name: "Tara T", email: "tara@nexelvoria.edu.in", mobile: "9876500002" }, auth("student"))).status, 403);
    harness.admin.lockedUserIds.add("401");
    assert.equal((await server.post("/api/v1/admin/users/401/unlock", {}, auth("student"))).status, 403);
    assert.equal((await server.post("/api/v1/admin/batches", { courseId: "c1", batchCode: "B-01", batchName: "Batch One" })).status, 401);

    assert.deepEqual({ admins: harness.admin.admins.length, batches: harness.admin.batches.length, teachers: harness.admin.teachers.length }, before);
    assert.equal(harness.admin.lockedUserIds.has("401"), true);
    assert.equal(harness.admin.auditLogs.length, 0, "no audit for refused requests");
  });
});
