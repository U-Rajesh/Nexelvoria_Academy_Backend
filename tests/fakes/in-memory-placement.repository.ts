import crypto from "node:crypto";
import type { PlacementRepository } from "../../src/modules/placements/placement.repository";
import type {
  HiringCompany,
  InterviewQuestion,
  JobApplication,
  JobOpening,
  MockInterview,
  PlacementRecord,
} from "../../src/modules/placements/placement.types";

export class InMemoryPlacementRepository implements PlacementRepository {
  companies: HiringCompany[] = [];
  jobs: JobOpening[] = [];
  applications: JobApplication[] = [];
  mockInterviews: MockInterview[] = [];
  questions: InterviewQuestion[] = [];
  placements: PlacementRecord[] = [];

  reset(): void {
    this.companies = [];
    this.jobs = [];
    this.applications = [];
    this.mockInterviews = [];
    this.questions = [];
    this.placements = [];
  }

  async getCompanies(): Promise<HiringCompany[]> {
    return [...this.companies];
  }

  async getCompanyById(id: string): Promise<HiringCompany | null> {
    return this.companies.find((c) => c.id === id) ?? null;
  }

  async createCompany(company: Omit<HiringCompany, "id" | "createdAt">): Promise<HiringCompany> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newComp: HiringCompany = { ...company, id, createdAt: now };
    this.companies.push(newComp);
    return newComp;
  }

  async getJobs(filter?: { status?: string; companyId?: string }): Promise<JobOpening[]> {
    let result = [...this.jobs];
    if (filter?.status) {
      result = result.filter((j) => j.jobStatus === filter.status);
    }
    if (filter?.companyId) {
      result = result.filter((j) => j.companyId === filter.companyId);
    }
    return result;
  }

  async getJobById(id: string): Promise<JobOpening | null> {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  async createJob(job: Omit<JobOpening, "id" | "createdAt">): Promise<JobOpening> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newJob: JobOpening = { ...job, id, createdAt: now };
    this.jobs.push(newJob);
    return newJob;
  }

  async updateJobStatus(id: string, status: "open" | "closed" | "draft"): Promise<JobOpening> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error("Job not found.");
    job.jobStatus = status;
    return job;
  }

  async applyForJob(app: Omit<JobApplication, "id" | "appliedAt" | "updatedAt">): Promise<JobApplication> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newApp: JobApplication = {
      ...app,
      id,
      appliedAt: now,
      updatedAt: now,
    };
    this.applications.push(newApp);
    return newApp;
  }

  async getApplicationsByStudent(studentUserId: string): Promise<JobApplication[]> {
    return this.applications.filter((a) => a.studentUserId === studentUserId);
  }

  async getApplicationsByJob(jobId: string): Promise<JobApplication[]> {
    return this.applications.filter((a) => a.jobId === jobId);
  }

  async updateApplicationStatus(
    applicationId: string,
    status: "applied" | "shortlisted" | "rejected" | "selected"
  ): Promise<JobApplication> {
    const app = this.applications.find((a) => a.id === applicationId);
    if (!app) throw new Error("Application not found.");
    app.applicationStatus = status;
    app.updatedAt = new Date().toISOString();
    return app;
  }

  async getMockInterviewsByStudent(studentUserId: string): Promise<MockInterview[]> {
    return this.mockInterviews.filter((m) => m.studentUserId === studentUserId);
  }

  async getMockInterviewsByTeacher(teacherUserId: string): Promise<MockInterview[]> {
    return this.mockInterviews.filter((m) => m.teacherUserId === teacherUserId);
  }

  async getAllMockInterviews(): Promise<MockInterview[]> {
    return [...this.mockInterviews];
  }

  async getMockInterviewById(id: string): Promise<MockInterview | null> {
    return this.mockInterviews.find((m) => m.id === id) ?? null;
  }

  async scheduleMockInterview(interview: Omit<MockInterview, "id" | "createdAt">): Promise<MockInterview> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newInterview: MockInterview = { ...interview, id, createdAt: now };
    this.mockInterviews.push(newInterview);
    return newInterview;
  }

  async evaluateMockInterview(
    id: string,
    score: number,
    feedback: string,
    status: "completed" | "cancelled"
  ): Promise<MockInterview> {
    const m = this.mockInterviews.find((x) => x.id === id);
    if (!m) throw new Error("Mock interview not found.");
    m.overallScore = score;
    m.feedback = feedback;
    m.interviewStatus = status;
    return m;
  }

  async getQuestions(category?: string): Promise<InterviewQuestion[]> {
    if (category) {
      return this.questions.filter((q) => q.category.toLowerCase() === category.toLowerCase());
    }
    return [...this.questions];
  }

  async addQuestion(q: Omit<InterviewQuestion, "id">): Promise<InterviewQuestion> {
    const id = crypto.randomUUID();
    const newQ: InterviewQuestion = { ...q, id };
    this.questions.push(newQ);
    return newQ;
  }

  async getPlacements(): Promise<PlacementRecord[]> {
    return [...this.placements];
  }

  async createPlacement(record: Omit<PlacementRecord, "id">): Promise<PlacementRecord> {
    const id = crypto.randomUUID();
    const newP: PlacementRecord = { ...record, id };
    this.placements.push(newP);
    return newP;
  }
}
