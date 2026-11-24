import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerPlacementRepository } from "../src/modules/placements/sqlserver-placement.repository";
import { createTestHarness, type TestHarness } from "./fakes";
import { seedEnrollment } from "./helpers/learning-access";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 2 item 4: the placement repository against the live schema. Ids are
 * BIGINT identities; NXA_Companies has IsActive (no HiringStatus / LogoUrl);
 * NXA_PlacementRecords needs JobId + JobApplicationId (job title from the job,
 * package and offer date from NXA_Offers); NXA_InterviewQuestionBank uses
 * InterviewQuestionId / Difficulty / SuggestedAnswer and has no creator column.
 */

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
      begin: async () => {
        state.began += 1;
      },
      commit: async () => {
        state.committed = true;
      },
      rollback: async () => {
        state.rolledBack = true;
      },
      request: () => new MockSqlRequest(wrapped),
    }),
  } as unknown as sql.ConnectionPool;
  const writes = () => seen.filter((s) => /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(s.q));
  return { pool, state, seen, writes, repo: new SqlServerPlacementRepository(async () => pool) };
};

const sqlError = (num: number): Error => Object.assign(new Error(`SQL error ${num}`), { number: num });
const insertColumns = (q: string, table: string): string[] | undefined =>
  new RegExp(`${table}\\s*\\(([^)]*)\\)`).exec(q)?.[1]?.split(",").map((c) => c.trim());

