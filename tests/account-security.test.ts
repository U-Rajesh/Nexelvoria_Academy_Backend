import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { hashOtpCode } from "../src/modules/auth/otp.service";
import { hashPassword } from "../src/modules/auth/password.service";
import { SqlServerAccountSecurityRepository } from "../src/modules/auth/sqlserver-account-security.repository";
import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";
import { RecordNotFoundError } from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 3 item 6: account security (AUTH-006/007/008/009/010/014) and Admin
 * teacher management. Mock SQL pools and in-memory fakes only - nothing here
 * runs against the live database.
 */

const PASSWORD = "Str0ng!Pass1";
const NEW_PASSWORD = "N3w!Secure#Pass";

type Handler = (q: string, inputs: Record<string, unknown>) => unknown;
class MockSqlRequest {
  inputs: Record<string, unknown> = {};
  constructor(private readonly handler: Handler) {}
  input(name: string, typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : typeOrValue;
    return this;
  }
  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) throw res;
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
  }
}
const tracked = (handler: Handler) => {
  const state = { committed: false, rolledBack: false, began: 0 };
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const wrapped: Handler = (q, inputs) => {
    seen.push({ q, inputs: { ...inputs } });
    return handler(q, inputs);
  };
  const pool = {
    request: () => new MockSqlRequest(wrapped),
    transaction: () => ({
      begin: async () => void (state.began += 1),
      commit: async () => void (state.committed = true),
      rollback: async () => void (state.rolledBack = true),
      request: () => new MockSqlRequest(wrapped),
    }),
  } as unknown as sql.ConnectionPool;
  const writes = () => seen.filter((s) => /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(s.q));
  return { pool, state, seen, writes };
};

describe("SqlServerAccountSecurityRepository", () => {
  it("records a login without any password material and clips to column sizes", async () => {
    const t = tracked(() => ({}));
    await new SqlServerAccountSecurityRepository(async () => t.pool).recordLogin({
      userId: "7", loginIdentifier: "a@test.local", isSuccessful: false, failureReason: "invalid_credentials", ipAddress: "10.0.0.1", deviceInfo: "x".repeat(400),
    });
    const ins = t.writes()[0]!;
    assert.match(ins.q, /INSERT INTO dbo\.NXA_LoginHistory \(UserId, LoginIdentifier, IsSuccessful, FailureReason, IpAddress, DeviceInfo, LoggedAt\)/);
    assert.doesNotMatch(ins.q, /Password/i);
    assert.equal((ins.inputs["Device"] as string).length, 300);
    assert.equal(ins.inputs["UserId"], "7");
  });

  it("an unknown identifier is recorded with a NULL user", async () => {
    const t = tracked(() => ({}));
    await new SqlServerAccountSecurityRepository(async () => t.pool).recordLogin({ loginIdentifier: "nobody@test.local", isSuccessful: false, failureReason: "invalid_credentials" });
    assert.equal(t.writes()[0]!.inputs["UserId"], null);
  });

  it("consumes the newest live reset grant in ONE guarded statement (single use)", async () => {
    let consumed = false;
    const t = tracked((q) => {
      if (/UPDATE t/.test(q)) {
        if (consumed) return { recordset: [] };
        consumed = true;
        return { recordset: [{ PasswordResetTokenId: 5 }] };
      }
      return {};
    });
    const repo = new SqlServerAccountSecurityRepository(async () => t.pool);
    assert.equal(await repo.consumeResetGrant("7"), true);
    assert.equal(await repo.consumeResetGrant("7"), false, "second use refused");
    const q = t.seen[0]!.q;
    assert.match(q, /UsedAt IS NULL AND g\.ExpiresAt > SYSUTCDATETIME\(\)/);
    assert.match(q, /WITH \(UPDLOCK, HOLDLOCK\)/);
    assert.match(q, /AND t\.UsedAt IS NULL/);
    assert.equal(await repo.consumeResetGrant("user-1"), false, "non-numeric id never matches");
  });

  it("login history is read for ONE user, newest first, bounded", async () => {
    const t = tracked(() => ({ recordset: [{ LoginHistoryId: 1, UserId: 7, LoginIdentifier: "a@test.local", IsSuccessful: true, LoggedAt: new Date() }] }));
    const rows = await new SqlServerAccountSecurityRepository(async () => t.pool).listLoginHistory("7", 9999);
    assert.equal(rows.length, 1);
    assert.match(t.seen[0]!.q, /WHERE UserId = @UserId\s+ORDER BY LoggedAt DESC/);
    assert.equal(t.seen[0]!.inputs["Limit"], 200, "limit capped");
  });
});

