import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import { DuplicateRecordError, RecordNotFoundError } from "../../repositories/repository.errors";
import { writeAuditLog } from "../admin/sqlserver-admin.repository";
import type {
  ApplicationFilter,
  ApplicationStatus,
  ApplicationStatusChange,
  CompanyFeedback,
  CompanyInput,
  CreatePlacementInput,
  HiringCompany,
  InterviewQuestion,
  InterviewRound,
  InterviewRoundInput,
  InterviewRoundUpdate,
  JobAnnouncementResult,
  JobApplication,
  JobEligibilityCriterion,
  JobOffer,
  JobOpening,
  JobStatus,
  JobUpdate,
  MockInterview,
  OfferInput,
  PlacementAnalytics,
  PlacementPackage,
  PlacementRecord,
  QuestionUpdate,
  StudentPlacementPackage,
} from "./placement.types";
import { PlacementRuleError, type Changed, type PlacementRepository } from "./placement.repository";

/** Every id in these tables is a BIGINT identity. */
const isId = (id: string | undefined | null): id is string => typeof id === "string" && /^\d{1,19}$/.test(id);

const iso = (d: Date | string | null | undefined): string | undefined => (d ? new Date(d).toISOString() : undefined);
/** DATE columns as YYYY-MM-DD. */
const dateOnly = (d: Date | string | null | undefined): string | undefined => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

const errorNumber = (err: unknown): number | undefined => {
  const e = err as { number?: number; originalError?: { info?: { number?: number } } };
  return e?.number ?? e?.originalError?.info?.number;
};

/**
 * Unique violation -> DuplicateRecordError; foreign-key violation ->
 * PlacementRuleError (a referenced row does not exist).
 */
const translate = (err: unknown, entity: string, field: string, value: string): unknown => {
  const n = errorNumber(err);
  if (n === 2627 || n === 2601) return new DuplicateRecordError(entity, field, value);
  if (n === 547) return new PlacementRuleError("REFERENCE_NOT_FOUND", "A referenced record does not exist.", 422);
  return err;
};

const COMPANY_SELECT = `
  SELECT CompanyId, CompanyName, WebsiteUrl, Industry, Description, Address, ContactName, ContactEmail, ContactMobile,
         IsActive, CreatedAt
  FROM dbo.NXA_Companies
`;

const JOB_SELECT = `
  SELECT j.JobId, j.CompanyId, c.CompanyName, j.JobTitle, j.EmploymentType,
         j.WorkLocation, j.SalaryMin, j.SalaryMax, j.MinExperienceYears,
         j.ApplicationDeadline, j.JobStatus, j.JobDescription,
         j.PublishedByUserId, j.PublishedAt, j.CreatedAt
  FROM dbo.NXA_Jobs j
  LEFT JOIN dbo.NXA_Companies c ON j.CompanyId = c.CompanyId
`;

const APPLICATION_SELECT = `
  SELECT a.JobApplicationId, a.JobId, j.JobTitle, j.CompanyId, c.CompanyName,
         a.StudentUserId, u.FullName AS StudentName,
         a.ApplicationStatus, a.ResumeObjectKey,
         a.CoverLetter, a.AppliedAt, a.UpdatedAt
  FROM dbo.NXA_JobApplications a
  JOIN dbo.NXA_Jobs j ON a.JobId = j.JobId
  LEFT JOIN dbo.NXA_Companies c ON j.CompanyId = c.CompanyId
  LEFT JOIN dbo.NXA_Users u ON a.StudentUserId = u.UserId
`;

const MOCK_SELECT = `
  SELECT m.MockInterviewId, m.StudentUserId, us.FullName AS StudentName,
         m.TeacherUserId, ut.FullName AS TeacherName,
         m.ScheduledAt, m.MeetingUrl, m.InterviewStatus,
         m.OverallScore, m.Feedback, m.CreatedAt
  FROM dbo.NXA_MockInterviews m
  LEFT JOIN dbo.NXA_Users us ON m.StudentUserId = us.UserId
  LEFT JOIN dbo.NXA_Users ut ON m.TeacherUserId = ut.UserId
`;

const PLACEMENT_SELECT = `
  SELECT p.PlacementRecordId, p.StudentUserId, u.FullName AS StudentName,
         p.CompanyId, c.CompanyName, p.JobId, j.JobTitle, p.JobApplicationId,
         p.OfferId, o.OfferedSalary, o.OfferDate,
         p.JoiningDate, p.EmploymentStatus, p.VerifiedAt, p.VerifiedByUserId
  FROM dbo.NXA_PlacementRecords p
  LEFT JOIN dbo.NXA_Users u ON p.StudentUserId = u.UserId
  LEFT JOIN dbo.NXA_Companies c ON p.CompanyId = c.CompanyId
  LEFT JOIN dbo.NXA_Jobs j ON p.JobId = j.JobId
  LEFT JOIN dbo.NXA_Offers o ON p.OfferId = o.OfferId
`;

const ROUND_SELECT = `
  SELECT InterviewRoundId, JobApplicationId, RoundNumber, RoundName, ScheduledAt, MeetingUrl, Feedback, RoundStatus
  FROM dbo.NXA_InterviewRounds
`;

const OFFER_SELECT = `
  SELECT o.OfferId, o.JobApplicationId, a.StudentUserId, u.FullName AS StudentName, j.JobTitle, c.CompanyName,
         o.OfferReference, o.OfferedSalary, o.OfferDate, o.JoiningDate, o.OfferStatus, o.OfferObjectKey, o.CreatedAt
  FROM dbo.NXA_Offers o
  JOIN dbo.NXA_JobApplications a ON a.JobApplicationId = o.JobApplicationId
  LEFT JOIN dbo.NXA_Jobs j ON j.JobId = a.JobId
  LEFT JOIN dbo.NXA_Companies c ON c.CompanyId = j.CompanyId
  LEFT JOIN dbo.NXA_Users u ON u.UserId = a.StudentUserId
`;

const FEEDBACK_SELECT = `
  SELECT f.CompanyFeedbackId, f.CompanyId, c.CompanyName, f.JobApplicationId, f.StudentUserId, u.FullName AS StudentName,
         f.FeedbackText, f.Rating, f.SubmittedAt
  FROM dbo.NXA_CompanyFeedback f
  LEFT JOIN dbo.NXA_Companies c ON c.CompanyId = f.CompanyId
  LEFT JOIN dbo.NXA_Users u ON u.UserId = f.StudentUserId
`;

