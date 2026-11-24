import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { PlacementRuleError } from "../src/modules/placements/placement.repository";
import { SqlServerPlacementRepository } from "../src/modules/placements/sqlserver-placement.repository";
import { RecordNotFoundError } from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";
import { seedEnrollment } from "./helpers/learning-access";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 3 item 5: Placement Administration (ADM-012, PLC-001..PLC-015).
 * Decisions D1 (status vocabulary) and D2 (companies are never deleted).
 */

type Handler = (q: string, inputs: Record<string, unknown>) => unknown;

class MockSqlRequest {
  inputs: Record<string, unknown> = {};
  constructor(private readonly handler: Handler) {}
  input(name: string, typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : typeOrValue;
    return this;
  }
  async query<T = unknown>(command: string): Promise<{ recordset: T[]; recordsets: T[][]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) throw res;
    const r = (res ?? {}) as { recordset?: T[]; recordsets?: T[][]; rowsAffected?: number[] };
    return { recordset: r.recordset ?? [], recordsets: r.recordsets ?? [], rowsAffected: r.rowsAffected ?? [1] };
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
  return { pool, state, seen, writes, repo: new SqlServerPlacementRepository(async () => pool) };
};
const audit = (q: string) => (/INSERT INTO dbo\.NXA_AuditLogs/.test(q) ? { recordset: [{ AuditLogId: 1 }] } : undefined);
const companyRow = { CompanyId: 11, CompanyName: "TCS", WebsiteUrl: null, Industry: "IT", Description: null, Address: null, ContactName: null, ContactEmail: null, ContactMobile: null, IsActive: true, CreatedAt: new Date() };