describe("placement repository against the live schema", () => {
  describe("companies", () => {
    it("reads IsActive (no HiringStatus or LogoUrl) and maps it to the status", async () => {
      const t = tracked(() => ({
        recordset: [
          { CompanyId: 11, CompanyName: "Infosys", WebsiteUrl: null, Industry: "IT", IsActive: false, CreatedAt: new Date() },
        ],
      }));
      const [c] = await t.repo.getCompanies();
      assert.match(t.seen[0]!.q, /SELECT CompanyId, CompanyName, WebsiteUrl, Industry, Description, Address, ContactName, ContactEmail, ContactMobile,\s+IsActive, CreatedAt/);
      assert.doesNotMatch(t.seen[0]!.q, /HiringStatus|LogoUrl/);
      assert.equal(c!.id, "11");
      assert.equal(c!.isActive, false);
      assert.equal(c!.hiringStatus, "inactive");
      assert.equal("logoUrl" in c!, false);
    });

    it("finds nothing for a non-numeric id without querying", async () => {
      const t = tracked(() => ({ recordset: [] }));
      assert.equal(await t.repo.getCompanyById("comp-1"), null);
      assert.equal(t.seen.length, 0);
    });

    it("creates a company with an identity id and audits it in the same transaction", async () => {
      const t = tracked((q) => {
        if (q.includes("UPPER(LTRIM(RTRIM(CompanyName)))")) return { recordset: [] }; // no company with this name yet
        if (q.includes("INSERT INTO dbo.NXA_Companies")) return { recordset: [{ CompanyId: 12 }] };
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return { recordset: [{ AuditLogId: 1 }] };
        return { recordset: [{ CompanyId: 12, CompanyName: "TCS", IsActive: true, CreatedAt: new Date() }] };
      });
      const c = await t.repo.createCompany({ companyName: "TCS", isActive: true }, "7");
      const [ins, audit] = t.writes();
      assert.deepEqual(insertColumns(ins!.q, "NXA_Companies"), ["CompanyName", "WebsiteUrl", "Industry", "Description", "Address", "ContactName", "ContactEmail", "ContactMobile", "IsActive", "CreatedAt"]);
      assert.equal(ins!.inputs["IsActive"], 1);
      assert.equal(audit!.inputs["action"], "CREATE_COMPANY");
      assert.ok(t.state.committed);
      assert.equal(c.id, "12");
    });

    it("rolls back the company when the audit cannot be written", async () => {
      const t = tracked((q) => {
        if (q.includes("INSERT INTO dbo.NXA_Companies")) return { recordset: [{ CompanyId: 12 }] };
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return new Error("audit down");
        return { recordset: [] };
      });
      await assert.rejects(t.repo.createCompany({ companyName: "TCS", isActive: true }, "7"), /audit down/);
      assert.ok(t.state.rolledBack && !t.state.committed);
    });
  });

  describe("jobs", () => {
    const jobRow = { JobId: 31, CompanyId: 11, CompanyName: "TCS", JobTitle: "SDE", JobStatus: "OPEN", JobDescription: "x", CreatedAt: new Date(), MinExperienceYears: 1.5, ApplicationDeadline: new Date("2026-12-31") };

    it("creates a job for an existing company with BIGINT ids and no explicit JobId", async () => {
      const t = tracked((q) => {
        if (q.includes("SELECT IsActive FROM dbo.NXA_Companies")) return { recordset: [{ IsActive: true }] };
        if (q.includes("INSERT INTO dbo.NXA_Jobs")) return { recordset: [{ JobId: 31 }] };
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return { recordset: [{ AuditLogId: 1 }] };
        return { recordset: [jobRow] };
      });
      const job = await t.repo.createJob(
        {
          companyId: "11", jobTitle: "SDE", employmentType: "full_time", workLocation: "Pune", minExperienceYears: 1,
          jobStatus: "open", jobDescription: "Build things", publishedByUserId: "7",
        },
        "7",
      );
      const ins = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_Jobs"))!;
      assert.equal(insertColumns(ins.q, "NXA_Jobs")![0], "CompanyId", "no JobId column: it is an identity");
      assert.equal(ins.inputs["CompanyId"], "11");
      assert.equal(ins.inputs["PublishedByUserId"], "7");
      assert.equal(job.id, "31");
      assert.equal(job.jobStatus, "open", "status normalised to lower case");
      assert.equal(job.minExperienceYears, 1.5);
      assert.equal(job.applicationDeadline, "2026-12-31");
      assert.ok(t.state.committed);
    });

    it("refuses a job for an unknown company and rolls back", async () => {
      const t = tracked(() => ({ recordset: [] }));
      await assert.rejects(
        t.repo.createJob(
          { companyId: "99", jobTitle: "SDE", employmentType: "full_time", workLocation: "Pune", minExperienceYears: 0, jobStatus: "open", jobDescription: "Build things" },
          "7",
        ),
        (err: Error) => err.name === "RecordNotFoundError",
      );
      assert.ok(t.state.rolledBack);
      assert.equal(t.writes().length, 0);
    });

    it("updates a job status under a lock with an audit, and 404s an unknown job", async () => {
      const t = tracked((q) => {
        if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ JobStatus: "open" }] };
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return { recordset: [{ AuditLogId: 1 }] };
        return { recordset: [{ ...jobRow, JobStatus: "closed" }] };
      });
      const { record: job, changed } = await t.repo.updateJobStatus("31", "closed", "7");
      assert.equal(changed, true);
      assert.equal(job.jobStatus, "closed");
      const audit = t.writes().find((w) => w.q.includes("NXA_AuditLogs"))!;
      assert.equal(audit.inputs["action"], "SET_JOB_STATUS");

      const missing = tracked(() => ({ recordset: [] }));
      await assert.rejects(missing.repo.updateJobStatus("32", "closed", "7"), (err: Error) => err.name === "RecordNotFoundError");
      assert.ok(missing.state.rolledBack);
      assert.equal(missing.writes().length, 0);
    });

    it("filters by status case-insensitively and ignores non-numeric company filters", async () => {
      const t = tracked(() => ({ recordset: [jobRow] }));
      await t.repo.getJobs({ status: "OPEN" });
      assert.match(t.seen[0]!.q, /LOWER\(j\.JobStatus\) = @JobStatus/);
      assert.equal(t.seen[0]!.inputs["JobStatus"], "open");
      assert.deepEqual(await t.repo.getJobs({ companyId: "abc" }), []);
    });
  });

  describe("applications", () => {
    const appRow = { JobApplicationId: 41, JobId: 31, JobTitle: "SDE", CompanyName: "TCS", StudentUserId: 301, ApplicationStatus: "applied", AppliedAt: new Date(), UpdatedAt: null };

    it("maps a duplicate application to DuplicateRecordError and a missing reference to a rule error", async () => {
      const dup = tracked(() => sqlError(2627));
      await assert.rejects(
        dup.repo.applyForJob({ jobId: "31", studentUserId: "301", applicationStatus: "applied" }),
        (err: Error) => err.name === "DuplicateRecordError",
      );
      const fk = tracked(() => sqlError(547));
      await assert.rejects(
        fk.repo.applyForJob({ jobId: "31", studentUserId: "301", applicationStatus: "applied" }),
        (err: Error & { code?: string }) => err.code === "REFERENCE_NOT_FOUND",
      );
    });

    it("changes status with a status-history row and an audit, in one transaction", async () => {
      const t = tracked((q) => {
        if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ ApplicationStatus: "shortlisted" }] };
        if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return { recordset: [{ AuditLogId: 1 }] };
        return { recordset: [{ ...appRow, ApplicationStatus: "selected" }] };
      });
      const app = await t.repo.updateApplicationStatus("41", "selected", "7");
      assert.equal(app.applicationStatus, "selected");
      const [upd, hist, audit] = t.writes();
      assert.match(upd!.q, /UPDATE dbo\.NXA_JobApplications SET ApplicationStatus = @Status/);
      assert.deepEqual(insertColumns(hist!.q, "NXA_JobApplicationStatusHistory"), [
        "JobApplicationId", "PreviousStatus", "NewStatus", "ChangedByUserId", "ChangeReason", "ChangedAt",
      ]);
      assert.equal(hist!.inputs["Previous"], "shortlisted");
      assert.equal(hist!.inputs["Next"], "selected");
      assert.equal(hist!.inputs["ChangedBy"], "7");
      assert.equal(audit!.inputs["action"], "SET_APPLICATION_STATUS");
      assert.ok(t.state.committed);
    });

    it("writes nothing when the status is unchanged", async () => {
      const t = tracked((q) => (q.includes("WITH (UPDLOCK, HOLDLOCK)") ? { recordset: [{ ApplicationStatus: "SELECTED" }] } : { recordset: [appRow] }));
      await t.repo.updateApplicationStatus("41", "selected", "7");
      assert.equal(t.writes().length, 0);
    });

    it("rolls back the status change when the history insert fails, and 404s an unknown application", async () => {
      const t = tracked((q) => {
        if (q.includes("WITH (UPDLOCK, HOLDLOCK)")) return { recordset: [{ ApplicationStatus: "applied" }] };
        if (q.includes("NXA_JobApplicationStatusHistory")) return new Error("history unavailable");
        return { recordset: [] };
      });
      await assert.rejects(t.repo.updateApplicationStatus("41", "rejected", "7"), /history unavailable/);
      assert.ok(t.state.rolledBack && !t.state.committed);

      const missing = tracked(() => ({ recordset: [] }));
      await assert.rejects(missing.repo.updateApplicationStatus("42", "rejected", "7"), (err: Error) => err.name === "RecordNotFoundError");
      await assert.rejects(missing.repo.updateApplicationStatus("app-1", "rejected", "7"), (err: Error) => err.name === "RecordNotFoundError");
    });
  });

  describe("placement records and offers", () => {
    it("lists records with job title from NXA_Jobs and package/offer date from NXA_Offers", async () => {
      const t = tracked(() => ({
        recordset: [
          {
            PlacementRecordId: 51, StudentUserId: 301, StudentName: "Asha", CompanyId: 11, CompanyName: "TCS", JobId: 31, JobTitle: "SDE",
            JobApplicationId: 41, OfferId: 61, OfferedSalary: 650000, OfferDate: new Date("2026-11-01"), JoiningDate: new Date("2026-12-01"),
            EmploymentStatus: "ACTIVE", VerifiedAt: new Date(), VerifiedByUserId: 7,
          },
          {
            PlacementRecordId: 52, StudentUserId: 302, CompanyId: 11, JobId: 31, JobTitle: "SDE", JobApplicationId: 42,
            OfferId: null, OfferedSalary: null, OfferDate: null, JoiningDate: null, EmploymentStatus: null, VerifiedAt: null, VerifiedByUserId: null,
          },
        ],
      }));
      const [a, b] = await t.repo.getPlacements();
      const q = t.seen[0]!.q;
      assert.match(q, /p\.PlacementRecordId/);
      assert.match(q, /LEFT JOIN dbo\.NXA_Jobs j ON p\.JobId = j\.JobId/);
      assert.match(q, /LEFT JOIN dbo\.NXA_Offers o ON p\.OfferId = o\.OfferId/);
      assert.doesNotMatch(q, /p\.PlacementId|p\.JobTitle|PackageOffered|p\.OfferDate|VerificationStatus/);
      assert.equal(a!.id, "51");
      assert.equal(a!.jobTitle, "SDE");
      assert.equal(a!.packageOffered, 650000);
      assert.equal(a!.offerDate, "2026-11-01");
      assert.equal(a!.joiningDate, "2026-12-01");
      assert.equal(a!.verificationStatus, "verified");
      assert.equal(a!.verifiedByUserId, "7");
      assert.equal(b!.verificationStatus, "pending");
      assert.equal(b!.packageOffered, undefined, "no offer, no package: nothing invented");
    });

    const placementHandler = (over: { app?: unknown[]; offer?: unknown[]; dup?: unknown[]; audit?: Error } = {}): Handler => (q) => {
      if (q.includes("FROM dbo.NXA_JobApplications a")) return { recordset: over.app ?? [{ StudentUserId: 301, JobId: 31, CompanyId: 11 }] };
      if (q.includes("FROM dbo.NXA_Offers WHERE OfferId")) return { recordset: over.offer ?? [{ JobApplicationId: 41 }] };
      if (q.includes("FROM dbo.NXA_PlacementRecords WITH (UPDLOCK, HOLDLOCK)")) return { recordset: over.dup ?? [] };
      if (q.includes("INSERT INTO dbo.NXA_PlacementRecords")) return { recordset: [{ PlacementRecordId: 51 }] };
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return over.audit ?? { recordset: [{ AuditLogId: 1 }] };
      return { recordset: [{ PlacementRecordId: 51, StudentUserId: 301, CompanyId: 11, JobId: 31, JobApplicationId: 41, OfferId: 61, VerifiedAt: new Date() }] };
    };

    it("records a placement from the application (student, job, company never from the client)", async () => {
      const t = tracked(placementHandler());
      const rec = await t.repo.createPlacement({ jobApplicationId: "41", offerId: "61", joiningDate: "2026-12-01", verificationStatus: "verified" }, "7");
      const ins = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_PlacementRecords"))!;
      assert.deepEqual(insertColumns(ins.q, "NXA_PlacementRecords"), [
        "StudentUserId", "CompanyId", "JobId", "JobApplicationId", "OfferId", "JoiningDate", "VerifiedAt", "VerifiedByUserId",
      ]);
      assert.doesNotMatch(ins.q, /EmploymentStatus/, "status values are not visible; the table default applies");
      assert.equal(ins.inputs["StudentUserId"], 301);
      assert.equal(ins.inputs["JobId"], 31);
      assert.equal(ins.inputs["CompanyId"], 11);
      assert.equal(ins.inputs["AppId"], "41");
      assert.equal(ins.inputs["OfferId"], "61");
      assert.equal(ins.inputs["VerifiedBy"], "7");
      assert.match(ins.q, /SYSUTCDATETIME\(\), @VerifiedBy/);
      assert.ok(t.state.committed);
      assert.equal(rec.id, "51");

      const audit = t.writes().find((w) => w.q.includes("NXA_AuditLogs"))!;
      assert.equal(audit.inputs["action"], "CREATE_PLACEMENT_RECORD");
    });

    it("leaves a pending record unverified", async () => {
      const t = tracked(placementHandler());
      await t.repo.createPlacement({ jobApplicationId: "41", verificationStatus: "pending" }, "7");
      const ins = t.writes().find((w) => w.q.includes("INSERT INTO dbo.NXA_PlacementRecords"))!;
      assert.equal(ins.inputs["VerifiedBy"], null);
      assert.match(ins.q, /NULL, @VerifiedBy/);
      assert.equal(ins.inputs["OfferId"], null);
    });

    it("refuses an unknown application, an unknown or foreign offer, and a second record; rolls back each time", async () => {
      const cases: Array<[Parameters<typeof placementHandler>[0], { offerId?: string }, (e: Error & { code?: string }) => boolean]> = [
        [{ app: [] }, {}, (e) => e.name === "RecordNotFoundError"],
        [{ offer: [] }, { offerId: "61" }, (e) => e.name === "RecordNotFoundError"],
        [{ offer: [{ JobApplicationId: 99 }] }, { offerId: "61" }, (e) => e.code === "OFFER_APPLICATION_MISMATCH"],
        [{ dup: [{ x: 1 }] }, {}, (e) => e.name === "DuplicateRecordError"],
      ];
      for (const [over, extra, check] of cases) {
        const t = tracked(placementHandler(over));
        await assert.rejects(t.repo.createPlacement({ jobApplicationId: "41", verificationStatus: "pending", ...extra }, "7"), check);
        assert.ok(t.state.rolledBack && !t.state.committed);
        assert.equal(t.writes().length, 0);
      }
    });

    it("rolls back the record when the audit fails", async () => {
      const t = tracked(placementHandler({ audit: new Error("audit down") }));
      await assert.rejects(t.repo.createPlacement({ jobApplicationId: "41", verificationStatus: "pending" }, "7"), /audit down/);
      assert.ok(t.state.rolledBack && !t.state.committed);
    });
  });

  describe("interview question bank", () => {
    it("reads InterviewQuestionId / Difficulty / SuggestedAnswer for active questions only", async () => {
      const t = tracked(() => ({
        recordset: [{ InterviewQuestionId: 71, Category: "Java", QuestionText: "What is JVM?", Difficulty: "Beginner", SuggestedAnswer: "A VM" }],
      }));
      const [q] = await t.repo.getQuestions("Java");
      assert.match(t.seen[0]!.q, /SELECT InterviewQuestionId, Category, QuestionText, Difficulty, SuggestedAnswer/);
      assert.match(t.seen[0]!.q, /WHERE IsActive = 1/);
      assert.doesNotMatch(t.seen[0]!.q, /\bQuestionId\b|DifficultyLevel|SampleAnswer|CreatedByUserId/);
      assert.deepEqual(q, { id: "71", category: "Java", questionText: "What is JVM?", difficultyLevel: "beginner", sampleAnswer: "A VM" });
    });

    it("inserts only live columns (no id, no creator)", async () => {
      const t = tracked(() => ({ recordset: [{ InterviewQuestionId: 72 }] }));
      const q = await t.repo.addQuestion({ category: "Java", questionText: "What is GC?", difficultyLevel: "intermediate" });
      assert.deepEqual(insertColumns(t.seen[0]!.q, "NXA_InterviewQuestionBank"), [
        "Category", "QuestionText", "Difficulty", "SuggestedAnswer", "IsActive", "CreatedAt",
      ]);
      assert.equal(q.id, "72");
    });
  });
});