const QUESTION_SELECT = `
  SELECT InterviewQuestionId, Category, QuestionText, Difficulty, SuggestedAnswer, IsActive
  FROM dbo.NXA_InterviewQuestionBank
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toCompany = (r: any): HiringCompany => ({
  id: String(r.CompanyId),
  companyName: r.CompanyName,
  websiteUrl: r.WebsiteUrl ?? undefined,
  industry: r.Industry ?? undefined,
  description: r.Description ?? undefined,
  address: r.Address ?? undefined,
  contactName: r.ContactName ?? undefined,
  contactEmail: r.ContactEmail ?? undefined,
  contactMobile: r.ContactMobile ?? undefined,
  isActive: Boolean(r.IsActive),
  hiringStatus: r.IsActive ? "active" : "inactive",
  createdAt: iso(r.CreatedAt) ?? "",
});

const toJob = (r: any): JobOpening => ({
  id: String(r.JobId),
  companyId: String(r.CompanyId),
  companyName: r.CompanyName ?? undefined,
  jobTitle: r.JobTitle,
  employmentType: r.EmploymentType ?? "full_time",
  workLocation: r.WorkLocation ?? "",
  salaryMin: r.SalaryMin != null ? Number(r.SalaryMin) : undefined,
  salaryMax: r.SalaryMax != null ? Number(r.SalaryMax) : undefined,
  minExperienceYears: r.MinExperienceYears != null ? Number(r.MinExperienceYears) : 0,
  applicationDeadline: dateOnly(r.ApplicationDeadline),
  jobStatus: String(r.JobStatus ?? "").toLowerCase() as JobOpening["jobStatus"],
  jobDescription: r.JobDescription ?? "",
  publishedByUserId: r.PublishedByUserId != null ? String(r.PublishedByUserId) : undefined,
  publishedAt: iso(r.PublishedAt),
  createdAt: iso(r.CreatedAt) ?? "",
});

const toApplication = (r: any): JobApplication => ({
  id: String(r.JobApplicationId),
  jobId: String(r.JobId),
  jobTitle: r.JobTitle ?? undefined,
  companyId: r.CompanyId != null ? String(r.CompanyId) : undefined,
  companyName: r.CompanyName ?? undefined,
  studentUserId: String(r.StudentUserId),
  studentName: r.StudentName ?? undefined,
  applicationStatus: String(r.ApplicationStatus ?? "").toLowerCase() as JobApplication["applicationStatus"],
  resumeObjectKey: r.ResumeObjectKey ?? undefined,
  coverLetter: r.CoverLetter ?? undefined,
  appliedAt: iso(r.AppliedAt) ?? "",
  updatedAt: iso(r.UpdatedAt ?? r.AppliedAt) ?? "",
});

const toMock = (r: any): MockInterview => ({
  id: String(r.MockInterviewId),
  studentUserId: String(r.StudentUserId),
  studentName: r.StudentName ?? undefined,
  teacherUserId: String(r.TeacherUserId),
  teacherName: r.TeacherName ?? undefined,
  scheduledAt: iso(r.ScheduledAt) ?? "",
  meetingUrl: r.MeetingUrl ?? undefined,
  interviewStatus: String(r.InterviewStatus ?? "").toLowerCase() as MockInterview["interviewStatus"],
  overallScore: r.OverallScore != null ? Number(r.OverallScore) : undefined,
  feedback: r.Feedback ?? undefined,
  createdAt: iso(r.CreatedAt) ?? "",
});

const toQuestion = (r: any): InterviewQuestion => ({
  id: String(r.InterviewQuestionId),
  category: r.Category,
  questionText: r.QuestionText,
  difficultyLevel: r.Difficulty ? (String(r.Difficulty).toLowerCase() as InterviewQuestion["difficultyLevel"]) : undefined,
  sampleAnswer: r.SuggestedAnswer ?? undefined,
  ...(r.IsActive === undefined ? {} : { isActive: Boolean(r.IsActive) }),
});

const toPlacement = (r: any): PlacementRecord => ({
  id: String(r.PlacementRecordId),
  studentUserId: String(r.StudentUserId),
  studentName: r.StudentName ?? undefined,
  companyId: String(r.CompanyId),
  companyName: r.CompanyName ?? undefined,
  jobId: String(r.JobId),
  jobTitle: r.JobTitle ?? undefined,
  jobApplicationId: String(r.JobApplicationId),
  offerId: r.OfferId != null ? String(r.OfferId) : undefined,
  packageOffered: r.OfferedSalary != null ? Number(r.OfferedSalary) : undefined,
  offerDate: dateOnly(r.OfferDate),
  joiningDate: dateOnly(r.JoiningDate),
  employmentStatus: r.EmploymentStatus ?? undefined,
  verificationStatus: r.VerifiedAt ? "verified" : "pending",
  verifiedAt: iso(r.VerifiedAt),
  verifiedByUserId: r.VerifiedByUserId != null ? String(r.VerifiedByUserId) : undefined,
});

const toRound = (r: any): InterviewRound => ({
  id: String(r.InterviewRoundId),
  jobApplicationId: String(r.JobApplicationId),
  roundNumber: Number(r.RoundNumber),
  roundName: r.RoundName,
  scheduledAt: iso(r.ScheduledAt),
  meetingUrl: r.MeetingUrl ?? undefined,
  feedback: r.Feedback ?? undefined,
  roundStatus: r.RoundStatus != null ? String(r.RoundStatus).toLowerCase() : undefined,
});

const toOffer = (r: any): JobOffer => ({
  id: String(r.OfferId),
  jobApplicationId: String(r.JobApplicationId),
  studentUserId: r.StudentUserId != null ? String(r.StudentUserId) : undefined,
  studentName: r.StudentName ?? undefined,
  jobTitle: r.JobTitle ?? undefined,
  companyName: r.CompanyName ?? undefined,
  offerReference: r.OfferReference,
  offeredSalary: r.OfferedSalary != null ? Number(r.OfferedSalary) : undefined,
  offerDate: dateOnly(r.OfferDate),
  joiningDate: dateOnly(r.JoiningDate),
  offerStatus: r.OfferStatus != null ? String(r.OfferStatus).toLowerCase() : undefined,
  hasLetter: Boolean(r.OfferObjectKey),
  createdAt: iso(r.CreatedAt) ?? "",
});

const toFeedback = (r: any): CompanyFeedback => ({
  id: String(r.CompanyFeedbackId),
  companyId: String(r.CompanyId),
  companyName: r.CompanyName ?? undefined,
  jobApplicationId: r.JobApplicationId != null ? String(r.JobApplicationId) : undefined,
  studentUserId: r.StudentUserId != null ? String(r.StudentUserId) : undefined,
  studentName: r.StudentName ?? undefined,
  feedbackText: r.FeedbackText,
  rating: r.Rating != null ? Number(r.Rating) : undefined,
  submittedAt: iso(r.SubmittedAt) ?? "",
});

const countsByStatus = (rows: any[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.Status ?? "").toLowerCase() || "(none)"] = Number(r.Cnt);
  return out;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Company columns and their SQL types. */
const COMPANY_COLUMNS: Array<[keyof CompanyInput, string, () => sql.ISqlType | sql.ISqlTypeFactoryWithNoParams]> = [
  ["companyName", "CompanyName", () => sql.NVarChar(200)],
  ["websiteUrl", "WebsiteUrl", () => sql.NVarChar(500)],
  ["industry", "Industry", () => sql.NVarChar(120)],
  ["description", "Description", () => sql.NVarChar(sql.MAX)],
  ["address", "Address", () => sql.NVarChar(500)],
  ["contactName", "ContactName", () => sql.NVarChar(150)],
  ["contactEmail", "ContactEmail", () => sql.NVarChar(254)],
  ["contactMobile", "ContactMobile", () => sql.VarChar(25)],
];

export class SqlServerPlacementRepository implements PlacementRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  /** Runs `work` in a transaction; rolls back and rethrows on any error. */
  private async inTransaction<T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const tx = pool.transaction();
    await tx.begin();
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // the original error is the one worth reporting
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- companies
  async getCompanies(): Promise<HiringCompany[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${COMPANY_SELECT} ORDER BY CompanyName ASC`);
    return result.recordset.map(toCompany);
  }

  async getCompanyById(id: string): Promise<HiringCompany | null> {
    if (!isId(id)) return null;
    const pool = await this.getPool();
    const result = await pool.request().input("CompanyId", sql.BigInt, id).query(`${COMPANY_SELECT} WHERE CompanyId = @CompanyId`);
    return result.recordset[0] ? toCompany(result.recordset[0]) : null;
  }

  /** Case-insensitive name clash with another company (under a range lock). */
  private async assertCompanyNameFree(tx: sql.Transaction, name: string, excludeId?: string): Promise<void> {
    const r = await tx
      .request()
      .input("Name", sql.NVarChar(200), name.trim())
      .input("Exclude", sql.BigInt, excludeId ?? null)
      .query(`
        SELECT TOP 1 CompanyId FROM dbo.NXA_Companies WITH (UPDLOCK, HOLDLOCK)
        WHERE UPPER(LTRIM(RTRIM(CompanyName))) = UPPER(@Name) AND (@Exclude IS NULL OR CompanyId <> @Exclude)
      `);
    if (r.recordset.length > 0) {
      throw new PlacementRuleError("COMPANY_NAME_EXISTS", "Another company already has this name.", 409);
    }
  }

  async createCompany(company: CompanyInput & { isActive: boolean }, actorUserId: string): Promise<HiringCompany> {
    const id = await this.inTransaction(async (tx) => {
      await this.assertCompanyNameFree(tx, company.companyName);
      const req = tx.request();
      for (const [key, col, type] of COMPANY_COLUMNS) req.input(col, type(), company[key] ?? null);
      req.input("IsActive", sql.Bit, company.isActive ? 1 : 0);
      const inserted = await req.query<{ CompanyId: number | bigint }>(`
        INSERT INTO dbo.NXA_Companies (${COMPANY_COLUMNS.map((c) => c[1]).join(", ")}, IsActive, CreatedAt)
        OUTPUT INSERTED.CompanyId
        VALUES (${COMPANY_COLUMNS.map((c) => `@${c[1]}`).join(", ")}, @IsActive, SYSUTCDATETIME())
      `);
      const newId = String(inserted.recordset[0]?.CompanyId);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "CREATE_COMPANY",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Company",
        entityId: newId,
        newValues: JSON.stringify(company),
      });
      return newId;
    });
    const created = await this.getCompanyById(id);
    if (!created) throw new RecordNotFoundError("company", id);
    return created;
  }

  async updateCompany(id: string, changes: Partial<CompanyInput>, actorUserId: string): Promise<Changed<HiringCompany>> {
    if (!isId(id)) throw new RecordNotFoundError("company", id);
    const changed = await this.inTransaction(async (tx) => {
      const cur = await tx.request().input("Id", sql.BigInt, id).query(`${COMPANY_SELECT} WITH (UPDLOCK, HOLDLOCK) WHERE CompanyId = @Id`);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("company", id);
      const before = toCompany(row);
      const diff = COMPANY_COLUMNS.filter(([key]) => changes[key] !== undefined && (changes[key] ?? null) !== (before[key] ?? null));
      if (diff.length === 0) return false;
      if (changes.companyName !== undefined && changes.companyName.trim().toUpperCase() !== before.companyName.trim().toUpperCase()) {
        await this.assertCompanyNameFree(tx, changes.companyName, id);
      }
      const upd = tx.request().input("Id", sql.BigInt, id);
      for (const [key, col, type] of diff) upd.input(col, type(), changes[key] === "" ? null : (changes[key] ?? null));
      await upd.query(`UPDATE dbo.NXA_Companies SET ${diff.map((d) => `${d[1]} = @${d[1]}`).join(", ")} WHERE CompanyId = @Id`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "UPDATE_COMPANY",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Company",
        entityId: id,
        oldValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, before[k] ?? null]))),
        newValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, changes[k] ?? null]))),
      });
      return true;
    });
    const record = await this.getCompanyById(id);
    if (!record) throw new RecordNotFoundError("company", id);
    return { record, changed };
  }

  async setCompanyActive(id: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<Changed<HiringCompany>> {
    if (!isId(id)) throw new RecordNotFoundError("company", id);
    const changed = await this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("Id", sql.BigInt, id)
        .query<{ IsActive: boolean }>(`SELECT IsActive FROM dbo.NXA_Companies WITH (UPDLOCK, HOLDLOCK) WHERE CompanyId = @Id`);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("company", id);
      if (Boolean(row.IsActive) === isActive) return false;
      await tx.request().input("Id", sql.BigInt, id).input("Active", sql.Bit, isActive).query(`UPDATE dbo.NXA_Companies SET IsActive = @Active WHERE CompanyId = @Id`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: isActive ? "ACTIVATE_COMPANY" : "DEACTIVATE_COMPANY",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Company",
        entityId: id,
        oldValues: JSON.stringify({ isActive: Boolean(row.IsActive) }),
        newValues: JSON.stringify({ isActive, ...(reason ? { reason } : {}) }),
      });
      return true;
    });
    const record = await this.getCompanyById(id);
    if (!record) throw new RecordNotFoundError("company", id);
    return { record, changed };
  }

  // --------------------------------------------------------------------- jobs
  async getJobs(filter?: { status?: string; companyId?: string }): Promise<JobOpening[]> {
    const pool = await this.getPool();
    const req = pool.request();
    let q = `${JOB_SELECT} WHERE 1=1`;
    if (filter?.status) {
      q += ` AND LOWER(j.JobStatus) = @JobStatus`;
      req.input("JobStatus", sql.VarChar(20), filter.status.toLowerCase());
    }
    if (filter?.companyId !== undefined) {
      if (!isId(filter.companyId)) return [];
      q += ` AND j.CompanyId = @CompanyId`;
      req.input("CompanyId", sql.BigInt, filter.companyId);
    }
    const result = await req.query(`${q} ORDER BY j.CreatedAt DESC`);
    return result.recordset.map(toJob);
  }

  async getJobById(id: string): Promise<JobOpening | null> {
    if (!isId(id)) return null;
    const pool = await this.getPool();
    const result = await pool.request().input("JobId", sql.BigInt, id).query(`${JOB_SELECT} WHERE j.JobId = @JobId`);
    return result.recordset[0] ? toJob(result.recordset[0]) : null;
  }

  private async assertCompanyActive(tx: sql.Transaction, companyId: string): Promise<void> {
    const company = await tx
      .request()
      .input("CompanyId", sql.BigInt, companyId)
      .query<{ IsActive: boolean }>(`SELECT IsActive FROM dbo.NXA_Companies WITH (UPDLOCK, HOLDLOCK) WHERE CompanyId = @CompanyId`);
    const row = company.recordset[0];
    if (!row) throw new RecordNotFoundError("company", companyId);
    if (!row.IsActive) throw new PlacementRuleError("COMPANY_INACTIVE", "The company is inactive; activate it before opening jobs for it.", 409);
  }

  async createJob(job: Omit<JobOpening, "id" | "createdAt">, actorUserId: string): Promise<JobOpening> {
    if (!isId(job.companyId)) throw new RecordNotFoundError("company", job.companyId);
    if (job.salaryMin != null && job.salaryMax != null && job.salaryMin > job.salaryMax) {
      throw new PlacementRuleError("SALARY_RANGE_INVALID", "The minimum salary cannot exceed the maximum.");
    }
    const id = await this.inTransaction(async (tx) => {
      await this.assertCompanyActive(tx, job.companyId);
      // PublishedAt / PublishedByUserId are stamped only when the job is opened.
      const open = job.jobStatus === "open";
      const req = tx.request();
      req.input("CompanyId", sql.BigInt, job.companyId);
      req.input("JobTitle", sql.NVarChar(200), job.jobTitle);
      req.input("EmploymentType", sql.VarChar(30), job.employmentType);
      req.input("WorkLocation", sql.NVarChar(200), job.workLocation);
      req.input("SalaryMin", sql.Decimal(12, 2), job.salaryMin ?? null);
      req.input("SalaryMax", sql.Decimal(12, 2), job.salaryMax ?? null);
      req.input("MinExperienceYears", sql.Decimal(4, 1), job.minExperienceYears);
      req.input("ApplicationDeadline", sql.Date, job.applicationDeadline ? new Date(job.applicationDeadline) : null);
      req.input("JobStatus", sql.VarChar(20), job.jobStatus);
      req.input("JobDescription", sql.NVarChar(sql.MAX), job.jobDescription);
      req.input("PublishedByUserId", sql.BigInt, open && isId(actorUserId) ? actorUserId : null);
      const inserted = await req.query<{ JobId: number | bigint }>(`
        INSERT INTO dbo.NXA_Jobs (
          CompanyId, JobTitle, EmploymentType, WorkLocation, SalaryMin, SalaryMax,
          MinExperienceYears, ApplicationDeadline, JobStatus, JobDescription,
          PublishedByUserId, PublishedAt, CreatedAt
        )
        OUTPUT INSERTED.JobId
        VALUES (
          @CompanyId, @JobTitle, @EmploymentType, @WorkLocation, @SalaryMin, @SalaryMax,
          @MinExperienceYears, @ApplicationDeadline, @JobStatus, @JobDescription,
          @PublishedByUserId, ${open ? "SYSUTCDATETIME()" : "NULL"}, SYSUTCDATETIME()
        )
      `);
      const newId = String(inserted.recordset[0]?.JobId);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "CREATE_JOB",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Job",
        entityId: newId,
        newValues: JSON.stringify({ companyId: job.companyId, jobTitle: job.jobTitle, jobStatus: job.jobStatus }),
      });
      return newId;
    });
    const created = await this.getJobById(id);
    if (!created) throw new RecordNotFoundError("job", id);
    return created;
  }

  async updateJob(id: string, changes: JobUpdate, actorUserId: string): Promise<Changed<JobOpening>> {
    if (!isId(id)) throw new RecordNotFoundError("job", id);
    const changed = await this.inTransaction(async (tx) => {
      const lock = await tx.request().input("JobId", sql.BigInt, id).query(`SELECT JobId FROM dbo.NXA_Jobs WITH (UPDLOCK, HOLDLOCK) WHERE JobId = @JobId`);
      if (!lock.recordset[0]) throw new RecordNotFoundError("job", id);
      const cur = await tx.request().input("JobId", sql.BigInt, id).query(`${JOB_SELECT} WHERE j.JobId = @JobId`);
      if (!cur.recordset[0]) throw new RecordNotFoundError("job", id);
      const before = toJob(cur.recordset[0]);
      const next = {
        salaryMin: changes.salaryMin !== undefined ? changes.salaryMin : (before.salaryMin ?? null),
        salaryMax: changes.salaryMax !== undefined ? changes.salaryMax : (before.salaryMax ?? null),
      };
      if (next.salaryMin != null && next.salaryMax != null && next.salaryMin > next.salaryMax) {
        throw new PlacementRuleError("SALARY_RANGE_INVALID", "The minimum salary cannot exceed the maximum.");
      }
      const columns: Array<[keyof JobUpdate, string, () => sql.ISqlType | sql.ISqlTypeFactoryWithNoParams, (v: unknown) => unknown]> = [
        ["jobTitle", "JobTitle", () => sql.NVarChar(200), (v) => v],
        ["employmentType", "EmploymentType", () => sql.VarChar(30), (v) => v],
        ["workLocation", "WorkLocation", () => sql.NVarChar(200), (v) => v],
        ["salaryMin", "SalaryMin", () => sql.Decimal(12, 2), (v) => v],
        ["salaryMax", "SalaryMax", () => sql.Decimal(12, 2), (v) => v],
        ["minExperienceYears", "MinExperienceYears", () => sql.Decimal(4, 1), (v) => v],
        ["applicationDeadline", "ApplicationDeadline", () => sql.Date, (v) => (v ? new Date(String(v)) : null)],
        ["jobDescription", "JobDescription", () => sql.NVarChar(sql.MAX), (v) => v],
      ];
      const diff = columns.filter(([key]) => changes[key] !== undefined && (changes[key] ?? null) !== ((before as unknown as Record<string, unknown>)[key] ?? null));
      if (diff.length === 0) return false;
      const upd = tx.request().input("JobId", sql.BigInt, id);
      for (const [key, col, type, conv] of diff) upd.input(col, type(), conv(changes[key] ?? null));
      await upd.query(`UPDATE dbo.NXA_Jobs SET ${diff.map((d) => `${d[1]} = @${d[1]}`).join(", ")} WHERE JobId = @JobId`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "UPDATE_JOB",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Job",
        entityId: id,
        oldValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, (before as unknown as Record<string, unknown>)[k] ?? null]))),
        newValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, changes[k] ?? null]))),
      });
      return true;
    });
    const record = await this.getJobById(id);
    if (!record) throw new RecordNotFoundError("job", id);
    return { record, changed };
  }

  async updateJobStatus(id: string, status: JobStatus, actorUserId: string): Promise<Changed<JobOpening>> {
    if (!isId(id)) throw new RecordNotFoundError("job", id);
    const changed = await this.inTransaction(async (tx) => {
      const cur = tx.request();
      cur.input("JobId", sql.BigInt, id);
      const before = await cur.query<{ JobStatus: string; CompanyId: number | bigint; PublishedAt: Date | null }>(
        `SELECT JobStatus, CompanyId, PublishedAt FROM dbo.NXA_Jobs WITH (UPDLOCK, HOLDLOCK) WHERE JobId = @JobId`,
      );
      const row = before.recordset[0];
      if (!row) throw new RecordNotFoundError("job", id);
      if (String(row.JobStatus ?? "").toLowerCase() === status) return false;
      if (status === "open") await this.assertCompanyActive(tx, String(row.CompanyId));

      const firstPublish = status === "open" && !row.PublishedAt;
      const upd = tx.request();
      upd.input("JobId", sql.BigInt, id);
      upd.input("JobStatus", sql.VarChar(20), status);
      upd.input("PublishedBy", sql.BigInt, firstPublish && isId(actorUserId) ? actorUserId : null);
      await upd.query(
        `UPDATE dbo.NXA_Jobs SET JobStatus = @JobStatus${firstPublish ? ", PublishedAt = SYSUTCDATETIME(), PublishedByUserId = @PublishedBy" : ""} WHERE JobId = @JobId`,
      );

      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "SET_JOB_STATUS",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Job",
        entityId: id,
        oldValues: JSON.stringify({ jobStatus: row.JobStatus }),
        newValues: JSON.stringify({ jobStatus: status }),
      });
      return true;
    });
    const record = await this.getJobById(id);
    if (!record) throw new RecordNotFoundError("job", id);
    return { record, changed };
  }

  async getJobEligibility(jobId: string): Promise<JobEligibilityCriterion[]> {
    if (!(await this.getJobById(jobId))) throw new RecordNotFoundError("job", jobId);
    const pool = await this.getPool();
    const r = await pool.request().input("JobId", sql.BigInt, jobId).query(`
      SELECT JobEligibilityCriteriaId, JobId, CriterionType, Operator, CriterionValue
      FROM dbo.NXA_JobEligibilityCriteria WHERE JobId = @JobId ORDER BY JobEligibilityCriteriaId ASC
    `);
    return r.recordset.map((x) => ({
      id: String(x.JobEligibilityCriteriaId),
      jobId: String(x.JobId),
      criterionType: x.CriterionType,
      operator: x.Operator,
      criterionValue: x.CriterionValue,
    }));
  }

  async announceJob(jobId: string, title: string, messageBody: string, actorUserId: string): Promise<JobAnnouncementResult> {
    if (!isId(jobId)) throw new RecordNotFoundError("job", jobId);
    return this.inTransaction(async (tx) => {
      const job = await tx
        .request()
        .input("JobId", sql.BigInt, jobId)
        .query<{ JobStatus: string }>(`SELECT JobStatus FROM dbo.NXA_Jobs WITH (UPDLOCK, HOLDLOCK) WHERE JobId = @JobId`);
      const row = job.recordset[0];
      if (!row) throw new RecordNotFoundError("job", jobId);
      if (String(row.JobStatus ?? "").toLowerCase() !== "open") {
        throw new PlacementRuleError("JOB_NOT_OPEN", "Only an open job can be announced.", 409);
      }
      const prior = await tx
        .request()
        .input("JobId", sql.VarChar(100), jobId)
        .query(`
          SELECT TOP 1 1 AS x FROM dbo.NXA_AuditLogs
          WHERE ActionType = 'ANNOUNCE_JOB' AND EntityName = 'Job' AND EntityId = @JobId
        `);
      if (prior.recordset.length > 0) {
        throw new PlacementRuleError("JOB_ALREADY_ANNOUNCED", "This job has already been announced.", 409);
      }
      // BR-013 / PLC-014: only students with an ACTIVE enrollment can use the placement portal.
      const ins = await tx
        .request()
        .input("JobId", sql.BigInt, jobId)
        .input("Title", sql.NVarChar(250), title)
        .input("Body", sql.NVarChar(sql.MAX), messageBody)
        .query(`
          INSERT INTO dbo.NXA_Notifications (RecipientUserId, NotificationType, Title, MessageBody, RelatedEntityId, RelatedEntityType, CreatedAt)
          SELECT u.UserId, 'placement', @Title, @Body, @JobId, 'Job', SYSUTCDATETIME()
          FROM dbo.NXA_Users u
          WHERE u.DeletedAt IS NULL
            AND EXISTS (
              SELECT 1 FROM dbo.NXA_UserRoles ur JOIN dbo.NXA_Roles r ON r.RoleId = ur.RoleId
              WHERE ur.UserId = u.UserId AND LOWER(r.RoleCode) = 'student'
            )
            AND EXISTS (
              SELECT 1 FROM dbo.NXA_Enrollments e WHERE e.StudentUserId = u.UserId AND UPPER(e.EnrollmentStatus) = 'ACTIVE'
            )
        `);
      const recipientCount = Number(ins.rowsAffected[0] ?? 0);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "ANNOUNCE_JOB",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Job",
        entityId: jobId,
        newValues: JSON.stringify({ title, recipientCount }),
      });
      return { jobId, recipientCount };
    });
  }

  // ------------------------------------------------------------- applications
  async applyForJob(app: Omit<JobApplication, "id" | "appliedAt" | "updatedAt">): Promise<JobApplication> {
    if (!isId(app.jobId)) throw new RecordNotFoundError("job", app.jobId);
    if (!isId(app.studentUserId)) throw new RecordNotFoundError("student", app.studentUserId);
    const pool = await this.getPool();
    let newId: string;
    try {
      const inserted = await pool
        .request()
        .input("JobId", sql.BigInt, app.jobId)
        .input("StudentUserId", sql.BigInt, app.studentUserId)
        .input("ApplicationStatus", sql.VarChar(25), app.applicationStatus)
        .input("ResumeObjectKey", sql.NVarChar(700), app.resumeObjectKey ?? null)
        .input("CoverLetter", sql.NVarChar(sql.MAX), app.coverLetter ?? null)
        .query<{ JobApplicationId: number | bigint }>(`
          INSERT INTO dbo.NXA_JobApplications (
            JobId, StudentUserId, ApplicationStatus, ResumeObjectKey, CoverLetter, AppliedAt, UpdatedAt
          )
          OUTPUT INSERTED.JobApplicationId
          VALUES (@JobId, @StudentUserId, @ApplicationStatus, @ResumeObjectKey, @CoverLetter, SYSUTCDATETIME(), SYSUTCDATETIME())
        `);
      newId = String(inserted.recordset[0]?.JobApplicationId);
    } catch (err) {
      throw translate(err, "job application", "jobId", app.jobId);
    }
    const created = await this.getApplicationById(newId);
    if (!created) throw new RecordNotFoundError("job application", newId);
    return created;
  }

  async getApplicationById(id: string): Promise<JobApplication | null> {
    if (!isId(id)) return null;
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("JobApplicationId", sql.BigInt, id)
      .query(`${APPLICATION_SELECT} WHERE a.JobApplicationId = @JobApplicationId`);
    return result.recordset[0] ? toApplication(result.recordset[0]) : null;
  }

  async getApplicationsByStudent(studentUserId: string): Promise<JobApplication[]> {
    if (!isId(studentUserId)) return [];
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("StudentUserId", sql.BigInt, studentUserId)
      .query(`${APPLICATION_SELECT} WHERE a.StudentUserId = @StudentUserId ORDER BY a.AppliedAt DESC`);
    return result.recordset.map(toApplication);
  }

  async getApplicationsByJob(jobId: string): Promise<JobApplication[]> {
    if (!isId(jobId)) return [];
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("JobId", sql.BigInt, jobId)
      .query(`${APPLICATION_SELECT} WHERE a.JobId = @JobId ORDER BY a.AppliedAt DESC`);
    return result.recordset.map(toApplication);
  }

  async getApplications(filter: ApplicationFilter): Promise<JobApplication[]> {
    const pool = await this.getPool();
    const req = pool.request();
    const where = ["1=1"];
    for (const [key, col] of [["jobId", "a.JobId"], ["companyId", "j.CompanyId"], ["studentUserId", "a.StudentUserId"]] as const) {
      const v = filter[key];
      if (v === undefined) continue;
      if (!isId(v)) return [];
      req.input(key, sql.BigInt, v);
      where.push(`${col} = @${key}`);
    }
    if (filter.status) {
      req.input("status", sql.VarChar(25), filter.status);
      where.push("LOWER(a.ApplicationStatus) = @status");
    }
    const result = await req.query(`${APPLICATION_SELECT} WHERE ${where.join(" AND ")} ORDER BY a.AppliedAt DESC, a.JobApplicationId DESC`);
    return result.recordset.map(toApplication);
  }

  async getApplicationHistory(applicationId: string): Promise<ApplicationStatusChange[]> {
    if (!(await this.getApplicationById(applicationId))) throw new RecordNotFoundError("job application", applicationId);
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, applicationId).query(`
      SELECT h.JobApplicationStatusHistoryId, h.JobApplicationId, h.PreviousStatus, h.NewStatus, h.ChangeReason,
             h.ChangedByUserId, u.FullName AS ChangedByName, h.ChangedAt
      FROM dbo.NXA_JobApplicationStatusHistory h
      LEFT JOIN dbo.NXA_Users u ON u.UserId = h.ChangedByUserId
      WHERE h.JobApplicationId = @Id
      ORDER BY h.ChangedAt DESC, h.JobApplicationStatusHistoryId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.JobApplicationStatusHistoryId),
      jobApplicationId: String(x.JobApplicationId),
      previousStatus: x.PreviousStatus != null ? String(x.PreviousStatus).toLowerCase() : undefined,
      newStatus: String(x.NewStatus).toLowerCase(),
      changeReason: x.ChangeReason ?? undefined,
      changedByUserId: x.ChangedByUserId != null ? String(x.ChangedByUserId) : undefined,
      changedByName: x.ChangedByName ?? undefined,
      changedAt: iso(x.ChangedAt) ?? "",
    }));
  }

  async updateApplicationStatus(
    applicationId: string,
    status: ApplicationStatus,
    changedByUserId: string,
    reason?: string | undefined,
  ): Promise<JobApplication> {
    if (!isId(applicationId)) throw new RecordNotFoundError("job application", applicationId);
    await this.inTransaction(async (tx) => {
      const cur = tx.request();
      cur.input("Id", sql.BigInt, applicationId);
      const before = await cur.query<{ ApplicationStatus: string }>(
        `SELECT ApplicationStatus FROM dbo.NXA_JobApplications WITH (UPDLOCK, HOLDLOCK) WHERE JobApplicationId = @Id`,
      );
      const row = before.recordset[0];
      if (!row) throw new RecordNotFoundError("job application", applicationId);
      const previous = row.ApplicationStatus ?? null;
      if ((previous ?? "").toLowerCase() === status) return; // unchanged: nothing to record

      const upd = tx.request();
      upd.input("Id", sql.BigInt, applicationId);
      upd.input("Status", sql.VarChar(25), status);
      await upd.query(
        `UPDATE dbo.NXA_JobApplications SET ApplicationStatus = @Status, UpdatedAt = SYSUTCDATETIME() WHERE JobApplicationId = @Id`,
      );

      const hist = tx.request();
      hist.input("Id", sql.BigInt, applicationId);
      hist.input("Previous", sql.VarChar(30), previous);
      hist.input("Next", sql.VarChar(30), status);
      hist.input("ChangedBy", sql.BigInt, isId(changedByUserId) ? changedByUserId : null);
      hist.input("Reason", sql.NVarChar(500), reason ?? null);
      await hist.query(`
        INSERT INTO dbo.NXA_JobApplicationStatusHistory (JobApplicationId, PreviousStatus, NewStatus, ChangedByUserId, ChangeReason, ChangedAt)
        VALUES (@Id, @Previous, @Next, @ChangedBy, @Reason, SYSUTCDATETIME())
      `);

      await writeAuditLog(tx.request(), {
        actorUserId: changedByUserId,
        actionType: "SET_APPLICATION_STATUS",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "JobApplication",
        entityId: applicationId,
        oldValues: JSON.stringify({ applicationStatus: previous }),
        newValues: JSON.stringify({ applicationStatus: status, ...(reason ? { reason } : {}) }),
      });
    });
    const updated = await this.getApplicationById(applicationId);
    if (!updated) throw new RecordNotFoundError("job application", applicationId);
    return updated;
  }

  // ----------------------------------------------------------- interview rounds
  async getInterviewRounds(applicationId: string): Promise<InterviewRound[]> {
    if (!(await this.getApplicationById(applicationId))) throw new RecordNotFoundError("job application", applicationId);
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, applicationId).query(`${ROUND_SELECT} WHERE JobApplicationId = @Id ORDER BY RoundNumber ASC`);
    return r.recordset.map(toRound);
  }

  async createInterviewRound(applicationId: string, input: InterviewRoundInput, actorUserId: string): Promise<InterviewRound> {
    if (!isId(applicationId)) throw new RecordNotFoundError("job application", applicationId);
    const id = await this.inTransaction(async (tx) => {
      const app = await tx.request().input("Id", sql.BigInt, applicationId).query(`SELECT JobApplicationId FROM dbo.NXA_JobApplications WHERE JobApplicationId = @Id`);
      if (app.recordset.length === 0) throw new RecordNotFoundError("job application", applicationId);
      const existing = await tx
        .request()
        .input("Id", sql.BigInt, applicationId)
        .query<{ RoundNumber: number }>(`SELECT RoundNumber FROM dbo.NXA_InterviewRounds WITH (UPDLOCK, HOLDLOCK) WHERE JobApplicationId = @Id`);
      const numbers = existing.recordset.map((x) => Number(x.RoundNumber));
      const roundNumber = input.roundNumber ?? (numbers.length ? Math.max(...numbers) + 1 : 1);
      if (numbers.includes(roundNumber)) {
        throw new PlacementRuleError("ROUND_NUMBER_EXISTS", `Round ${roundNumber} already exists for this application.`, 409);
      }
      let newId: string;
      try {
        // RoundStatus is omitted: its table default applies (allowed values are not visible).
        const ins = await tx
          .request()
          .input("Id", sql.BigInt, applicationId)
          .input("Number", sql.Int, roundNumber)
          .input("Name", sql.NVarChar(150), input.roundName)
          .input("ScheduledAt", sql.DateTime2, input.scheduledAt ? new Date(input.scheduledAt) : null)
          .input("MeetingUrl", sql.NVarChar(1000), input.meetingUrl ?? null)
          .query<{ InterviewRoundId: number | bigint }>(`
            INSERT INTO dbo.NXA_InterviewRounds (JobApplicationId, RoundNumber, RoundName, ScheduledAt, MeetingUrl)
            OUTPUT INSERTED.InterviewRoundId
            VALUES (@Id, @Number, @Name, @ScheduledAt, @MeetingUrl)
          `);
        newId = String(ins.recordset[0]?.InterviewRoundId);
      } catch (err) {
        throw translate(err, "interview round", "roundNumber", String(roundNumber));
      }
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "CREATE_INTERVIEW_ROUND",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "InterviewRound",
        entityId: newId,
        newValues: JSON.stringify({ jobApplicationId: applicationId, roundNumber, roundName: input.roundName, scheduledAt: input.scheduledAt ?? null }),
      });
      return newId;
    });
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, id).query(`${ROUND_SELECT} WHERE InterviewRoundId = @Id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("interview round", id);
    return toRound(r.recordset[0]);
  }

  async updateInterviewRound(roundId: string, changes: InterviewRoundUpdate, actorUserId: string): Promise<Changed<InterviewRound>> {
    if (!isId(roundId)) throw new RecordNotFoundError("interview round", roundId);
    const changed = await this.inTransaction(async (tx) => {
      const cur = await tx.request().input("Id", sql.BigInt, roundId).query(`${ROUND_SELECT} WITH (UPDLOCK, HOLDLOCK) WHERE InterviewRoundId = @Id`);
      if (!cur.recordset[0]) throw new RecordNotFoundError("interview round", roundId);
      const before = toRound(cur.recordset[0]);
      const norm = (k: keyof InterviewRoundUpdate, v: unknown) => (k === "scheduledAt" && v ? new Date(String(v)).toISOString() : (v ?? null));
      const cols: Array<[keyof InterviewRoundUpdate, string, () => sql.ISqlType | sql.ISqlTypeFactoryWithNoParams]> = [
        ["roundName", "RoundName", () => sql.NVarChar(150)],
        ["scheduledAt", "ScheduledAt", () => sql.DateTime2],
        ["meetingUrl", "MeetingUrl", () => sql.NVarChar(1000)],
        ["feedback", "Feedback", () => sql.NVarChar(sql.MAX)],
      ];
      const diff = cols.filter(([k]) => changes[k] !== undefined && norm(k, changes[k]) !== norm(k, before[k]));
      if (diff.length === 0) return false;
      const upd = tx.request().input("Id", sql.BigInt, roundId);
      for (const [k, col, type] of diff) upd.input(col, type(), k === "scheduledAt" && changes[k] ? new Date(String(changes[k])) : (changes[k] ?? null));
      await upd.query(`UPDATE dbo.NXA_InterviewRounds SET ${diff.map((d) => `${d[1]} = @${d[1]}`).join(", ")} WHERE InterviewRoundId = @Id`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "UPDATE_INTERVIEW_ROUND",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "InterviewRound",
        entityId: roundId,
        oldValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, before[k] ?? null]))),
        newValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, changes[k] ?? null]))),
      });
      return true;
    });
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, roundId).query(`${ROUND_SELECT} WHERE InterviewRoundId = @Id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("interview round", roundId);
    return { record: toRound(r.recordset[0]), changed };
  }

  // ------------------------------------------------------------------- offers
  async getOffers(filter: { jobApplicationId?: string | undefined }): Promise<JobOffer[]> {
    const pool = await this.getPool();
    const req = pool.request();
    let where = "1=1";
    if (filter.jobApplicationId !== undefined) {
      if (!isId(filter.jobApplicationId)) return [];
      req.input("AppId", sql.BigInt, filter.jobApplicationId);
      where = "o.JobApplicationId = @AppId";
    }
    const r = await req.query(`${OFFER_SELECT} WHERE ${where} ORDER BY o.CreatedAt DESC, o.OfferId DESC`);
    return r.recordset.map(toOffer);
  }

  async createOffer(applicationId: string, input: OfferInput, actorUserId: string): Promise<JobOffer> {
    if (!isId(applicationId)) throw new RecordNotFoundError("job application", applicationId);
    const id = await this.inTransaction(async (tx) => {
      const app = await tx.request().input("Id", sql.BigInt, applicationId).query(`SELECT JobApplicationId FROM dbo.NXA_JobApplications WHERE JobApplicationId = @Id`);
      if (app.recordset.length === 0) throw new RecordNotFoundError("job application", applicationId);
      const dup = await tx
        .request()
        .input("Ref", sql.VarChar(60), input.offerReference)
        .query(`SELECT TOP 1 1 AS x FROM dbo.NXA_Offers WITH (UPDLOCK, HOLDLOCK) WHERE UPPER(OfferReference) = UPPER(@Ref)`);
      if (dup.recordset.length > 0) throw new PlacementRuleError("OFFER_REFERENCE_EXISTS", "An offer with this reference already exists.", 409);
      let newId: string;
      try {
        // OfferStatus is omitted: its table default applies. OfferObjectKey needs file storage (absent).
        const ins = await tx
          .request()
          .input("Id", sql.BigInt, applicationId)
          .input("Ref", sql.VarChar(60), input.offerReference)
          .input("Salary", sql.Decimal(12, 2), input.offeredSalary ?? null)
          .input("OfferDate", sql.Date, input.offerDate ? new Date(input.offerDate) : null)
          .input("JoiningDate", sql.Date, input.joiningDate ? new Date(input.joiningDate) : null)
          .query<{ OfferId: number | bigint }>(`
            INSERT INTO dbo.NXA_Offers (JobApplicationId, OfferReference, OfferedSalary, OfferDate, JoiningDate, CreatedAt)
            OUTPUT INSERTED.OfferId
            VALUES (@Id, @Ref, @Salary, @OfferDate, @JoiningDate, SYSUTCDATETIME())
          `);
        newId = String(ins.recordset[0]?.OfferId);
      } catch (err) {
        throw translate(err, "offer", "offerReference", input.offerReference);
      }
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "CREATE_OFFER",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "Offer",
        entityId: newId,
        newValues: JSON.stringify({ jobApplicationId: applicationId, ...input }),
      });
      return newId;
    });
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, id).query(`${OFFER_SELECT} WHERE o.OfferId = @Id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("offer", id);
    return toOffer(r.recordset[0]);
  }

  // ----------------------------------------------------------- mock interviews
  async getMockInterviewsByStudent(studentUserId: string): Promise<MockInterview[]> {
    if (!isId(studentUserId)) return [];
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("StudentUserId", sql.BigInt, studentUserId)
      .query(`${MOCK_SELECT} WHERE m.StudentUserId = @StudentUserId ORDER BY m.ScheduledAt DESC`);
    return result.recordset.map(toMock);
  }

  async getMockInterviewsByTeacher(teacherUserId: string): Promise<MockInterview[]> {
    if (!isId(teacherUserId)) return [];
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("TeacherUserId", sql.BigInt, teacherUserId)
      .query(`${MOCK_SELECT} WHERE m.TeacherUserId = @TeacherUserId ORDER BY m.ScheduledAt DESC`);
    return result.recordset.map(toMock);
  }

  async getAllMockInterviews(): Promise<MockInterview[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${MOCK_SELECT} ORDER BY m.ScheduledAt DESC`);
    return result.recordset.map(toMock);
  }

  async getMockInterviewById(id: string): Promise<MockInterview | null> {
    if (!isId(id)) return null;
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("MockInterviewId", sql.BigInt, id)
      .query(`${MOCK_SELECT} WHERE m.MockInterviewId = @MockInterviewId`);
    return result.recordset[0] ? toMock(result.recordset[0]) : null;
  }

  async scheduleMockInterview(interview: Omit<MockInterview, "id" | "createdAt">, actorUserId?: string | undefined): Promise<MockInterview> {
    if (!isId(interview.studentUserId)) throw new RecordNotFoundError("student", interview.studentUserId);
    if (!isId(interview.teacherUserId)) throw new RecordNotFoundError("teacher", interview.teacherUserId);
    const newId = await this.inTransaction(async (tx) => {
      let id: string;
      try {
        const inserted = await tx
          .request()
          .input("StudentUserId", sql.BigInt, interview.studentUserId)
          .input("TeacherUserId", sql.BigInt, interview.teacherUserId)
          .input("ScheduledAt", sql.DateTime2, new Date(interview.scheduledAt))
          .input("MeetingUrl", sql.NVarChar(1000), interview.meetingUrl ?? null)
          .input("InterviewStatus", sql.VarChar(20), interview.interviewStatus)
          .input("OverallScore", sql.Decimal(5, 2), interview.overallScore ?? null)
          .input("Feedback", sql.NVarChar(sql.MAX), interview.feedback ?? null)
          .query<{ MockInterviewId: number | bigint }>(`
            INSERT INTO dbo.NXA_MockInterviews (
              StudentUserId, TeacherUserId, ScheduledAt, MeetingUrl, InterviewStatus, OverallScore, Feedback, CreatedAt
            )
            OUTPUT INSERTED.MockInterviewId
            VALUES (@StudentUserId, @TeacherUserId, @ScheduledAt, @MeetingUrl, @InterviewStatus, @OverallScore, @Feedback, SYSUTCDATETIME())
          `);
        id = String(inserted.recordset[0]?.MockInterviewId);
      } catch (err) {
        throw translate(err, "mock interview", "studentUserId", interview.studentUserId);
      }
      if (isId(actorUserId)) {
        await writeAuditLog(tx.request(), {
          actorUserId,
          actionType: "SCHEDULE_MOCK_INTERVIEW",
          moduleCode: "PLACEMENT_MGMT",
          entityName: "MockInterview",
          entityId: id,
          newValues: JSON.stringify({ studentUserId: interview.studentUserId, teacherUserId: interview.teacherUserId, scheduledAt: interview.scheduledAt }),
        });
      }
      return id;
    });
    const created = await this.getMockInterviewById(newId);
    if (!created) throw new RecordNotFoundError("mock interview", newId);
    return created;
  }

  async evaluateMockInterview(
    id: string,
    score: number,
    feedback: string,
    status: "completed" | "cancelled",
    actorUserId?: string | undefined,
  ): Promise<MockInterview> {
    if (!isId(id)) throw new RecordNotFoundError("mock interview", id);
    await this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("Id", sql.BigInt, id)
        .query<{ InterviewStatus: string }>(`SELECT InterviewStatus FROM dbo.NXA_MockInterviews WITH (UPDLOCK, HOLDLOCK) WHERE MockInterviewId = @Id`);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("mock interview", id);
      const current = String(row.InterviewStatus ?? "").toLowerCase();
      if (current !== "scheduled") {
        throw new PlacementRuleError("MOCK_INTERVIEW_FINALIZED", `This mock interview is already ${current}; its result cannot be overwritten.`, 409);
      }
      await tx
        .request()
        .input("MockInterviewId", sql.BigInt, id)
        .input("OverallScore", sql.Decimal(5, 2), score)
        .input("Feedback", sql.NVarChar(sql.MAX), feedback)
        .input("InterviewStatus", sql.VarChar(20), status)
        .query(`
          UPDATE dbo.NXA_MockInterviews
          SET OverallScore = @OverallScore, Feedback = @Feedback, InterviewStatus = @InterviewStatus
          WHERE MockInterviewId = @MockInterviewId
        `);
      if (isId(actorUserId)) {
        await writeAuditLog(tx.request(), {
          actorUserId,
          actionType: status === "completed" ? "EVALUATE_MOCK_INTERVIEW" : "CANCEL_MOCK_INTERVIEW",
          moduleCode: "PLACEMENT_MGMT",
          entityName: "MockInterview",
          entityId: id,
          oldValues: JSON.stringify({ interviewStatus: current }),
          newValues: JSON.stringify({ interviewStatus: status, overallScore: score }),
        });
      }
    });
    const updated = await this.getMockInterviewById(id);
    if (!updated) throw new RecordNotFoundError("mock interview", id);
    return updated;
  }

  // ------------------------------------------------------------ question bank
  async getQuestions(category?: string, includeInactive = false): Promise<InterviewQuestion[]> {
    const pool = await this.getPool();
    const req = pool.request();
    let q = `${QUESTION_SELECT} WHERE ${includeInactive ? "1=1" : "IsActive = 1"}`;
    if (category) {
      q += ` AND Category = @Category`;
      req.input("Category", sql.NVarChar(100), category);
    }
    const result = await req.query(`${q} ORDER BY Category ASC, InterviewQuestionId ASC`);
    return result.recordset.map(toQuestion);
  }

  private async getQuestionById(id: string): Promise<InterviewQuestion | null> {
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, id).query(`${QUESTION_SELECT} WHERE InterviewQuestionId = @Id`);
    return r.recordset[0] ? toQuestion(r.recordset[0]) : null;
  }

  async addQuestion(q: Omit<InterviewQuestion, "id" | "isActive">, actorUserId?: string | undefined): Promise<InterviewQuestion> {
    const id = await this.inTransaction(async (tx) => {
      const inserted = await tx
        .request()
        .input("Category", sql.NVarChar(100), q.category)
        .input("QuestionText", sql.NVarChar(sql.MAX), q.questionText)
        .input("Difficulty", sql.VarChar(20), q.difficultyLevel ?? null)
        .input("SuggestedAnswer", sql.NVarChar(sql.MAX), q.sampleAnswer ?? null)
        .query<{ InterviewQuestionId: number | bigint }>(`
          INSERT INTO dbo.NXA_InterviewQuestionBank (Category, QuestionText, Difficulty, SuggestedAnswer, IsActive, CreatedAt)
          OUTPUT INSERTED.InterviewQuestionId
          VALUES (@Category, @QuestionText, @Difficulty, @SuggestedAnswer, 1, SYSUTCDATETIME())
        `);
      const newId = String(inserted.recordset[0]?.InterviewQuestionId);
      if (isId(actorUserId)) {
        await writeAuditLog(tx.request(), {
          actorUserId,
          actionType: "CREATE_INTERVIEW_QUESTION",
          moduleCode: "PLACEMENT_MGMT",
          entityName: "InterviewQuestion",
          entityId: newId,
          newValues: JSON.stringify({ category: q.category, difficultyLevel: q.difficultyLevel ?? null }),
        });
      }
      return newId;
    });
    return {
      id,
      category: q.category,
      questionText: q.questionText,
      difficultyLevel: q.difficultyLevel,
      sampleAnswer: q.sampleAnswer,
      isActive: true,
    };
  }

  async updateQuestion(id: string, changes: QuestionUpdate, actorUserId: string): Promise<Changed<InterviewQuestion>> {
    if (!isId(id)) throw new RecordNotFoundError("interview question", id);
    const changed = await this.inTransaction(async (tx) => {
      const cur = await tx.request().input("Id", sql.BigInt, id).query(`${QUESTION_SELECT} WITH (UPDLOCK, HOLDLOCK) WHERE InterviewQuestionId = @Id`);
      if (!cur.recordset[0]) throw new RecordNotFoundError("interview question", id);
      const before = toQuestion(cur.recordset[0]);
      const cols: Array<[keyof QuestionUpdate, string, () => sql.ISqlType | sql.ISqlTypeFactoryWithNoParams]> = [
        ["category", "Category", () => sql.NVarChar(100)],
        ["questionText", "QuestionText", () => sql.NVarChar(sql.MAX)],
        ["difficultyLevel", "Difficulty", () => sql.VarChar(20)],
        ["sampleAnswer", "SuggestedAnswer", () => sql.NVarChar(sql.MAX)],
      ];
      const diff = cols.filter(([k]) => changes[k] !== undefined && (changes[k] ?? null) !== (before[k] ?? null));
      if (diff.length === 0) return false;
      const upd = tx.request().input("Id", sql.BigInt, id);
      for (const [k, col, type] of diff) upd.input(col, type(), changes[k] ?? null);
      await upd.query(`UPDATE dbo.NXA_InterviewQuestionBank SET ${diff.map((d) => `${d[1]} = @${d[1]}`).join(", ")} WHERE InterviewQuestionId = @Id`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "UPDATE_INTERVIEW_QUESTION",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "InterviewQuestion",
        entityId: id,
        oldValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, before[k] ?? null]))),
        newValues: JSON.stringify(Object.fromEntries(diff.map(([k]) => [k, changes[k] ?? null]))),
      });
      return true;
    });
    const record = await this.getQuestionById(id);
    if (!record) throw new RecordNotFoundError("interview question", id);
    return { record, changed };
  }

  async setQuestionActive(id: string, isActive: boolean, actorUserId: string): Promise<Changed<InterviewQuestion>> {
    if (!isId(id)) throw new RecordNotFoundError("interview question", id);
    const changed = await this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("Id", sql.BigInt, id)
        .query<{ IsActive: boolean }>(`SELECT IsActive FROM dbo.NXA_InterviewQuestionBank WITH (UPDLOCK, HOLDLOCK) WHERE InterviewQuestionId = @Id`);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("interview question", id);
      if (Boolean(row.IsActive) === isActive) return false;
      await tx.request().input("Id", sql.BigInt, id).input("Active", sql.Bit, isActive).query(`UPDATE dbo.NXA_InterviewQuestionBank SET IsActive = @Active WHERE InterviewQuestionId = @Id`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: isActive ? "ACTIVATE_INTERVIEW_QUESTION" : "DEACTIVATE_INTERVIEW_QUESTION",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "InterviewQuestion",
        entityId: id,
        oldValues: JSON.stringify({ isActive: Boolean(row.IsActive) }),
        newValues: JSON.stringify({ isActive }),
      });
      return true;
    });
    const record = await this.getQuestionById(id);
    if (!record) throw new RecordNotFoundError("interview question", id);
    return { record, changed };
  }

  // -------------------------------------------------------- placement records
  async getPlacements(): Promise<PlacementRecord[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(`${PLACEMENT_SELECT} ORDER BY p.PlacementRecordId DESC`);
    return result.recordset.map(toPlacement);
  }

  private async getPlacementById(id: string): Promise<PlacementRecord | null> {
    const pool = await this.getPool();
    const result = await pool.request().input("Id", sql.BigInt, id).query(`${PLACEMENT_SELECT} WHERE p.PlacementRecordId = @Id`);
    return result.recordset[0] ? toPlacement(result.recordset[0]) : null;
  }

  async createPlacement(input: CreatePlacementInput, actorUserId: string): Promise<PlacementRecord> {
    if (!isId(input.jobApplicationId)) throw new RecordNotFoundError("job application", input.jobApplicationId);
    if (input.offerId !== undefined && !isId(input.offerId)) throw new RecordNotFoundError("offer", input.offerId);

    const id = await this.inTransaction(async (tx) => {
      // Student, job and company come from the application, never the client.
      const a = tx.request();
      a.input("AppId", sql.BigInt, input.jobApplicationId);
      const app = await a.query<{ StudentUserId: number | bigint; JobId: number | bigint; CompanyId: number | bigint }>(`
        SELECT a.StudentUserId, a.JobId, j.CompanyId
        FROM dbo.NXA_JobApplications a
        JOIN dbo.NXA_Jobs j ON j.JobId = a.JobId
        WHERE a.JobApplicationId = @AppId
      `);
      const appRow = app.recordset[0];
      if (!appRow) throw new RecordNotFoundError("job application", input.jobApplicationId);

      if (input.offerId !== undefined) {
        const o = tx.request();
        o.input("OfferId", sql.BigInt, input.offerId);
        const offer = await o.query<{ JobApplicationId: number | bigint }>(
          `SELECT JobApplicationId FROM dbo.NXA_Offers WHERE OfferId = @OfferId`,
        );
        const offerRow = offer.recordset[0];
        if (!offerRow) throw new RecordNotFoundError("offer", input.offerId);
        if (String(offerRow.JobApplicationId) !== input.jobApplicationId) {
          throw new PlacementRuleError("OFFER_APPLICATION_MISMATCH", "The offer does not belong to this job application.");
        }
      }

      // One placement record per application (checked under a range lock).
      const d = tx.request();
      d.input("AppId", sql.BigInt, input.jobApplicationId);
      const dup = await d.query(
        `SELECT TOP 1 1 AS x FROM dbo.NXA_PlacementRecords WITH (UPDLOCK, HOLDLOCK) WHERE JobApplicationId = @AppId`,
      );
      if (dup.recordset.length > 0) throw new DuplicateRecordError("placement record", "jobApplicationId", input.jobApplicationId);

      const verified = input.verificationStatus === "verified";
      const ins = tx.request();
      ins.input("StudentUserId", sql.BigInt, appRow.StudentUserId);
      ins.input("CompanyId", sql.BigInt, appRow.CompanyId);
      ins.input("JobId", sql.BigInt, appRow.JobId);
      ins.input("AppId", sql.BigInt, input.jobApplicationId);
      ins.input("OfferId", sql.BigInt, input.offerId ?? null);
      ins.input("JoiningDate", sql.Date, input.joiningDate ? new Date(input.joiningDate) : null);
      ins.input("VerifiedBy", sql.BigInt, verified && isId(actorUserId) ? actorUserId : null);
      // EmploymentStatus is omitted: its table default applies (allowed values are not visible).
      const inserted = await ins.query<{ PlacementRecordId: number | bigint }>(`
        INSERT INTO dbo.NXA_PlacementRecords (
          StudentUserId, CompanyId, JobId, JobApplicationId, OfferId, JoiningDate, VerifiedAt, VerifiedByUserId
        )
        OUTPUT INSERTED.PlacementRecordId
        VALUES (
          @StudentUserId, @CompanyId, @JobId, @AppId, @OfferId, @JoiningDate,
          ${verified ? "SYSUTCDATETIME()" : "NULL"}, @VerifiedBy
        )
      `);
      const newId = String(inserted.recordset[0]?.PlacementRecordId);

      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "CREATE_PLACEMENT_RECORD",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "PlacementRecord",
        entityId: newId,
        newValues: JSON.stringify({
          jobApplicationId: input.jobApplicationId,
          studentUserId: String(appRow.StudentUserId),
          jobId: String(appRow.JobId),
          companyId: String(appRow.CompanyId),
          offerId: input.offerId ?? null,
          joiningDate: input.joiningDate ?? null,
          verificationStatus: input.verificationStatus,
        }),
      });
      return newId;
    });

    const created = await this.getPlacementById(id);
    if (!created) throw new RecordNotFoundError("placement record", id);
    return created;
  }

  async verifyPlacement(id: string, actorUserId: string): Promise<PlacementRecord> {
    if (!isId(id)) throw new RecordNotFoundError("placement record", id);
    await this.inTransaction(async (tx) => {
      const cur = await tx
        .request()
        .input("Id", sql.BigInt, id)
        .query<{ VerifiedAt: Date | null }>(`SELECT VerifiedAt FROM dbo.NXA_PlacementRecords WITH (UPDLOCK, HOLDLOCK) WHERE PlacementRecordId = @Id`);
      const row = cur.recordset[0];
      if (!row) throw new RecordNotFoundError("placement record", id);
      if (row.VerifiedAt) throw new PlacementRuleError("PLACEMENT_ALREADY_VERIFIED", "This placement record is already verified.", 409);
      await tx
        .request()
        .input("Id", sql.BigInt, id)
        .input("By", sql.BigInt, actorUserId)
        .query(`UPDATE dbo.NXA_PlacementRecords SET VerifiedAt = SYSUTCDATETIME(), VerifiedByUserId = @By WHERE PlacementRecordId = @Id AND VerifiedAt IS NULL`);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "VERIFY_PLACEMENT_RECORD",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "PlacementRecord",
        entityId: id,
        oldValues: JSON.stringify({ verificationStatus: "pending" }),
        newValues: JSON.stringify({ verificationStatus: "verified" }),
      });
    });
    const record = await this.getPlacementById(id);
    if (!record) throw new RecordNotFoundError("placement record", id);
    return record;
  }

  // --------------------------------------------------------- employer feedback
  async getCompanyFeedback(filter: { companyId?: string | undefined }): Promise<CompanyFeedback[]> {
    const pool = await this.getPool();
    const req = pool.request();
    let where = "1=1";
    if (filter.companyId !== undefined) {
      if (!isId(filter.companyId)) return [];
      req.input("CompanyId", sql.BigInt, filter.companyId);
      where = "f.CompanyId = @CompanyId";
    }
    const r = await req.query(`${FEEDBACK_SELECT} WHERE ${where} ORDER BY f.SubmittedAt DESC, f.CompanyFeedbackId DESC`);
    return r.recordset.map(toFeedback);
  }

  async createCompanyFeedback(
    companyId: string,
    input: { feedbackText: string; jobApplicationId?: string | undefined },
    actorUserId: string,
  ): Promise<CompanyFeedback> {
    if (!isId(companyId)) throw new RecordNotFoundError("company", companyId);
    if (input.jobApplicationId !== undefined && !isId(input.jobApplicationId)) throw new RecordNotFoundError("job application", input.jobApplicationId);
    const id = await this.inTransaction(async (tx) => {
      const c = await tx.request().input("Id", sql.BigInt, companyId).query(`SELECT CompanyId FROM dbo.NXA_Companies WHERE CompanyId = @Id`);
      if (c.recordset.length === 0) throw new RecordNotFoundError("company", companyId);
      let studentUserId: string | null = null;
      if (input.jobApplicationId !== undefined) {
        const a = await tx
          .request()
          .input("AppId", sql.BigInt, input.jobApplicationId)
          .query<{ StudentUserId: number | bigint; CompanyId: number | bigint }>(`
            SELECT a.StudentUserId, j.CompanyId FROM dbo.NXA_JobApplications a JOIN dbo.NXA_Jobs j ON j.JobId = a.JobId
            WHERE a.JobApplicationId = @AppId
          `);
        const row = a.recordset[0];
        if (!row) throw new RecordNotFoundError("job application", input.jobApplicationId);
        if (String(row.CompanyId) !== companyId) {
          throw new PlacementRuleError("APPLICATION_COMPANY_MISMATCH", "The application is not for a job of this company.");
        }
        studentUserId = String(row.StudentUserId);
      }
      // Rating is not written: the rating scale has not been approved.
      const ins = await tx
        .request()
        .input("CompanyId", sql.BigInt, companyId)
        .input("AppId", sql.BigInt, input.jobApplicationId ?? null)
        .input("StudentId", sql.BigInt, studentUserId)
        .input("Text", sql.NVarChar(sql.MAX), input.feedbackText)
        .query<{ CompanyFeedbackId: number | bigint }>(`
          INSERT INTO dbo.NXA_CompanyFeedback (CompanyId, JobApplicationId, StudentUserId, FeedbackText, SubmittedAt)
          OUTPUT INSERTED.CompanyFeedbackId
          VALUES (@CompanyId, @AppId, @StudentId, @Text, SYSUTCDATETIME())
        `);
      const newId = String(ins.recordset[0]?.CompanyFeedbackId);
      await writeAuditLog(tx.request(), {
        actorUserId,
        actionType: "RECORD_EMPLOYER_FEEDBACK",
        moduleCode: "PLACEMENT_MGMT",
        entityName: "CompanyFeedback",
        entityId: newId,
        newValues: JSON.stringify({ companyId, jobApplicationId: input.jobApplicationId ?? null }),
      });
      return newId;
    });
    const pool = await this.getPool();
    const r = await pool.request().input("Id", sql.BigInt, id).query(`${FEEDBACK_SELECT} WHERE f.CompanyFeedbackId = @Id`);
    if (!r.recordset[0]) throw new RecordNotFoundError("company feedback", id);
    return toFeedback(r.recordset[0]);
  }

  // ---------------------------------------------------- analytics and packages
  async getPlacementAnalytics(): Promise<PlacementAnalytics> {
    const pool = await this.getPool();
    const r = await pool.request().query(`
      SELECT COUNT(1) AS Total, SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END) AS Active FROM dbo.NXA_Companies;
      SELECT LOWER(JobStatus) AS Status, COUNT(1) AS Cnt FROM dbo.NXA_Jobs GROUP BY LOWER(JobStatus);
      SELECT LOWER(ApplicationStatus) AS Status, COUNT(1) AS Cnt FROM dbo.NXA_JobApplications GROUP BY LOWER(ApplicationStatus);
      SELECT COUNT(1) AS Total FROM dbo.NXA_InterviewRounds;
      SELECT COUNT(1) AS Total, AVG(OfferedSalary) AS AvgSalary, MAX(OfferedSalary) AS MaxSalary FROM dbo.NXA_Offers;
      SELECT COUNT(1) AS Total, SUM(CASE WHEN VerifiedAt IS NOT NULL THEN 1 ELSE 0 END) AS Verified FROM dbo.NXA_PlacementRecords;
      SELECT LOWER(InterviewStatus) AS Status, COUNT(1) AS Cnt, AVG(OverallScore) AS AvgScore FROM dbo.NXA_MockInterviews GROUP BY LOWER(InterviewStatus);
      SELECT p.CompanyId, c.CompanyName, COUNT(1) AS Placements
      FROM dbo.NXA_PlacementRecords p LEFT JOIN dbo.NXA_Companies c ON c.CompanyId = p.CompanyId
      GROUP BY p.CompanyId, c.CompanyName ORDER BY COUNT(1) DESC, c.CompanyName ASC;
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sets = (r.recordsets as unknown as any[][]) ?? [];
    const one = (i: number) => sets[i]?.[0] ?? {};
    const sum = (rows: Record<string, number>) => Object.values(rows).reduce((a, b) => a + b, 0);
    const jobs = countsByStatus(sets[1] ?? []);
    const apps = countsByStatus(sets[2] ?? []);
    const mockRows = sets[6] ?? [];
    const mocks = countsByStatus(mockRows);
    const scored = mockRows.filter((m) => m.AvgScore != null);
    const placementsTotal = Number(one(5).Total ?? 0);
    const verified = Number(one(5).Verified ?? 0);
    return {
      companies: { total: Number(one(0).Total ?? 0), active: Number(one(0).Active ?? 0) },
      jobs: { total: sum(jobs), byStatus: jobs },
      applications: { total: sum(apps), byStatus: apps },
      interviewRounds: Number(one(3).Total ?? 0),
      offers: {
        total: Number(one(4).Total ?? 0),
        averageOfferedSalary: one(4).AvgSalary != null ? Number(one(4).AvgSalary) : null,
        highestOfferedSalary: one(4).MaxSalary != null ? Number(one(4).MaxSalary) : null,
      },
      placements: { total: placementsTotal, verified, pending: placementsTotal - verified },
      mockInterviews: {
        total: sum(mocks),
        byStatus: mocks,
        averageScore: scored.length ? scored.reduce((a, m) => a + Number(m.AvgScore) * Number(m.Cnt), 0) / scored.reduce((a, m) => a + Number(m.Cnt), 0) : null,
      },
      placementsByCompany: (sets[7] ?? []).map((x) => ({ companyId: String(x.CompanyId), companyName: x.CompanyName ?? undefined, placements: Number(x.Placements) })),
    };
  }

  async getPlacementPackages(): Promise<PlacementPackage[]> {
    const pool = await this.getPool();
    const r = await pool.request().query(`
      SELECT p.PlacementPackageId, p.PackageName, p.PackageType, p.Description, p.Price, p.IsActive, p.TermsObjectKey, p.CreatedAt,
             (SELECT COUNT(1) FROM dbo.NXA_StudentPlacementPackages s WHERE s.PlacementPackageId = p.PlacementPackageId) AS StudentCount
      FROM dbo.NXA_PlacementPackages p ORDER BY p.CreatedAt DESC, p.PlacementPackageId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.PlacementPackageId),
      packageName: x.PackageName,
      packageType: x.PackageType,
      description: x.Description ?? undefined,
      price: Number(x.Price),
      isActive: Boolean(x.IsActive),
      hasTerms: Boolean(x.TermsObjectKey),
      createdAt: iso(x.CreatedAt) ?? "",
      studentCount: Number(x.StudentCount ?? 0),
    }));
  }

  async getStudentPlacementPackages(): Promise<StudentPlacementPackage[]> {
    const pool = await this.getPool();
    const r = await pool.request().query(`
      SELECT s.StudentPlacementPackageId, s.StudentUserId, u.FullName AS StudentName, s.PlacementPackageId, p.PackageName,
             s.EnrollmentId, s.PackageStatus, s.StartDate, s.EndDate, s.CreatedAt
      FROM dbo.NXA_StudentPlacementPackages s
      LEFT JOIN dbo.NXA_PlacementPackages p ON p.PlacementPackageId = s.PlacementPackageId
      LEFT JOIN dbo.NXA_Users u ON u.UserId = s.StudentUserId
      ORDER BY s.CreatedAt DESC, s.StudentPlacementPackageId DESC
    `);
    return r.recordset.map((x) => ({
      id: String(x.StudentPlacementPackageId),
      studentUserId: String(x.StudentUserId),
      studentName: x.StudentName ?? undefined,
      placementPackageId: String(x.PlacementPackageId),
      packageName: x.PackageName ?? undefined,
      enrollmentId: String(x.EnrollmentId),
      packageStatus: x.PackageStatus != null ? String(x.PackageStatus).toLowerCase() : undefined,
      startDate: dateOnly(x.StartDate),
      endDate: dateOnly(x.EndDate),
      createdAt: iso(x.CreatedAt) ?? "",
    }));
  }
}