describe("SqlServerAdminRepository: teacher management", () => {
  const teacherRow = { FullName: "Asha Rao", AccountStatus: "ACTIVE", Specialization: "Java", ExperienceYears: 4, Qualification: "M.Tech", Bio: null, HasProfile: 1 };
  const handler = (over: { row?: unknown; failAudit?: boolean } = {}): Handler => (q) => {
    if (/FROM dbo\.NXA_Users u WITH \(UPDLOCK, HOLDLOCK\)/.test(q)) return { recordset: over.row === null ? [] : [over.row ?? teacherRow] };
    if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return over.failAudit ? new Error("audit down") : { recordset: [{ AuditLogId: 1 }] };
    if (/FROM dbo\.NXA_Users u\s+LEFT JOIN dbo\.NXA_TeacherProfiles tp/.test(q)) {
      return { recordset: [{ UserId: 41, FullName: "Asha R.", Email: "asha@test.local", MobileNumber: "9000000041", AccountStatus: "active", CreatedAt: new Date(), Specialization: "Java", ExperienceYears: 5, Qualification: "M.Tech", Bio: null }] };
    }
    return {};
  };
  const repo = (pool: sql.ConnectionPool) => new SqlServerAdminRepository(async () => pool);

  it("updates only changed columns, audited in the same transaction; an unchanged teacher writes nothing", async () => {
    let t = tracked(handler());
    const r = await repo(t.pool).updateTeacher("41", { name: "Asha R.", experienceYears: 5, specialization: "Java" }, "7");
    assert.equal(r.changed, true);
    assert.ok(t.state.committed);
    assert.ok(t.writes().some((w) => /UPDATE dbo\.NXA_Users SET FullName/.test(w.q)));
    const audit = t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!;
    assert.deepEqual([audit.inputs["action"], audit.inputs["module"], audit.inputs["actorId"]], ["UPDATE_TEACHER", "TEACHER_MGMT", "7"]);
    assert.deepEqual(Object.keys(JSON.parse(String(audit.inputs["newVal"]))).sort(), ["experienceYears", "name"], "specialization was unchanged");

    t = tracked(handler());
    assert.equal((await repo(t.pool).updateTeacher("41", { name: "Asha Rao", specialization: "Java" }, "7")).changed, false);
    assert.equal(t.writes().length, 0);
  });

  it("refuses non-teachers and rolls back when the audit fails", async () => {
    let t = tracked(handler({ row: null }));
    await assert.rejects(repo(t.pool).updateTeacher("41", { name: "X Y" }, "7"), RecordNotFoundError);
    assert.match(t.seen[0]!.q, /LOWER\(r\.RoleCode\) IN \('teacher'\)/);
    t = tracked(handler({ failAudit: true }));
    await assert.rejects(repo(t.pool).updateTeacher("41", { name: "New Name" }, "7"), /audit down/);
    assert.ok(t.state.rolledBack && !t.state.committed);
  });

  it("deactivation writes the account status and the profile flag, audited; repeating it writes nothing", async () => {
    let t = tracked(handler());
    const r = await repo(t.pool).setTeacherStatus("41", "deactivated", "Left the institute", "7");
    assert.equal(r.changed, true);
    const status = t.writes().find((w) => /UPDATE dbo\.NXA_Users SET AccountStatus/.test(w.q))!;
    assert.equal(status.inputs["status"], "deactivated");
    assert.equal(t.writes().find((w) => /UPDATE dbo\.NXA_TeacherProfiles SET IsActive/.test(w.q))!.inputs["active"], false);
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "DEACTIVATE_TEACHER");
    assert.equal(t.writes().filter((w) => /DELETE/.test(w.q)).length, 0);

    t = tracked(handler({ row: { ...teacherRow, AccountStatus: "DEACTIVATED" } }));
    assert.equal((await repo(t.pool).setTeacherStatus("41", "deactivated", undefined, "7")).changed, false);
    assert.equal(t.writes().length, 0);
    await assert.rejects(repo(t.pool).setTeacherStatus("t-1", "active", undefined, "7"), RecordNotFoundError);
  });
});