describe("placement endpoints: Admin and Super Admin operations", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const body = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 60;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@test.local`, mobile: `98765432${seq}`, role, status: "active" });
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

  const createCompany = async (role = "admin", extra: Record<string, unknown> = {}) =>
    server.post("/api/v1/placements/companies", { companyName: "TCS", industry: "IT Services", ...extra }, auth(role));

  it("lets Admin and Super Admin create companies and refuses others", async () => {
    assert.equal((await createCompany("admin")).status, 201);
    assert.equal((await createCompany("super_admin", { companyName: "Wipro" })).status, 201);
    assert.equal((await createCompany("super_admin", { companyName: " tcs " })).status, 409, "duplicate company name (case-insensitive)");
    for (const role of ["teacher", "student"]) assert.equal((await createCompany(role)).status, 403, role);
    const anon = await server.post("/api/v1/placements/companies", { companyName: "X Corp" }, { headers: { "Content-Type": "application/json" } });
    assert.equal(anon.status, 401);
    const list = await body(await server.get("/api/v1/placements/companies"));
    assert.equal(list["data"].length, 2);
  });

  it("refuses company fields the database cannot store", async () => {
    assert.equal((await createCompany("admin", { logoUrl: "https://x.test/logo.png" })).status, 422);
    assert.equal((await createCompany("admin", { hiringStatus: "partner" })).status, 422);
    const inactive = await body(await createCompany("admin", { hiringStatus: "inactive" }));
    assert.equal(inactive["data"].isActive, false);
  });

  it("manages jobs: numeric company id, validated status changes, 404 for unknown jobs", async () => {
    const companyId = (await body(await createCompany()))["data"].id as string;
    const bad = await server.post(
      "/api/v1/placements/jobs",
      { companyId: "comp-1", jobTitle: "SDE", workLocation: "Pune", jobDescription: "Build reliable services" },
      auth("admin"),
    );
    assert.equal(bad.status, 422);
    const unknownCompany = await server.post(
      "/api/v1/placements/jobs",
      { companyId: "999999", jobTitle: "SDE", workLocation: "Pune", jobDescription: "Build reliable services" },
      auth("admin"),
    );
    assert.equal(unknownCompany.status, 404);

    const job = await body(await server.post(
      "/api/v1/placements/jobs",
      { companyId, jobTitle: "SDE", workLocation: "Pune", jobDescription: "Build reliable services" },
      auth("admin"),
    ));
    const jobId = job["data"].id as string;

    assert.equal((await server.patch(`/api/v1/placements/jobs/${jobId}/status`, { status: "archived" }, auth("admin"))).status, 422);
    assert.equal((await server.patch(`/api/v1/placements/jobs/${jobId}/status`, {}, auth("admin"))).status, 422);
    assert.equal((await server.patch("/api/v1/placements/jobs/999999/status", { status: "closed" }, auth("admin"))).status, 404);
    assert.equal((await server.patch(`/api/v1/placements/jobs/${jobId}/status`, { status: "closed" }, auth("teacher"))).status, 403);
    const closed = await server.patch(`/api/v1/placements/jobs/${jobId}/status`, { status: "closed" }, auth("super_admin"));
    assert.equal(closed.status, 200);
    assert.equal((await body(closed))["data"].jobStatus, "closed");
  });

  it("runs application -> status history -> placement record, admin-only, one record per application", async () => {
    const companyId = (await body(await createCompany()))["data"].id as string;
    const jobId = (await body(await server.post(
      "/api/v1/placements/jobs",
      { companyId, jobTitle: "SDE", workLocation: "Pune", jobDescription: "Build reliable services" },
      auth("admin"),
    )))["data"].id as string;

    await seedEnrollment(harness, ids["student"]!, "placement-course", { status: "active" });
    const applied = await server.post(`/api/v1/placements/jobs/${jobId}/apply`, {}, auth("student"));
    assert.equal(applied.status, 201);
    const applicationId = (await body(applied))["data"].id as string;
    assert.equal((await server.post(`/api/v1/placements/jobs/${jobId}/apply`, {}, auth("student"))).status, 409, "one application per job");

    assert.equal((await server.get(`/api/v1/placements/jobs/${jobId}/applications`, auth("teacher"))).status, 403);
    const selected = await server.patch(`/api/v1/placements/applications/${applicationId}/status`, { status: "selected" }, auth("admin"));
    assert.equal(selected.status, 200);
    assert.deepEqual(harness.placements.applicationStatusHistory.map((h) => [h.previousStatus, h.newStatus]), [["applied", "selected"]]);
    assert.equal((await server.patch("/api/v1/placements/applications/999999/status", { status: "selected" }, auth("admin"))).status, 404);

    for (const role of ["teacher", "student"]) {
      assert.equal((await server.get("/api/v1/placements/records", auth(role))).status, 403, role);
      assert.equal((await server.post("/api/v1/placements/records", { jobApplicationId: applicationId }, auth(role))).status, 403, role);
    }
    assert.equal((await server.post("/api/v1/placements/records", { jobApplicationId: applicationId, verificationStatus: "rejected" }, auth("admin"))).status, 422);
    assert.equal((await server.post("/api/v1/placements/records", { studentUserId: "1", companyId, jobTitle: "SDE" }, auth("admin"))).status, 422);

    const created = await server.post("/api/v1/placements/records", { jobApplicationId: applicationId, verificationStatus: "verified", joiningDate: "2026-12-01" }, auth("admin"));
    assert.equal(created.status, 201);
    const rec = (await body(created))["data"];
    assert.equal(rec.studentUserId, ids["student"]);
    assert.equal(rec.jobTitle, "SDE");
    assert.equal(rec.verificationStatus, "verified");
    assert.equal((await server.post("/api/v1/placements/records", { jobApplicationId: applicationId }, auth("super_admin"))).status, 409);

    const list = await body(await server.get("/api/v1/placements/records", auth("super_admin")));
    assert.equal(list["data"].length, 1);
  });

  it("links a placement to an offer only when the offer belongs to the application", async () => {
    const companyId = (await body(await createCompany()))["data"].id as string;
    const jobId = (await body(await server.post(
      "/api/v1/placements/jobs",
      { companyId, jobTitle: "SDE", workLocation: "Pune", jobDescription: "Build reliable services" },
      auth("admin"),
    )))["data"].id as string;
    await seedEnrollment(harness, ids["student"]!, "placement-course", { status: "active" });
    const applicationId = (await body(await server.post(`/api/v1/placements/jobs/${jobId}/apply`, {}, auth("student"))))["data"].id as string;
    harness.placements.offers.push({ id: "61", jobApplicationId: "999", offeredSalary: 500000 }, { id: "62", jobApplicationId: applicationId, offeredSalary: 650000, offerDate: "2026-11-01" });

    const foreign = await server.post("/api/v1/placements/records", { jobApplicationId: applicationId, offerId: "61" }, auth("admin"));
    assert.equal(foreign.status, 422);
    assert.equal((await body(foreign))["error"], "OFFER_APPLICATION_MISMATCH");

    const ok = await body(await server.post("/api/v1/placements/records", { jobApplicationId: applicationId, offerId: "62" }, auth("admin")));
    assert.equal(ok["data"].packageOffered, 650000);
    assert.equal(ok["data"].offerDate, "2026-11-01");
    assert.equal(ok["data"].verificationStatus, "pending");
  });

  it("stores interview questions without a creator", async () => {
    const res = await server.post("/api/v1/placements/questions", { category: "Java", questionText: "Explain the JVM memory model" }, auth("admin"));
    assert.equal(res.status, 201);
    const q = (await body(res))["data"];
    assert.equal(q.createdByUserId, undefined);
    assert.equal(q.difficultyLevel, "intermediate");
    assert.equal((await server.post("/api/v1/placements/questions", { category: "Java", questionText: "Explain GC" }, auth("student"))).status, 403);
  });
});
