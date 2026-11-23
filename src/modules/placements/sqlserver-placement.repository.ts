import crypto from "node:crypto";
import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import type {
  HiringCompany,
  InterviewQuestion,
  JobApplication,
  JobOpening,
  MockInterview,
  PlacementRecord,
} from "./placement.types";
import type { PlacementRepository } from "./placement.repository";

export class SqlServerPlacementRepository implements PlacementRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  async getCompanies(): Promise<HiringCompany[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .query(`
        SELECT CompanyId, CompanyName, WebsiteUrl, Industry, HiringStatus, LogoUrl, CreatedAt
        FROM dbo.NXA_Companies
        ORDER BY CompanyName ASC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.CompanyId),
      companyName: r.CompanyName,
      websiteUrl: r.WebsiteUrl ?? undefined,
      industry: r.Industry ?? undefined,
      hiringStatus: r.HiringStatus ?? "active",
      logoUrl: r.LogoUrl ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getCompanyById(id: string): Promise<HiringCompany | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("CompanyId", sql.UniqueIdentifier, id)
      .query(`
        SELECT TOP 1 CompanyId, CompanyName, WebsiteUrl, Industry, HiringStatus, LogoUrl, CreatedAt
        FROM dbo.NXA_Companies
        WHERE CompanyId = @CompanyId
      `);

    if (result.recordset.length === 0) return null;
    const r = result.recordset[0];
    return {
      id: String(r.CompanyId),
      companyName: r.CompanyName,
      websiteUrl: r.WebsiteUrl ?? undefined,
      industry: r.Industry ?? undefined,
      hiringStatus: r.HiringStatus ?? "active",
      logoUrl: r.LogoUrl ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async createCompany(company: Omit<HiringCompany, "id" | "createdAt">): Promise<HiringCompany> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("CompanyId", sql.UniqueIdentifier, id)
      .input("CompanyName", sql.NVarChar(200), company.companyName)
      .input("WebsiteUrl", sql.NVarChar(500), company.websiteUrl ?? null)
      .input("Industry", sql.NVarChar(100), company.industry ?? null)
      .input("HiringStatus", sql.NVarChar(50), company.hiringStatus)
      .input("LogoUrl", sql.NVarChar(500), company.logoUrl ?? null)
      .input("CreatedAt", sql.DateTime2, now)
      .query(`
        INSERT INTO dbo.NXA_Companies (
          CompanyId, CompanyName, WebsiteUrl, Industry, HiringStatus, LogoUrl, CreatedAt
        ) VALUES (
          @CompanyId, @CompanyName, @WebsiteUrl, @Industry, @HiringStatus, @LogoUrl, @CreatedAt
        )
      `);

    return {
      id,
      companyName: company.companyName,
      websiteUrl: company.websiteUrl,
      industry: company.industry,
      hiringStatus: company.hiringStatus,
      logoUrl: company.logoUrl,
      createdAt: now.toISOString(),
    };
  }

  async getJobs(filter?: { status?: string; companyId?: string }): Promise<JobOpening[]> {
    const pool = await this.getPool();
    let q = `
      SELECT j.JobId, j.CompanyId, c.CompanyName, j.JobTitle, j.EmploymentType,
             j.WorkLocation, j.SalaryMin, j.SalaryMax, j.MinExperienceYears,
             j.ApplicationDeadline, j.JobStatus, j.JobDescription,
             j.PublishedByUserId, j.PublishedAt, j.CreatedAt
      FROM dbo.NXA_Jobs j
      LEFT JOIN dbo.NXA_Companies c ON j.CompanyId = c.CompanyId
      WHERE 1=1
    `;

    const req = pool.request();
    if (filter?.status) {
      q += ` AND j.JobStatus = @JobStatus`;
      req.input("JobStatus", sql.NVarChar(50), filter.status);
    }
    if (filter?.companyId) {
      q += ` AND j.CompanyId = @CompanyId`;
      req.input("CompanyId", sql.UniqueIdentifier, filter.companyId);
    }

    q += ` ORDER BY j.CreatedAt DESC`;
    const result = await req.query(q);

    return result.recordset.map((r: any) => ({
      id: String(r.JobId),
      companyId: String(r.CompanyId),
      companyName: r.CompanyName ?? undefined,
      jobTitle: r.JobTitle,
      employmentType: r.EmploymentType ?? "full_time",
      workLocation: r.WorkLocation,
      salaryMin: r.SalaryMin != null ? Number(r.SalaryMin) : undefined,
      salaryMax: r.SalaryMax != null ? Number(r.SalaryMax) : undefined,
      minExperienceYears: r.MinExperienceYears != null ? Number(r.MinExperienceYears) : 0,
      applicationDeadline: r.ApplicationDeadline ? new Date(r.ApplicationDeadline).toISOString() : undefined,
      jobStatus: r.JobStatus ?? "open",
      jobDescription: r.JobDescription ?? "",
      publishedByUserId: r.PublishedByUserId ? String(r.PublishedByUserId) : undefined,
      publishedAt: r.PublishedAt ? new Date(r.PublishedAt).toISOString() : undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getJobById(id: string): Promise<JobOpening | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("JobId", sql.UniqueIdentifier, id)
      .query(`
        SELECT TOP 1 j.JobId, j.CompanyId, c.CompanyName, j.JobTitle, j.EmploymentType,
               j.WorkLocation, j.SalaryMin, j.SalaryMax, j.MinExperienceYears,
               j.ApplicationDeadline, j.JobStatus, j.JobDescription,
               j.PublishedByUserId, j.PublishedAt, j.CreatedAt
        FROM dbo.NXA_Jobs j
        LEFT JOIN dbo.NXA_Companies c ON j.CompanyId = c.CompanyId
        WHERE j.JobId = @JobId
      `);

    if (result.recordset.length === 0) return null;
    const r = result.recordset[0];
    return {
      id: String(r.JobId),
      companyId: String(r.CompanyId),
      companyName: r.CompanyName ?? undefined,
      jobTitle: r.JobTitle,
      employmentType: r.EmploymentType ?? "full_time",
      workLocation: r.WorkLocation,
      salaryMin: r.SalaryMin != null ? Number(r.SalaryMin) : undefined,
      salaryMax: r.SalaryMax != null ? Number(r.SalaryMax) : undefined,
      minExperienceYears: r.MinExperienceYears != null ? Number(r.MinExperienceYears) : 0,
      applicationDeadline: r.ApplicationDeadline ? new Date(r.ApplicationDeadline).toISOString() : undefined,
      jobStatus: r.JobStatus ?? "open",
      jobDescription: r.JobDescription ?? "",
      publishedByUserId: r.PublishedByUserId ? String(r.PublishedByUserId) : undefined,
      publishedAt: r.PublishedAt ? new Date(r.PublishedAt).toISOString() : undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async createJob(job: Omit<JobOpening, "id" | "createdAt">): Promise<JobOpening> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("JobId", sql.UniqueIdentifier, id)
      .input("CompanyId", sql.UniqueIdentifier, job.companyId)
      .input("JobTitle", sql.NVarChar(200), job.jobTitle)
      .input("EmploymentType", sql.NVarChar(50), job.employmentType)
      .input("WorkLocation", sql.NVarChar(200), job.workLocation)
      .input("SalaryMin", sql.Decimal(12, 2), job.salaryMin ?? null)
      .input("SalaryMax", sql.Decimal(12, 2), job.salaryMax ?? null)
      .input("MinExperienceYears", sql.Int, job.minExperienceYears)
      .input("ApplicationDeadline", sql.DateTime2, job.applicationDeadline ? new Date(job.applicationDeadline) : null)
      .input("JobStatus", sql.NVarChar(50), job.jobStatus)
      .input("JobDescription", sql.NVarChar(sql.MAX), job.jobDescription)
      .input("PublishedByUserId", sql.UniqueIdentifier, job.publishedByUserId ?? null)
      .input("PublishedAt", sql.DateTime2, job.publishedAt ? new Date(job.publishedAt) : now)
      .input("CreatedAt", sql.DateTime2, now)
      .query(`
        INSERT INTO dbo.NXA_Jobs (
          JobId, CompanyId, JobTitle, EmploymentType, WorkLocation, SalaryMin, SalaryMax,
          MinExperienceYears, ApplicationDeadline, JobStatus, JobDescription,
          PublishedByUserId, PublishedAt, CreatedAt
        ) VALUES (
          @JobId, @CompanyId, @JobTitle, @EmploymentType, @WorkLocation, @SalaryMin, @SalaryMax,
          @MinExperienceYears, @ApplicationDeadline, @JobStatus, @JobDescription,
          @PublishedByUserId, @PublishedAt, @CreatedAt
        )
      `);

    return {
      ...job,
      id,
      createdAt: now.toISOString(),
    };
  }

  async updateJobStatus(id: string, status: "open" | "closed" | "draft"): Promise<JobOpening> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("JobId", sql.UniqueIdentifier, id)
      .input("JobStatus", sql.NVarChar(50), status)
      .query(`
        UPDATE dbo.NXA_Jobs
        SET JobStatus = @JobStatus
        WHERE JobId = @JobId
      `);

    const updated = await this.getJobById(id);
    if (!updated) throw new Error("Job not found after update.");
    return updated;
  }

  async applyForJob(app: Omit<JobApplication, "id" | "appliedAt" | "updatedAt">): Promise<JobApplication> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("JobApplicationId", sql.UniqueIdentifier, id)
      .input("JobId", sql.UniqueIdentifier, app.jobId)
      .input("StudentUserId", sql.UniqueIdentifier, app.studentUserId)
      .input("ApplicationStatus", sql.NVarChar(50), app.applicationStatus)
      .input("ResumeObjectKey", sql.NVarChar(500), app.resumeObjectKey ?? null)
      .input("CoverLetter", sql.NVarChar(sql.MAX), app.coverLetter ?? null)
      .input("AppliedAt", sql.DateTime2, now)
      .input("UpdatedAt", sql.DateTime2, now)
      .query(`
        INSERT INTO dbo.NXA_JobApplications (
          JobApplicationId, JobId, StudentUserId, ApplicationStatus,
          ResumeObjectKey, CoverLetter, AppliedAt, UpdatedAt
        ) VALUES (
          @JobApplicationId, @JobId, @StudentUserId, @ApplicationStatus,
          @ResumeObjectKey, @CoverLetter, @AppliedAt, @UpdatedAt
        )
      `);

    return {
      ...app,
      id,
      appliedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  async getApplicationsByStudent(studentUserId: string): Promise<JobApplication[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("StudentUserId", sql.UniqueIdentifier, studentUserId)
      .query(`
        SELECT a.JobApplicationId, a.JobId, j.JobTitle, c.CompanyName,
               a.StudentUserId, a.ApplicationStatus, a.ResumeObjectKey,
               a.CoverLetter, a.AppliedAt, a.UpdatedAt
        FROM dbo.NXA_JobApplications a
        JOIN dbo.NXA_Jobs j ON a.JobId = j.JobId
        LEFT JOIN dbo.NXA_Companies c ON j.CompanyId = c.CompanyId
        WHERE a.StudentUserId = @StudentUserId
        ORDER BY a.AppliedAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.JobApplicationId),
      jobId: String(r.JobId),
      jobTitle: r.JobTitle,
      companyName: r.CompanyName ?? undefined,
      studentUserId: String(r.StudentUserId),
      applicationStatus: r.ApplicationStatus ?? "applied",
      resumeObjectKey: r.ResumeObjectKey ?? undefined,
      coverLetter: r.CoverLetter ?? undefined,
      appliedAt: r.AppliedAt ? new Date(r.AppliedAt).toISOString() : new Date().toISOString(),
      updatedAt: r.UpdatedAt ? new Date(r.UpdatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getApplicationsByJob(jobId: string): Promise<JobApplication[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("JobId", sql.UniqueIdentifier, jobId)
      .query(`
        SELECT a.JobApplicationId, a.JobId, j.JobTitle, c.CompanyName,
               a.StudentUserId, u.FullName AS StudentName,
               a.ApplicationStatus, a.ResumeObjectKey,
               a.CoverLetter, a.AppliedAt, a.UpdatedAt
        FROM dbo.NXA_JobApplications a
        JOIN dbo.NXA_Jobs j ON a.JobId = j.JobId
        LEFT JOIN dbo.NXA_Companies c ON j.CompanyId = c.CompanyId
        LEFT JOIN dbo.NXA_Users u ON a.StudentUserId = u.UserId
        WHERE a.JobId = @JobId
        ORDER BY a.AppliedAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.JobApplicationId),
      jobId: String(r.JobId),
      jobTitle: r.JobTitle,
      companyName: r.CompanyName ?? undefined,
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      applicationStatus: r.ApplicationStatus ?? "applied",
      resumeObjectKey: r.ResumeObjectKey ?? undefined,
      coverLetter: r.CoverLetter ?? undefined,
      appliedAt: r.AppliedAt ? new Date(r.AppliedAt).toISOString() : new Date().toISOString(),
      updatedAt: r.UpdatedAt ? new Date(r.UpdatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async updateApplicationStatus(
    applicationId: string,
    status: "applied" | "shortlisted" | "rejected" | "selected"
  ): Promise<JobApplication> {
    const pool = await this.getPool();
    const now = new Date();
    await pool
      .request()
      .input("JobApplicationId", sql.UniqueIdentifier, applicationId)
      .input("ApplicationStatus", sql.NVarChar(50), status)
      .input("UpdatedAt", sql.DateTime2, now)
      .query(`
        UPDATE dbo.NXA_JobApplications
        SET ApplicationStatus = @ApplicationStatus,
            UpdatedAt = @UpdatedAt
        WHERE JobApplicationId = @JobApplicationId
      `);

    const result = await pool
      .request()
      .input("JobApplicationId", sql.UniqueIdentifier, applicationId)
      .query(`
        SELECT TOP 1 a.JobApplicationId, a.JobId, j.JobTitle, c.CompanyName,
               a.StudentUserId, u.FullName AS StudentName,
               a.ApplicationStatus, a.ResumeObjectKey,
               a.CoverLetter, a.AppliedAt, a.UpdatedAt
        FROM dbo.NXA_JobApplications a
        JOIN dbo.NXA_Jobs j ON a.JobId = j.JobId
        LEFT JOIN dbo.NXA_Companies c ON j.CompanyId = c.CompanyId
        LEFT JOIN dbo.NXA_Users u ON a.StudentUserId = u.UserId
        WHERE a.JobApplicationId = @JobApplicationId
      `);

    if (result.recordset.length === 0) throw new Error("Application not found.");
    const r = result.recordset[0];
    return {
      id: String(r.JobApplicationId),
      jobId: String(r.JobId),
      jobTitle: r.JobTitle,
      companyName: r.CompanyName ?? undefined,
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      applicationStatus: r.ApplicationStatus ?? "applied",
      resumeObjectKey: r.ResumeObjectKey ?? undefined,
      coverLetter: r.CoverLetter ?? undefined,
      appliedAt: r.AppliedAt ? new Date(r.AppliedAt).toISOString() : new Date().toISOString(),
      updatedAt: r.UpdatedAt ? new Date(r.UpdatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async getMockInterviewsByStudent(studentUserId: string): Promise<MockInterview[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("StudentUserId", sql.UniqueIdentifier, studentUserId)
      .query(`
        SELECT m.MockInterviewId, m.StudentUserId, us.FullName AS StudentName,
               m.TeacherUserId, ut.FullName AS TeacherName,
               m.ScheduledAt, m.MeetingUrl, m.InterviewStatus,
               m.OverallScore, m.Feedback, m.CreatedAt
        FROM dbo.NXA_MockInterviews m
        LEFT JOIN dbo.NXA_Users us ON m.StudentUserId = us.UserId
        LEFT JOIN dbo.NXA_Users ut ON m.TeacherUserId = ut.UserId
        WHERE m.StudentUserId = @StudentUserId
        ORDER BY m.ScheduledAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.MockInterviewId),
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      teacherUserId: String(r.TeacherUserId),
      teacherName: r.TeacherName ?? undefined,
      scheduledAt: r.ScheduledAt ? new Date(r.ScheduledAt).toISOString() : new Date().toISOString(),
      meetingUrl: r.MeetingUrl ?? undefined,
      interviewStatus: r.InterviewStatus ?? "scheduled",
      overallScore: r.OverallScore != null ? Number(r.OverallScore) : undefined,
      feedback: r.Feedback ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getMockInterviewsByTeacher(teacherUserId: string): Promise<MockInterview[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("TeacherUserId", sql.UniqueIdentifier, teacherUserId)
      .query(`
        SELECT m.MockInterviewId, m.StudentUserId, us.FullName AS StudentName,
               m.TeacherUserId, ut.FullName AS TeacherName,
               m.ScheduledAt, m.MeetingUrl, m.InterviewStatus,
               m.OverallScore, m.Feedback, m.CreatedAt
        FROM dbo.NXA_MockInterviews m
        LEFT JOIN dbo.NXA_Users us ON m.StudentUserId = us.UserId
        LEFT JOIN dbo.NXA_Users ut ON m.TeacherUserId = ut.UserId
        WHERE m.TeacherUserId = @TeacherUserId
        ORDER BY m.ScheduledAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.MockInterviewId),
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      teacherUserId: String(r.TeacherUserId),
      teacherName: r.TeacherName ?? undefined,
      scheduledAt: r.ScheduledAt ? new Date(r.ScheduledAt).toISOString() : new Date().toISOString(),
      meetingUrl: r.MeetingUrl ?? undefined,
      interviewStatus: r.InterviewStatus ?? "scheduled",
      overallScore: r.OverallScore != null ? Number(r.OverallScore) : undefined,
      feedback: r.Feedback ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getAllMockInterviews(): Promise<MockInterview[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .query(`
        SELECT m.MockInterviewId, m.StudentUserId, us.FullName AS StudentName,
               m.TeacherUserId, ut.FullName AS TeacherName,
               m.ScheduledAt, m.MeetingUrl, m.InterviewStatus,
               m.OverallScore, m.Feedback, m.CreatedAt
        FROM dbo.NXA_MockInterviews m
        LEFT JOIN dbo.NXA_Users us ON m.StudentUserId = us.UserId
        LEFT JOIN dbo.NXA_Users ut ON m.TeacherUserId = ut.UserId
        ORDER BY m.ScheduledAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.MockInterviewId),
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      teacherUserId: String(r.TeacherUserId),
      teacherName: r.TeacherName ?? undefined,
      scheduledAt: r.ScheduledAt ? new Date(r.ScheduledAt).toISOString() : new Date().toISOString(),
      meetingUrl: r.MeetingUrl ?? undefined,
      interviewStatus: r.InterviewStatus ?? "scheduled",
      overallScore: r.OverallScore != null ? Number(r.OverallScore) : undefined,
      feedback: r.Feedback ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getMockInterviewById(id: string): Promise<MockInterview | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("MockInterviewId", sql.UniqueIdentifier, id)
      .query(`
        SELECT TOP 1 m.MockInterviewId, m.StudentUserId, us.FullName AS StudentName,
               m.TeacherUserId, ut.FullName AS TeacherName,
               m.ScheduledAt, m.MeetingUrl, m.InterviewStatus,
               m.OverallScore, m.Feedback, m.CreatedAt
        FROM dbo.NXA_MockInterviews m
        LEFT JOIN dbo.NXA_Users us ON m.StudentUserId = us.UserId
        LEFT JOIN dbo.NXA_Users ut ON m.TeacherUserId = ut.UserId
        WHERE m.MockInterviewId = @MockInterviewId
      `);

    if (result.recordset.length === 0) return null;
    const r = result.recordset[0];
    return {
      id: String(r.MockInterviewId),
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      teacherUserId: String(r.TeacherUserId),
      teacherName: r.TeacherName ?? undefined,
      scheduledAt: r.ScheduledAt ? new Date(r.ScheduledAt).toISOString() : new Date().toISOString(),
      meetingUrl: r.MeetingUrl ?? undefined,
      interviewStatus: r.InterviewStatus ?? "scheduled",
      overallScore: r.OverallScore != null ? Number(r.OverallScore) : undefined,
      feedback: r.Feedback ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async scheduleMockInterview(interview: Omit<MockInterview, "id" | "createdAt">): Promise<MockInterview> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("MockInterviewId", sql.UniqueIdentifier, id)
      .input("StudentUserId", sql.UniqueIdentifier, interview.studentUserId)
      .input("TeacherUserId", sql.UniqueIdentifier, interview.teacherUserId)
      .input("ScheduledAt", sql.DateTime2, new Date(interview.scheduledAt))
      .input("MeetingUrl", sql.NVarChar(500), interview.meetingUrl ?? null)
      .input("InterviewStatus", sql.NVarChar(50), interview.interviewStatus)
      .input("OverallScore", sql.Decimal(5, 2), interview.overallScore ?? null)
      .input("Feedback", sql.NVarChar(sql.MAX), interview.feedback ?? null)
      .input("CreatedAt", sql.DateTime2, now)
      .query(`
        INSERT INTO dbo.NXA_MockInterviews (
          MockInterviewId, StudentUserId, TeacherUserId, ScheduledAt, MeetingUrl,
          InterviewStatus, OverallScore, Feedback, CreatedAt
        ) VALUES (
          @MockInterviewId, @StudentUserId, @TeacherUserId, @ScheduledAt, @MeetingUrl,
          @InterviewStatus, @OverallScore, @Feedback, @CreatedAt
        )
      `);

    return {
      ...interview,
      id,
      createdAt: now.toISOString(),
    };
  }

  async evaluateMockInterview(
    id: string,
    score: number,
    feedback: string,
    status: "completed" | "cancelled"
  ): Promise<MockInterview> {
    const pool = await this.getPool();
    await pool
      .request()
      .input("MockInterviewId", sql.UniqueIdentifier, id)
      .input("OverallScore", sql.Decimal(5, 2), score)
      .input("Feedback", sql.NVarChar(sql.MAX), feedback)
      .input("InterviewStatus", sql.NVarChar(50), status)
      .query(`
        UPDATE dbo.NXA_MockInterviews
        SET OverallScore = @OverallScore,
            Feedback = @Feedback,
            InterviewStatus = @InterviewStatus
        WHERE MockInterviewId = @MockInterviewId
      `);

    const updated = await this.getMockInterviewById(id);
    if (!updated) throw new Error("Mock interview not found after update.");
    return updated;
  }

  async getQuestions(category?: string): Promise<InterviewQuestion[]> {
    const pool = await this.getPool();
    let q = `
      SELECT QuestionId, Category, QuestionText, DifficultyLevel, SampleAnswer, CreatedByUserId
      FROM dbo.NXA_InterviewQuestionBank
      WHERE 1=1
    `;
    const req = pool.request();
    if (category) {
      q += ` AND Category = @Category`;
      req.input("Category", sql.NVarChar(100), category);
    }
    q += ` ORDER BY Category ASC`;

    const result = await req.query(q);
    return result.recordset.map((r: any) => ({
      id: String(r.QuestionId),
      category: r.Category,
      questionText: r.QuestionText,
      difficultyLevel: r.DifficultyLevel ?? "intermediate",
      sampleAnswer: r.SampleAnswer ?? undefined,
      createdByUserId: r.CreatedByUserId ? String(r.CreatedByUserId) : undefined,
    }));
  }

  async addQuestion(q: Omit<InterviewQuestion, "id">): Promise<InterviewQuestion> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    await pool
      .request()
      .input("QuestionId", sql.UniqueIdentifier, id)
      .input("Category", sql.NVarChar(100), q.category)
      .input("QuestionText", sql.NVarChar(sql.MAX), q.questionText)
      .input("DifficultyLevel", sql.NVarChar(50), q.difficultyLevel)
      .input("SampleAnswer", sql.NVarChar(sql.MAX), q.sampleAnswer ?? null)
      .input("CreatedByUserId", sql.UniqueIdentifier, q.createdByUserId ?? null)
      .query(`
        INSERT INTO dbo.NXA_InterviewQuestionBank (
          QuestionId, Category, QuestionText, DifficultyLevel, SampleAnswer, CreatedByUserId
        ) VALUES (
          @QuestionId, @Category, @QuestionText, @DifficultyLevel, @SampleAnswer, @CreatedByUserId
        )
      `);

    return {
      ...q,
      id,
    };
  }

  async getPlacements(): Promise<PlacementRecord[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .query(`
        SELECT p.PlacementId, p.StudentUserId, u.FullName AS StudentName,
               p.CompanyId, c.CompanyName, p.JobTitle, p.PackageOffered,
               p.OfferDate, p.VerificationStatus
        FROM dbo.NXA_PlacementRecords p
        LEFT JOIN dbo.NXA_Users u ON p.StudentUserId = u.UserId
        LEFT JOIN dbo.NXA_Companies c ON p.CompanyId = c.CompanyId
        ORDER BY p.OfferDate DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.PlacementId),
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      companyId: String(r.CompanyId),
      companyName: r.CompanyName ?? undefined,
      jobTitle: r.JobTitle,
      packageOffered: Number(r.PackageOffered ?? 0),
      offerDate: r.OfferDate ? new Date(r.OfferDate).toISOString() : new Date().toISOString(),
      verificationStatus: r.VerificationStatus ?? "pending",
    }));
  }

  async createPlacement(record: Omit<PlacementRecord, "id">): Promise<PlacementRecord> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    await pool
      .request()
      .input("PlacementId", sql.UniqueIdentifier, id)
      .input("StudentUserId", sql.UniqueIdentifier, record.studentUserId)
      .input("CompanyId", sql.UniqueIdentifier, record.companyId)
      .input("JobTitle", sql.NVarChar(200), record.jobTitle)
      .input("PackageOffered", sql.Decimal(12, 2), record.packageOffered)
      .input("OfferDate", sql.DateTime2, new Date(record.offerDate))
      .input("VerificationStatus", sql.NVarChar(50), record.verificationStatus)
      .query(`
        INSERT INTO dbo.NXA_PlacementRecords (
          PlacementId, StudentUserId, CompanyId, JobTitle, PackageOffered, OfferDate, VerificationStatus
        ) VALUES (
          @PlacementId, @StudentUserId, @CompanyId, @JobTitle, @PackageOffered, @OfferDate, @VerificationStatus
        )
      `);

    return {
      ...record,
      id,
    };
  }
}
