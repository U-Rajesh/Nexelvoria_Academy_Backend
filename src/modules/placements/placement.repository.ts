import type {
  HiringCompany,
  InterviewQuestion,
  JobApplication,
  JobOpening,
  MockInterview,
  PlacementRecord,
} from "./placement.types";

export interface PlacementRepository {
  // Companies
  getCompanies(): Promise<HiringCompany[]>;
  getCompanyById(id: string): Promise<HiringCompany | null>;
  createCompany(company: Omit<HiringCompany, "id" | "createdAt">): Promise<HiringCompany>;

  // Jobs
  getJobs(filter?: { status?: string; companyId?: string }): Promise<JobOpening[]>;
  getJobById(id: string): Promise<JobOpening | null>;
  createJob(job: Omit<JobOpening, "id" | "createdAt">): Promise<JobOpening>;
  updateJobStatus(id: string, status: "open" | "closed" | "draft"): Promise<JobOpening>;

  // Applications
  applyForJob(app: Omit<JobApplication, "id" | "appliedAt" | "updatedAt">): Promise<JobApplication>;
  getApplicationsByStudent(studentUserId: string): Promise<JobApplication[]>;
  getApplicationsByJob(jobId: string): Promise<JobApplication[]>;
  updateApplicationStatus(
    applicationId: string,
    status: "applied" | "shortlisted" | "rejected" | "selected"
  ): Promise<JobApplication>;

  // Mock Interviews
  getMockInterviewsByStudent(studentUserId: string): Promise<MockInterview[]>;
  getMockInterviewsByTeacher(teacherUserId: string): Promise<MockInterview[]>;
  getAllMockInterviews(): Promise<MockInterview[]>;
  getMockInterviewById(id: string): Promise<MockInterview | null>;
  scheduleMockInterview(interview: Omit<MockInterview, "id" | "createdAt">): Promise<MockInterview>;
  evaluateMockInterview(
    id: string,
    score: number,
    feedback: string,
    status: "completed" | "cancelled"
  ): Promise<MockInterview>;

  // Question Bank
  getQuestions(category?: string): Promise<InterviewQuestion[]>;
  addQuestion(q: Omit<InterviewQuestion, "id">): Promise<InterviewQuestion>;

  // Placement Records
  getPlacements(): Promise<PlacementRecord[]>;
  createPlacement(record: Omit<PlacementRecord, "id">): Promise<PlacementRecord>;
}