describe("SqlServerPlacementRepository: companies and jobs", () => {
  it("company edit: only changed columns, audited; unchanged writes nothing; duplicate name 409 with rollback", async () => {
    let t = tracked((q) => audit(q) ?? (/UPPER\(LTRIM/.test(q) ? { recordset: [] } : { recordset: [companyRow] }));
    const res = await t.repo.updateCompany("11", { industry: "IT", contactEmail: "hr@tcs.test" }, "7");
    assert.equal(res.changed, true);
    const upd = t.writes().find((w) => /UPDATE dbo\.NXA_Companies/.test(w.q))!;
    assert.match(upd.q, /SET ContactEmail = @ContactEmail WHERE/, "industry was unchanged, so only ContactEmail is written");
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "UPDATE_COMPANY");
    assert.equal(t.writes().filter((w) => /DELETE/.test(w.q)).length, 0);

    t = tracked((q) => audit(q) ?? { recordset: [companyRow] });
    assert.equal((await t.repo.updateCompany("11", { companyName: "TCS" }, "7")).changed, false);
    assert.equal(t.writes().length, 0);

    t = tracked((q) => (/UPPER\(LTRIM/.test(q) ? { recordset: [{ CompanyId: 12 }] } : { recordset: [companyRow] }));
    await assert.rejects(t.repo.updateCompany("11", { companyName: "Infosys" }, "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "COMPANY_NAME_EXISTS" && e.status === 409);
    assert.equal(t.writes().length, 0);
    assert.ok(t.state.rolledBack);
  });

  it("deactivates a company (never deletes it) and treats a repeat as a no-op", async () => {
    let active = true;
    const h: Handler = (q, i) => {
      if (/SELECT IsActive FROM dbo\.NXA_Companies/.test(q)) return { recordset: [{ IsActive: active }] };
      if (/UPDATE dbo\.NXA_Companies SET IsActive/.test(q)) return void (active = i["Active"] as boolean);
      return audit(q) ?? { recordset: [{ ...companyRow, IsActive: active }] };
    };
    let t = tracked(h);
    const r = await t.repo.setCompanyActive("11", false, "Hiring freeze", "7");
    assert.equal(r.changed, true);
    assert.equal(r.record.isActive, false);
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "DEACTIVATE_COMPANY");
    assert.equal(t.writes().filter((w) => /DELETE/.test(w.q)).length, 0);
    t = tracked(h);
    assert.equal((await t.repo.setCompanyActive("11", false, undefined, "7")).changed, false);
    assert.equal(t.writes().length, 0);
  });

  it("refuses jobs for an inactive company; a draft job is not stamped as published", async () => {
    let t = tracked((q) => (/SELECT IsActive FROM dbo\.NXA_Companies/.test(q) ? { recordset: [{ IsActive: false }] } : {}));
    const job = { companyId: "11", jobTitle: "SDE", employmentType: "full_time" as const, workLocation: "Pune", minExperienceYears: 0, jobDescription: "Build reliable things" };
    await assert.rejects(t.repo.createJob({ ...job, jobStatus: "open" }, "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "COMPANY_INACTIVE");
    assert.equal(t.writes().length, 0);

    t = tracked((q) => {
      if (/SELECT IsActive FROM dbo\.NXA_Companies/.test(q)) return { recordset: [{ IsActive: true }] };
      if (/INSERT INTO dbo\.NXA_Jobs/.test(q)) return { recordset: [{ JobId: 31 }] };
      return audit(q) ?? { recordset: [{ JobId: 31, CompanyId: 11, JobTitle: "SDE", JobStatus: "draft", JobDescription: "x", CreatedAt: new Date() }] };
    });
    await t.repo.createJob({ ...job, jobStatus: "draft" }, "7");
    const ins = t.writes().find((w) => /INSERT INTO dbo\.NXA_Jobs/.test(w.q))!;
    assert.match(ins.q, /@PublishedByUserId, NULL, SYSUTCDATETIME\(\)/);
    assert.equal(ins.inputs["PublishedByUserId"], null);
  });

  it("job status: first opening stamps PublishedAt; unchanged writes nothing; opening needs an active company", async () => {
    let t = tracked((q) => {
      if (/SELECT JobStatus, CompanyId, PublishedAt/.test(q)) return { recordset: [{ JobStatus: "draft", CompanyId: 11, PublishedAt: null }] };
      if (/SELECT IsActive FROM dbo\.NXA_Companies/.test(q)) return { recordset: [{ IsActive: true }] };
      return audit(q) ?? { recordset: [{ JobId: 31, CompanyId: 11, JobTitle: "SDE", JobStatus: "open", CreatedAt: new Date() }] };
    });
    assert.equal((await t.repo.updateJobStatus("31", "open", "7")).changed, true);
    const upd = t.writes().find((w) => /UPDATE dbo\.NXA_Jobs/.test(w.q))!;
    assert.match(upd.q, /PublishedAt = SYSUTCDATETIME\(\), PublishedByUserId = @PublishedBy/);

    t = tracked((q) => (/SELECT JobStatus/.test(q) ? { recordset: [{ JobStatus: "OPEN", CompanyId: 11, PublishedAt: new Date() }] } : { recordset: [{ JobId: 31, JobStatus: "open" }] }));
    assert.equal((await t.repo.updateJobStatus("31", "open", "7")).changed, false);
    assert.equal(t.writes().length, 0);

    t = tracked((q) => {
      if (/SELECT JobStatus/.test(q)) return { recordset: [{ JobStatus: "closed", CompanyId: 11, PublishedAt: new Date() }] };
      if (/SELECT IsActive FROM dbo\.NXA_Companies/.test(q)) return { recordset: [{ IsActive: false }] };
      return {};
    });
    await assert.rejects(t.repo.updateJobStatus("31", "open", "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "COMPANY_INACTIVE");
    assert.equal(t.writes().length, 0);
  });

  it("job edit refuses a salary range where min exceeds max", async () => {
    const t = tracked((q) => (/SELECT JobId FROM dbo\.NXA_Jobs WITH/.test(q) ? { recordset: [{ JobId: 31 }] } : { recordset: [{ JobId: 31, CompanyId: 11, JobTitle: "SDE", JobStatus: "open", SalaryMin: 500000, SalaryMax: 800000, CreatedAt: new Date() }] }));
    await assert.rejects(t.repo.updateJob("31", { salaryMin: 900000 }, "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "SALARY_RANGE_INVALID");
    assert.equal(t.writes().length, 0);
  });

  it("placement alert: open job only, once per job, to students with an ACTIVE enrollment, audited", async () => {
    let t = tracked((q) => (/SELECT JobStatus FROM dbo\.NXA_Jobs/.test(q) ? { recordset: [{ JobStatus: "draft" }] } : {}));
    await assert.rejects(t.repo.announceJob("31", "T", "Body", "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "JOB_NOT_OPEN");

    t = tracked((q) => {
      if (/SELECT JobStatus FROM dbo\.NXA_Jobs/.test(q)) return { recordset: [{ JobStatus: "open" }] };
      if (/FROM dbo\.NXA_AuditLogs/.test(q)) return { recordset: [{ x: 1 }] };
      return {};
    });
    await assert.rejects(t.repo.announceJob("31", "T", "Body", "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "JOB_ALREADY_ANNOUNCED");
    assert.equal(t.writes().length, 0);

    t = tracked((q) => {
      if (/SELECT JobStatus FROM dbo\.NXA_Jobs/.test(q)) return { recordset: [{ JobStatus: "open" }] };
      if (/FROM dbo\.NXA_AuditLogs/.test(q) && !/INSERT/.test(q)) return { recordset: [] };
      if (/INSERT INTO dbo\.NXA_Notifications/.test(q)) return { rowsAffected: [3] };
      return audit(q) ?? {};
    });
    const res = await t.repo.announceJob("31", "New opening", "Apply now", "7");
    assert.equal(res.recipientCount, 3);
    const n = t.writes().find((w) => /NXA_Notifications/.test(w.q))!;
    assert.match(n.q, /'placement'/);
    assert.match(n.q, /UPPER\(e\.EnrollmentStatus\) = 'ACTIVE'/, "BR-013: only paid/authorized students");
    assert.match(n.q, /LOWER\(r\.RoleCode\) = 'student'/);
    assert.doesNotMatch(n.q, /Priority/, "Priority keeps its table default");
    assert.equal(t.seen.find((x) => /INSERT INTO dbo\.NXA_AuditLogs/.test(x.q))!.inputs["action"], "ANNOUNCE_JOB");
  });
});

describe("SqlServerPlacementRepository: rounds, offers, records, feedback, mock interviews", () => {
  it("interview rounds: auto-numbered, no RoundStatus written, duplicate number 409, audit failure rolls back", async () => {
    let t = tracked((q) => {
      if (/SELECT JobApplicationId FROM dbo\.NXA_JobApplications/.test(q)) return { recordset: [{ JobApplicationId: 41 }] };
      if (/SELECT RoundNumber FROM dbo\.NXA_InterviewRounds/.test(q)) return { recordset: [{ RoundNumber: 1 }] };
      if (/INSERT INTO dbo\.NXA_InterviewRounds/.test(q)) return { recordset: [{ InterviewRoundId: 51 }] };
      return audit(q) ?? { recordset: [{ InterviewRoundId: 51, JobApplicationId: 41, RoundNumber: 2, RoundName: "HR", RoundStatus: "SCHEDULED" }] };
    });
    const round = await t.repo.createInterviewRound("41", { roundName: "HR" }, "7");
    assert.equal(round.roundNumber, 2);
    const ins = t.writes().find((w) => /INSERT INTO dbo\.NXA_InterviewRounds/.test(w.q))!;
    assert.equal(ins.inputs["Number"], 2);
    assert.doesNotMatch(ins.q, /RoundStatus/);

    t = tracked((q) => (/SELECT JobApplicationId/.test(q) ? { recordset: [{ JobApplicationId: 41 }] } : /SELECT RoundNumber/.test(q) ? { recordset: [{ RoundNumber: 1 }] } : {}));
    await assert.rejects(t.repo.createInterviewRound("41", { roundName: "Tech", roundNumber: 1 }, "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "ROUND_NUMBER_EXISTS");
    assert.equal(t.writes().length, 0);

    t = tracked((q) => {
      if (/SELECT JobApplicationId/.test(q)) return { recordset: [{ JobApplicationId: 41 }] };
      if (/SELECT RoundNumber/.test(q)) return { recordset: [] };
      if (/INSERT INTO dbo\.NXA_InterviewRounds/.test(q)) return { recordset: [{ InterviewRoundId: 51 }] };
      if (/INSERT INTO dbo\.NXA_AuditLogs/.test(q)) return new Error("audit down");
      return {};
    });
    await assert.rejects(t.repo.createInterviewRound("41", { roundName: "Tech" }, "7"), /audit down/);
    assert.ok(t.state.rolledBack && !t.state.committed);
  });

  it("offers: unique reference (409); OfferStatus and the letter file are never written", async () => {
    let t = tracked((q) => (/SELECT JobApplicationId/.test(q) ? { recordset: [{ JobApplicationId: 41 }] } : /FROM dbo\.NXA_Offers WITH/.test(q) ? { recordset: [{ x: 1 }] } : {}));
    await assert.rejects(t.repo.createOffer("41", { offerReference: "OFR-1" }, "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "OFFER_REFERENCE_EXISTS");
    assert.equal(t.writes().length, 0);

    t = tracked((q) => {
      if (/SELECT JobApplicationId/.test(q)) return { recordset: [{ JobApplicationId: 41 }] };
      if (/FROM dbo\.NXA_Offers WITH/.test(q)) return { recordset: [] };
      if (/INSERT INTO dbo\.NXA_Offers/.test(q)) return { recordset: [{ OfferId: 61 }] };
      return audit(q) ?? { recordset: [{ OfferId: 61, JobApplicationId: 41, OfferReference: "OFR-1", OfferedSalary: 600000, OfferStatus: "ISSUED", OfferObjectKey: null, CreatedAt: new Date() }] };
    });
    const offer = await t.repo.createOffer("41", { offerReference: "OFR-1", offeredSalary: 600000 }, "7");
    assert.equal(offer.hasLetter, false);
    const ins = t.writes().find((w) => /INSERT INTO dbo\.NXA_Offers/.test(w.q))!;
    assert.doesNotMatch(ins.q, /OfferStatus|OfferObjectKey/);
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "CREATE_OFFER");
  });

  it("verifies a placement record once (409 on repeat), audited", async () => {
    let t = tracked((q) => (/SELECT VerifiedAt/.test(q) ? { recordset: [{ VerifiedAt: new Date() }] } : {}));
    await assert.rejects(t.repo.verifyPlacement("81", "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "PLACEMENT_ALREADY_VERIFIED");
    assert.equal(t.writes().length, 0);
    t = tracked((q) => audit(q) ?? (/SELECT VerifiedAt/.test(q) ? { recordset: [{ VerifiedAt: null }] } : { recordset: [{ PlacementRecordId: 81, StudentUserId: 301, CompanyId: 11, JobId: 31, JobApplicationId: 41, VerifiedAt: new Date(), VerifiedByUserId: 7 }] }));
    const r = await t.repo.verifyPlacement("81", "7");
    assert.equal(r.verificationStatus, "verified");
    assert.match(t.writes().find((w) => /UPDATE dbo\.NXA_PlacementRecords/.test(w.q))!.q, /AND VerifiedAt IS NULL/);
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "VERIFY_PLACEMENT_RECORD");
  });

  it("employer feedback: the application must be for this company; the student comes from it; Rating is never written", async () => {
    let t = tracked((q) => (/SELECT CompanyId FROM dbo\.NXA_Companies/.test(q) ? { recordset: [{ CompanyId: 11 }] } : /FROM dbo\.NXA_JobApplications a JOIN/.test(q) ? { recordset: [{ StudentUserId: 301, CompanyId: 99 }] } : {}));
    await assert.rejects(t.repo.createCompanyFeedback("11", { feedbackText: "Great hire", jobApplicationId: "41" }, "7"), (e: unknown) => e instanceof PlacementRuleError && e.code === "APPLICATION_COMPANY_MISMATCH");
    assert.equal(t.writes().length, 0);

    t = tracked((q) => {
      if (/SELECT CompanyId FROM dbo\.NXA_Companies/.test(q)) return { recordset: [{ CompanyId: 11 }] };
      if (/FROM dbo\.NXA_JobApplications a JOIN/.test(q)) return { recordset: [{ StudentUserId: 301, CompanyId: 11 }] };
      if (/INSERT INTO dbo\.NXA_CompanyFeedback/.test(q)) return { recordset: [{ CompanyFeedbackId: 71 }] };
      return audit(q) ?? { recordset: [{ CompanyFeedbackId: 71, CompanyId: 11, FeedbackText: "Great hire", StudentUserId: 301, SubmittedAt: new Date() }] };
    });
    await t.repo.createCompanyFeedback("11", { feedbackText: "Great hire", jobApplicationId: "41" }, "7");
    const ins = t.writes().find((w) => /INSERT INTO dbo\.NXA_CompanyFeedback/.test(w.q))!;
    assert.doesNotMatch(ins.q, /Rating/);
    assert.equal(ins.inputs["StudentId"], "301");
  });

  it("a finished mock interview cannot be re-evaluated (409) and evaluation is audited", async () => {
    let t = tracked((q) => (/SELECT InterviewStatus/.test(q) ? { recordset: [{ InterviewStatus: "COMPLETED" }] } : {}));
    await assert.rejects(t.repo.evaluateMockInterview("21", 80, "Good answers", "completed", "401"), (e: unknown) => e instanceof PlacementRuleError && e.code === "MOCK_INTERVIEW_FINALIZED");
    assert.equal(t.writes().length, 0);
    t = tracked((q) => audit(q) ?? (/SELECT InterviewStatus/.test(q) ? { recordset: [{ InterviewStatus: "scheduled" }] } : { recordset: [{ MockInterviewId: 21, StudentUserId: 301, TeacherUserId: 401, InterviewStatus: "completed", ScheduledAt: new Date(), CreatedAt: new Date() }] }));
    await t.repo.evaluateMockInterview("21", 80, "Good answers", "completed", "401");
    assert.equal(t.seen.find((x) => /NXA_AuditLogs/.test(x.q))!.inputs["action"], "EVALUATE_MOCK_INTERVIEW");
  });

  it("analytics reads stored values only (no writes) and groups statuses as stored", async () => {
    const t = tracked(() => ({
      recordsets: [
        [{ Total: 3, Active: 2 }],
        [{ Status: "open", Cnt: 2 }, { Status: "closed", Cnt: 1 }],
        [{ Status: "applied", Cnt: 4 }, { Status: "selected", Cnt: 1 }],
        [{ Total: 5 }],
        [{ Total: 1, AvgSalary: 600000, MaxSalary: 600000 }],
        [{ Total: 1, Verified: 0 }],
        [{ Status: "completed", Cnt: 2, AvgScore: 75 }],
        [{ CompanyId: 11, CompanyName: "TCS", Placements: 1 }],
      ],
    }));
    const a = await t.repo.getPlacementAnalytics();
    assert.deepEqual(a.jobs, { total: 3, byStatus: { open: 2, closed: 1 } });
    assert.equal(a.applications.total, 5);
    assert.deepEqual(a.placements, { total: 1, verified: 0, pending: 1 });
    assert.equal(a.mockInterviews.averageScore, 75);
    assert.equal(t.writes().length, 0);
  });

  it("non-numeric ids are not found and never open a transaction", async () => {
    const t = tracked(() => ({}));
    for (const call of [
      () => t.repo.updateCompany("c-1", { industry: "x" }, "7"),
      () => t.repo.setCompanyActive("c-1", false, undefined, "7"),
      () => t.repo.updateJob("j-1", { jobTitle: "x" }, "7"),
      () => t.repo.createInterviewRound("a-1", { roundName: "HR" }, "7"),
      () => t.repo.createOffer("a-1", { offerReference: "X1" }, "7"),
      () => t.repo.verifyPlacement("p-1", "7"),
      () => t.repo.announceJob("j-1", "T", "B", "7"),
    ]) {
      await assert.rejects(call(), RecordNotFoundError);
    }
    assert.equal(t.state.began, 0);
  });
});

describe("/placements Admin endpoints", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const base = "/api/v1/placements";

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 70;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} P`, email: `${role}-p${seq}@test.local`, mobile: `98765433${seq}`, role, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
      ids[role] = user.id;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  const newCompany = async (name = "TCS") => (await json(await server.post(`${base}/companies`, { companyName: name, industry: "IT", contactEmail: "hr@tcs.test" }, auth("admin"))))["data"];
  const newJob = async (companyId: string, jobStatus = "open") =>
    (await json(await server.post(`${base}/jobs`, { companyId, jobTitle: "SDE", workLocation: "Pune", jobDescription: "Build reliable services", jobStatus }, auth("admin"))))["data"];
  const seedApplication = (jobId: string, companyId: string) => {
    const app = { id: "4001", jobId, companyId, jobTitle: "SDE", companyName: "TCS", studentUserId: ids["student"]!, applicationStatus: "applied" as const, appliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    harness.placements.applications.push(app);
    return app;
  };

  it("authorization: teacher and student get 403 on every new Admin endpoint; anonymous 401", async () => {
    const company = await newCompany();
    const job = await newJob(company.id);
    seedApplication(job.id, company.id);
    const calls: Array<[string, string, unknown?]> = [
      ["PATCH", `/companies/${company.id}`, { industry: "Fintech" }],
      ["PATCH", `/companies/${company.id}/status`, { isActive: false }],
      ["PATCH", `/jobs/${job.id}`, { jobTitle: "SDE II" }],
      ["GET", `/jobs/${job.id}/eligibility`],
      ["POST", `/jobs/${job.id}/announce`, {}],
      ["GET", "/applications"],
      ["GET", "/applications/4001/history"],
      ["POST", "/applications/4001/rounds", { roundName: "Technical" }],
      ["POST", "/applications/4001/offers", { offerReference: "OFR-1" }],
      ["GET", "/offers"],
      ["PATCH", "/questions/1", { category: "Java" }],
      ["POST", `/companies/${company.id}/feedback`, { feedbackText: "Good team" }],
      ["GET", "/feedback"],
      ["GET", "/analytics"],
      ["GET", "/packages"],
      ["GET", "/student-packages"],
    ];
    const send = (method: string, path: string, body: unknown, init?: RequestInit) =>
      method === "GET" ? server.get(base + path, init) : method === "POST" ? server.post(base + path, body, init) : server.patch(base + path, body, init);
    for (const [method, path, body] of calls) {
      for (const role of ["teacher", "student"]) assert.equal((await send(method, path, body, auth(role))).status, 403, `${role} ${method} ${path}`);
      assert.equal((await send(method, path, body, { headers: { "Content-Type": "application/json" } })).status, 401, `anon ${method} ${path}`);
    }
  });

  it("companies: create with contacts, edit, duplicate name refused, deactivation blocks new jobs, never deleted", async () => {
    const c = await newCompany();
    assert.equal(c.contactEmail, "hr@tcs.test");
    const edit = await json(await server.patch(`${base}/companies/${c.id}`, { address: "Pune", contactMobile: "+91 98765 43210" }, auth("super_admin")));
    assert.equal(edit["data"].changed, true);
    assert.equal(edit["data"].record.address, "Pune");
    assert.equal((await json(await server.patch(`${base}/companies/${c.id}`, { address: "Pune" }, auth("admin"))))["data"].changed, false);
    assert.equal((await server.post(`${base}/companies`, { companyName: " tcs " }, auth("admin"))).status, 409);
    assert.equal((await server.patch(`${base}/companies/${c.id}`, { contactEmail: "not-an-email" }, auth("admin"))).status, 422);
    assert.equal((await server.patch(`${base}/companies/${c.id}`, { logoUrl: "x" }, auth("admin"))).status, 422);

    const off = await json(await server.patch(`${base}/companies/${c.id}/status`, { isActive: false, reason: "Hiring freeze" }, auth("admin")));
    assert.equal(off["data"].record.isActive, false);
    const blocked = await server.post(`${base}/jobs`, { companyId: c.id, jobTitle: "SDE", workLocation: "Pune", jobDescription: "Build reliable services" }, auth("admin"));
    assert.equal(blocked.status, 409);
    assert.equal((await json(blocked))["error"], "COMPANY_INACTIVE");
    assert.equal((await server.delete(`${base}/companies/${c.id}`, auth("super_admin"))).status, 404, "no delete route");
    assert.equal(harness.placements.companies.length, 1);
  });

  it("jobs: draft, edit, open (published stamp), no-op status, salary validation, announce once to eligible students", async () => {
    const c = await newCompany();
    const draft = await newJob(c.id, "draft");
    assert.equal(draft.publishedAt, undefined);
    assert.equal((await server.patch(`${base}/jobs/${draft.id}`, { salaryMin: 900000, salaryMax: 500000 }, auth("admin"))).status, 422);
    const edited = await json(await server.patch(`${base}/jobs/${draft.id}`, { jobTitle: "SDE II", salaryMin: 500000 }, auth("admin")));
    assert.equal(edited["data"].record.jobTitle, "SDE II");
    assert.equal((await server.post(`${base}/jobs/${draft.id}/announce`, {}, auth("admin"))).status, 409, "a draft cannot be announced");

    const opened = await json(await server.patch(`${base}/jobs/${draft.id}/status`, { status: "open" }, auth("admin")));
    assert.equal(opened["data"].jobStatus, "open");
    assert.ok(opened["data"].publishedAt);
    assert.equal((await json(await server.patch(`${base}/jobs/${draft.id}/status`, { status: "open" }, auth("admin"))))["data"].changed, false);
    assert.equal((await server.patch(`${base}/jobs/${draft.id}/status`, { status: "archived" }, auth("admin"))).status, 422, "D1: no new job statuses");

    harness.placements.eligibleStudentIds = [ids["student"]!];
    const ann = await server.post(`${base}/jobs/${draft.id}/announce`, {}, auth("admin"));
    assert.equal(ann.status, 201);
    assert.equal((await json(ann))["data"].recipientCount, 1);
    assert.equal(harness.placements.notifications[0]!.notificationType, "placement");
    assert.equal((await server.post(`${base}/jobs/${draft.id}/announce`, {}, auth("super_admin"))).status, 409, "announced once");
    assert.equal((await json(await server.get(`${base}/jobs/${draft.id}/eligibility`, auth("admin"))))["data"].length, 0);
  });

  it("applications: list with filters, status change with reason and history, no-op, D1 vocabulary only", async () => {
    const c = await newCompany();
    const job = await newJob(c.id);
    seedApplication(job.id, c.id);
    assert.equal((await json(await server.get(`${base}/applications?companyId=${c.id}&status=applied`, auth("admin"))))["data"].length, 1);
    assert.equal((await json(await server.get(`${base}/applications?status=selected`, auth("admin"))))["data"].length, 0);
    assert.equal((await server.get(`${base}/applications?status=offered`, auth("admin"))).status, 422, "D1: offered is not a status");
    assert.equal((await server.patch(`${base}/applications/4001/status`, { status: "technical_interview" }, auth("admin"))).status, 422);

    await server.patch(`${base}/applications/4001/status`, { status: "shortlisted", reason: "Cleared aptitude" }, auth("admin"));
    await server.patch(`${base}/applications/4001/status`, { status: "shortlisted" }, auth("admin"));
    const history = (await json(await server.get(`${base}/applications/4001/history`, auth("admin"))))["data"];
    assert.equal(history.length, 1, "the repeat was a no-op");
    assert.deepEqual([history[0].previousStatus, history[0].newStatus, history[0].changeReason], ["applied", "shortlisted", "Cleared aptitude"]);
    assert.equal((await server.get(`${base}/applications/9999/history`, auth("admin"))).status, 404);
  });

  it("interview rounds, offers, placement record verification and employer feedback", async () => {
    const c = await newCompany();
    const job = await newJob(c.id);
    seedApplication(job.id, c.id);

    const r1 = await json(await server.post(`${base}/applications/4001/rounds`, { roundName: "Technical", scheduledAt: new Date(Date.now() + 86400000).toISOString() }, auth("admin")));
    assert.equal(r1["data"].roundNumber, 1);
    assert.equal((await json(await server.post(`${base}/applications/4001/rounds`, { roundName: "HR" }, auth("admin"))))["data"].roundNumber, 2);
    assert.equal((await server.post(`${base}/applications/4001/rounds`, { roundName: "Again", roundNumber: 2 }, auth("admin"))).status, 409);
    const upd = await json(await server.patch(`${base}/rounds/${r1["data"].id}`, { feedback: "Strong in Java" }, auth("admin")));
    assert.equal(upd["data"].record.feedback, "Strong in Java");
    assert.equal((await json(await server.patch(`${base}/rounds/${r1["data"].id}`, { feedback: "Strong in Java" }, auth("admin"))))["data"].changed, false);
    assert.equal((await json(await server.get(`${base}/applications/4001/rounds`, auth("admin"))))["data"].length, 2);

    const offer = await json(await server.post(`${base}/applications/4001/offers`, { offerReference: "OFR-2026-1", offeredSalary: 650000, offerDate: "2026-12-01", joiningDate: "2027-01-10" }, auth("admin")));
    assert.equal(offer["data"].hasLetter, false);
    assert.equal((await server.post(`${base}/applications/4001/offers`, { offerReference: "ofr-2026-1" }, auth("admin"))).status, 409);
    assert.equal((await server.post(`${base}/applications/4001/offers`, { offerReference: "OFR-X", offerDate: "2026-12-01", joiningDate: "2026-11-01" }, auth("admin"))).status, 422);

    const record = await json(await server.post(`${base}/records`, { jobApplicationId: "4001", offerId: offer["data"].id }, auth("admin")));
    assert.equal(record["data"].verificationStatus, "pending");
    const verified = await json(await server.patch(`${base}/records/${record["data"].id}/verify`, {}, auth("super_admin")));
    assert.equal(verified["data"].verificationStatus, "verified");
    assert.equal((await server.patch(`${base}/records/${record["data"].id}/verify`, {}, auth("admin"))).status, 409);

    const other = await newCompany("Wipro");
    assert.equal((await server.post(`${base}/companies/${other.id}/feedback`, { feedbackText: "Not ours", jobApplicationId: "4001" }, auth("admin"))).status, 422);
    assert.equal((await server.post(`${base}/companies/${c.id}/feedback`, { feedbackText: "Great hire", rating: 5 }, auth("admin"))).status, 422, "rating scale not approved");
    const fb = await json(await server.post(`${base}/companies/${c.id}/feedback`, { feedbackText: "Great hire", jobApplicationId: "4001" }, auth("admin")));
    assert.equal(fb["data"].studentUserId, ids["student"]);

    const a = (await json(await server.get(`${base}/analytics`, auth("admin"))))["data"];
    assert.equal(a.placements.verified, 1);
    assert.equal(a.interviewRounds, 2);
    assert.equal(a.offers.highestOfferedSalary, 650000);
  });

  it("mock interviews: interviewer must be a teacher, candidate an eligible student; finished results cannot be overwritten", async () => {
    const at = new Date(Date.now() + 86400000).toISOString();
    const schedule = (body: Record<string, unknown>, role = "admin") => server.post(`${base}/mock-interviews/schedule`, { scheduledAt: at, ...body }, auth(role));
    assert.equal((await schedule({ studentUserId: ids["student"], teacherUserId: ids["admin"] })).status, 422, "admin is not a teacher");
    assert.equal((await schedule({ studentUserId: ids["teacher"], teacherUserId: ids["teacher"] })).status, 422, "candidate must be a student");
    assert.equal((await schedule({ studentUserId: ids["student"], teacherUserId: ids["teacher"] })).status, 403, "BR-013: no active enrollment");
    assert.equal((await schedule({ studentUserId: ids["student"], teacherUserId: ids["teacher"], scheduledAt: new Date(Date.now() - 60000).toISOString() })).status, 422, "past time");

    await seedEnrollment(harness, ids["student"]!, "placement-course", { status: "active" });
    const ok = await schedule({ studentUserId: ids["student"], teacherUserId: ids["teacher"] });
    assert.equal(ok.status, 201);
    const id = (await json(ok))["data"].id;
    const evaluate = (role: string) => server.post(`${base}/mock-interviews/${id}/evaluate`, { overallScore: 82, feedback: "Clear explanations", status: "completed" }, auth(role));
    assert.equal((await evaluate("admin")).status, 200);
    assert.equal((await evaluate("teacher")).status, 409, "result already recorded");
    assert.ok(harness.placements.audits.some((x) => x.actionType === "SCHEDULE_MOCK_INTERVIEW"));
  });

  it("question bank: edit, deactivate (hidden from students, visible to staff), no-op", async () => {
    await seedEnrollment(harness, ids["student"]!, "placement-course", { status: "active" });
    const q = (await json(await server.post(`${base}/questions`, { category: "Java", questionText: "Explain the JVM memory model" }, auth("admin"))))["data"];
    assert.equal((await json(await server.patch(`${base}/questions/${q.id}`, { difficultyLevel: "advanced" }, auth("admin"))))["data"].record.difficultyLevel, "advanced");
    await server.patch(`${base}/questions/${q.id}/status`, { isActive: false }, auth("admin"));
    assert.equal((await json(await server.patch(`${base}/questions/${q.id}/status`, { isActive: false }, auth("admin"))))["data"].changed, false);
    assert.equal((await json(await server.get(`${base}/questions`, auth("student"))))["data"].length, 0);
    assert.equal((await json(await server.get(`${base}/questions?includeInactive=true`, auth("student"))))["data"].length, 0, "students never see inactive questions");
    assert.equal((await json(await server.get(`${base}/questions?includeInactive=true`, auth("admin"))))["data"].length, 1);
  });

  it("a failed audit write rolls the change back (round, offer, company status)", async () => {
    const c = await newCompany();
    const job = await newJob(c.id);
    seedApplication(job.id, c.id);
    harness.placements.failAudit = true;
    assert.equal((await server.post(`${base}/applications/4001/rounds`, { roundName: "Technical" }, auth("admin"))).status, 500);
    assert.equal((await server.post(`${base}/applications/4001/offers`, { offerReference: "OFR-9" }, auth("admin"))).status, 500);
    assert.equal((await server.patch(`${base}/companies/${c.id}/status`, { isActive: false }, auth("admin"))).status, 500);
    assert.equal(harness.placements.rounds.length, 0);
    assert.equal(harness.placements.offers.length, 0);
    assert.equal(harness.placements.companies[0]!.isActive, true);
  });
});