describe("account security and teacher management endpoints", () => {
  let harness: TestHarness;
  let server: TestServer;
  const ids: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 80;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      emails[role] = `${role}-s${seq}@test.local`;
      const user = await harness.users.create({ name: `${role} S`, email: emails[role]!, mobile: `98765434${seq}`, role, status: "active" });
      await harness.credentials.create({ userId: user.id, passwordHash: await hashPassword(PASSWORD) });
      if (role === "student") {
        await harness.students.createForUser(user.id, {
          collegeName: "JNTU Hyderabad", degreeBranch: "B.Tech CSE", passingYear: "2025", courseInterestedIn: "Full Stack Development",
          dateOfBirth: "2003-04-12", gender: "male", fullAddress: "12-3-45 Ameerpet, Hyderabad, Telangana 500016",
        });
        await harness.students.markVerified(user.id, "email");
      }
      ids[role] = user.id;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  const signIn = async (role: string, password = PASSWORD) => {
    const res = await server.post("/api/v1/auth/login", { identifier: emails[role], password });
    return { status: res.status, token: res.status === 200 ? ((await json(res))["data"]["token"] as string) : "" };
  };
  const isLive = async (token: string) => (await server.get("/api/v1/auth/sessions", bearer(token))).status === 200;
  const audits = (action: string) => harness.admin.auditLogs.filter((l) => l.actionType === action);

  it("AUTH-007: change password checks the current password and policy, keeps this session, ends the others", async () => {
    const a = (await signIn("admin")).token;
    const b = (await signIn("admin")).token;

    const wrong = await server.post("/api/v1/auth/password/change", { currentPassword: "Wrong!Pass1", newPassword: NEW_PASSWORD }, bearer(a));
    assert.equal(wrong.status, 400);
    assert.equal((await json(wrong))["error"], "INVALID_CURRENT_PASSWORD");
    assert.equal(audits("PASSWORD_CHANGE_FAILED").length, 1);
    assert.equal((await server.post("/api/v1/auth/password/change", { currentPassword: PASSWORD, newPassword: "weak" }, bearer(a))).status, 422);
    assert.equal((await server.post("/api/v1/auth/password/change", { currentPassword: PASSWORD, newPassword: PASSWORD }, bearer(a))).status, 422);
    assert.equal((await server.post("/api/v1/auth/password/change", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 401);

    const ok = await server.post("/api/v1/auth/password/change", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, bearer(a));
    assert.equal(ok.status, 200);
    const body = JSON.stringify(await json(ok));
    assert.doesNotMatch(body, /argon2|N3w!Secure/, "no hash or password in the response");
    assert.equal(await isLive(a), true, "the session making the change stays signed in");
    assert.equal(await isLive(b), false, "every other session is ended server-side");
    assert.equal((await signIn("admin")).status, 401, "old password no longer works");
    assert.equal((await signIn("admin", NEW_PASSWORD)).status, 200);
    const log = audits("PASSWORD_CHANGED")[0]!;
    assert.equal(log.actorUserId, ids["admin"]);
    assert.doesNotMatch(JSON.stringify(log), /argon2|N3w!Secure|Str0ng/);
  });

  it("AUTH-009/010: list own sessions, end one, end all others, log out; another user's session is not found", async () => {
    const a = (await signIn("super_admin")).token;
    const b = (await signIn("super_admin")).token;
    const other = (await signIn("admin")).token;

    const list = (await json(await server.get("/api/v1/auth/sessions", bearer(a))))["data"] as Array<Record<string, unknown>>;
    assert.equal(list.length, 2);
    assert.equal(list.filter((s) => s["isCurrent"]).length, 1);
    assert.ok(list.every((s) => !("refreshTokenHash" in s)));
    const bId = String(list.find((s) => !s["isCurrent"])!["id"]);

    const otherSessions = (await json(await server.get("/api/v1/auth/sessions", bearer(other))))["data"] as Array<Record<string, unknown>>;
    const otherId = String(otherSessions[0]!["id"]);
    assert.equal((await server.delete(`/api/v1/auth/sessions/${otherId}`, bearer(a))).status, 404, "cannot end someone else's session");
    assert.equal(await isLive(other), true);

    assert.equal((await server.delete(`/api/v1/auth/sessions/${bId}`, bearer(a))).status, 200);
    assert.equal(await isLive(b), false);
    assert.equal(audits("SESSION_ENDED").length, 1);

    const c = (await signIn("super_admin")).token;
    const ended = await json(await server.post("/api/v1/auth/sessions/end-others", {}, bearer(a)));
    assert.equal(ended["data"].sessionsEnded, 1);
    assert.equal(await isLive(c), false);
    assert.equal(await isLive(a), true);
    const again = await json(await server.post("/api/v1/auth/sessions/end-others", {}, bearer(a)));
    assert.equal(again["data"].sessionsEnded, 0);
    assert.equal(audits("SESSIONS_ENDED").length, 1, "the no-op wrote no audit row");

    assert.equal((await server.post("/api/v1/auth/logout", {}, bearer(a))).status, 200);
    assert.equal(await isLive(a), false, "logout ends the session server-side");
    assert.equal((await server.get("/api/v1/auth/sessions")).status, 401);
  });

  it("AUTH-008/014: every sign-in attempt is recorded; own history for everyone, other users' history for Super Admin only", async () => {
    assert.equal((await signIn("admin", "Wrong!Pass1")).status, 401);
    const admin = (await signIn("admin")).token;
    await server.post("/api/v1/auth/login", { identifier: "nobody@test.local", password: "Wrong!Pass1" });

    const history = (await json(await server.get("/api/v1/auth/login-history", bearer(admin))))["data"] as Array<Record<string, unknown>>;
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((h) => h["isSuccessful"]), [true, false], "newest first");
    assert.equal(history[1]!["failureReason"], "invalid_credentials");
    assert.doesNotMatch(JSON.stringify(harness.accountSecurity.logins), /Wrong!Pass1|Str0ng/, "passwords are never stored");
    assert.equal(harness.accountSecurity.logins.find((l) => l.loginIdentifier === "nobody@test.local")!.userId, undefined);

    const sa = (await signIn("super_admin")).token;
    const teacher = (await signIn("teacher")).token;
    assert.equal((await server.get(`/api/v1/auth/users/${ids["admin"]}/login-history`, bearer(admin))).status, 403);
    assert.equal((await server.get(`/api/v1/auth/users/${ids["admin"]}/login-history`, bearer(teacher))).status, 403);
    const viaSa = await json(await server.get(`/api/v1/auth/users/${ids["admin"]}/login-history`, bearer(sa)));
    assert.equal(viaSa["data"].length, 2);
    const own = (await json(await server.get("/api/v1/auth/login-history", bearer(teacher))))["data"] as Array<Record<string, unknown>>;
    assert.ok(own.every((h) => h["userId"] === ids["teacher"]), "a user only ever sees their own history");
  });

  it("AUTH-006: forgot password never reveals accounts; reset needs the live OTP and grant, is single use, and ends every session", async () => {
    const before = (await signIn("admin")).token;
    const unknown = await json(await server.post("/api/v1/auth/password/forgot", { email: "nobody@test.local" }));
    const known = await json(await server.post("/api/v1/auth/password/forgot", { email: emails["admin"] }));
    assert.equal(unknown["message"], known["message"], "identical answer");
    assert.equal(harness.accountSecurity.grants.length, 1);
    assert.equal(harness.accountSecurity.grants[0]!.userId, ids["admin"]);
    assert.ok(await harness.otpChallenges.findActiveByUser(ids["admin"]!, "password_reset"), "an email OTP was issued for the reset purpose");
    assert.doesNotMatch(JSON.stringify(known), /\d{6}/, "no code in the response");

    // The real code was e-mailed; tests replace it with a known one.
    await harness.otpChallenges.create({ userId: ids["admin"]!, purpose: "password_reset", codeHash: hashOtpCode("246810"), destination: emails["admin"]!, expiresAt: new Date(Date.now() + 300000).toISOString(), createdAt: new Date().toISOString() });
    const reset = (code: string, newPassword = NEW_PASSWORD) => server.post("/api/v1/auth/password/reset", { email: emails["admin"], code, newPassword });

    assert.equal((await reset("246810", "weak")).status, 422, "policy checked before the code is used");
    const wrong = await reset("111111");
    assert.equal(wrong.status, 400);
    assert.equal((await json(wrong))["error"], "RESET_CODE_INVALID");
    assert.equal((await server.post("/api/v1/auth/password/reset", { email: "nobody@test.local", code: "246810", newPassword: NEW_PASSWORD })).status, 400);

    assert.equal((await reset("246810")).status, 200);
    assert.equal(await isLive(before), false, "every session ended");
    assert.equal((await signIn("admin", NEW_PASSWORD)).status, 200);
    assert.equal((await reset("246810")).status, 400, "the code cannot be reused");
    assert.ok(harness.accountSecurity.grants[0]!.usedAt, "the grant is consumed");
    const log = audits("PASSWORD_RESET")[0]!;
    assert.doesNotMatch(JSON.stringify(log), /246810|N3w!Secure/);
  });

  it("AUTH-006: an expired code or an expired grant is refused", async () => {
    await server.post("/api/v1/auth/password/forgot", { email: emails["teacher"] });
    await harness.otpChallenges.create({ userId: ids["teacher"]!, purpose: "password_reset", codeHash: hashOtpCode("135790"), destination: emails["teacher"]!, expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: new Date().toISOString() });
    assert.equal((await server.post("/api/v1/auth/password/reset", { email: emails["teacher"], code: "135790", newPassword: NEW_PASSWORD })).status, 400, "expired OTP");

    await harness.otpChallenges.create({ userId: ids["teacher"]!, purpose: "password_reset", codeHash: hashOtpCode("135791"), destination: emails["teacher"]!, expiresAt: new Date(Date.now() + 300000).toISOString(), createdAt: new Date().toISOString() });
    harness.accountSecurity.now = () => new Date(Date.now() + 10 * 60 * 1000);
    assert.equal((await server.post("/api/v1/auth/password/reset", { email: emails["teacher"], code: "135791", newPassword: NEW_PASSWORD })).status, 400, "expired grant");
    assert.equal((await signIn("teacher")).status, 200, "the password is unchanged");
  });

  it("teacher management: Admin and Super Admin edit and (de)activate; deactivation ends the teacher's sessions; no-ops write nothing", async () => {
    harness.admin.teachers.push({
      id: ids["teacher"]!, name: "teacher S", email: emails["teacher"]!, mobile: "9876543483", role: "teacher", status: "active", createdAt: new Date().toISOString(),
      specialization: "Java", experienceYears: 3, bio: "", qualifications: "", assignedCourseIds: [], assignedBatchIds: [],
    });
    const admin = (await signIn("admin")).token;
    const sa = (await signIn("super_admin")).token;
    const teacherToken = (await signIn("teacher")).token;
    const student = (await signIn("student")).token;
    const url = `/api/v1/admin/teachers/${ids["teacher"]}`;

    assert.equal((await server.put(url, { name: "Teacher Updated" }, bearer(teacherToken))).status, 403);
    assert.equal((await server.patch(`${url}/status`, { status: "deactivated" }, bearer(student))).status, 403);
    assert.equal((await server.put(url, { email: "x@test.local" }, bearer(admin))).status, 422, "sign-in identifiers are not editable here");
    assert.equal((await server.put(url, {}, bearer(admin))).status, 422);
    assert.equal((await server.patch(`${url}/status`, { status: "suspended" }, bearer(admin))).status, 422);
    assert.equal((await server.put("/api/v1/admin/teachers/tch-404", { name: "Nobody Here" }, bearer(admin))).status, 404);

    const upd = await json(await server.put(url, { name: "Teacher Updated", experienceYears: 6 }, bearer(admin)));
    assert.equal(upd["data"].changed, true);
    assert.equal(upd["data"].record.name, "Teacher Updated");
    assert.equal((await json(await server.put(url, { name: "Teacher Updated" }, bearer(sa))))["data"].changed, false);
    assert.equal(audits("UPDATE_TEACHER").length, 1, "the no-op was not audited");

    const off = await json(await server.patch(`${url}/status`, { status: "deactivated", reason: "Contract ended" }, bearer(sa)));
    assert.equal(off["data"].record.status, "deactivated");
    assert.equal(await isLive(teacherToken), false, "the teacher is signed out immediately");
    assert.equal((await json(await server.patch(`${url}/status`, { status: "deactivated" }, bearer(admin))))["data"].changed, false);
    assert.equal(audits("DEACTIVATE_TEACHER").length, 1);
    assert.equal((await json(await server.patch(`${url}/status`, { status: "active" }, bearer(admin))))["data"].record.status, "active");
  });

  it("a failed teacher audit write rolls the change back", async () => {
    harness.admin.teachers.push({
      id: ids["teacher"]!, name: "teacher S", email: emails["teacher"]!, mobile: "9876543483", role: "teacher", status: "active", createdAt: new Date().toISOString(),
      specialization: "Java", experienceYears: 3, bio: "", qualifications: "", assignedCourseIds: [], assignedBatchIds: [],
    });
    const admin = (await signIn("admin")).token;
    harness.admin.failTeacherAudit = true;
    assert.equal((await server.put(`/api/v1/admin/teachers/${ids["teacher"]}`, { name: "Should Not Stick" }, bearer(admin))).status, 500);
    assert.equal((await server.patch(`/api/v1/admin/teachers/${ids["teacher"]}/status`, { status: "deactivated" }, bearer(admin))).status, 500);
    const t = harness.admin.teachers[0]!;
    assert.deepEqual([t.name, t.status], ["teacher S", "active"]);
  });

  it("student status: an unchanged status writes nothing and is not audited", async () => {
    const admin = (await signIn("admin")).token;
    const url = `/api/v1/students/${ids["student"]}/status`;
    assert.equal((await server.patch(url, { status: "suspended" }, bearer(admin))).status, 200);
    assert.equal((await server.patch(url, { status: "suspended" }, bearer(admin))).status, 200);
    assert.equal(audits("SET_STUDENT_STATUS").length, 1);
  });
});
