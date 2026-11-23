import type { PlacementRepository } from "./placement.repository";
import type {
  HiringCompany,
  InterviewQuestion,
  JobApplication,
  JobOpening,
  MockInterview,
  PlacementRecord,
} from "./placement.types";
import { ApiError } from "../../utils/api-error";

export class PlacementService {
  constructor(private readonly placementRepo: PlacementRepository) {}

  // Companies
  async getCompanies(): Promise<HiringCompany[]> {
    return this.placementRepo.getCompanies();
  }

  async getCompany(id: string): Promise<HiringCompany> {
    const company = await this.placementRepo.getCompanyById(id);
    if (!company) throw ApiError.notFound("Company not found.");
    return company;
  }

  async createCompany(data: Omit<HiringCompany, "id" | "createdAt">): Promise<HiringCompany> {
    return this.placementRepo.createCompany(data);
  }

  // Jobs
  async getJobs(filter?: { status?: string; companyId?: string }): Promise<JobOpening[]> {
    return this.placementRepo.getJobs(filter);
  }

  async getJob(id: string): Promise<JobOpening> {
    const job = await this.placementRepo.getJobById(id);
    if (!job) throw ApiError.notFound("Job not found.");
    return job;
  }

  async createJob(data: Omit<JobOpening, "id" | "createdAt">): Promise<JobOpening> {
    return this.placementRepo.createJob(data);
  }

  async updateJobStatus(id: string, status: "open" | "closed" | "draft"): Promise<JobOpening> {
    return this.placementRepo.updateJobStatus(id, status);
  }

  // Applications
  async applyForJob(
    studentUserId: string,
    jobId: string,
    data: { resumeObjectKey?: string | undefined; coverLetter?: string | undefined }
  ): Promise<JobApplication> {
    const job = await this.getJob(jobId);
    if (job.jobStatus !== "open") {
      throw ApiError.badRequest("This job opening is no longer accepting applications.");
    }

    return this.placementRepo.applyForJob({
      jobId,
      studentUserId,
      applicationStatus: "applied",
      resumeObjectKey: data.resumeObjectKey,
      coverLetter: data.coverLetter,
    });
  }

  async getStudentApplications(studentUserId: string): Promise<JobApplication[]> {
    return this.placementRepo.getApplicationsByStudent(studentUserId);
  }

  async getJobApplications(jobId: string): Promise<JobApplication[]> {
    return this.placementRepo.getApplicationsByJob(jobId);
  }

  async updateApplicationStatus(
    applicationId: string,
    status: "applied" | "shortlisted" | "rejected" | "selected"
  ): Promise<JobApplication> {
    return this.placementRepo.updateApplicationStatus(applicationId, status);
  }

  // Mock Interviews
  async getStudentMockInterviews(studentUserId: string): Promise<MockInterview[]> {
    return this.placementRepo.getMockInterviewsByStudent(studentUserId);
  }

  async getTeacherMockInterviews(teacherUserId: string): Promise<MockInterview[]> {
    return this.placementRepo.getMockInterviewsByTeacher(teacherUserId);
  }

  async getAllMockInterviews(): Promise<MockInterview[]> {
    return this.placementRepo.getAllMockInterviews();
  }

  async scheduleMockInterview(data: Omit<MockInterview, "id" | "createdAt">): Promise<MockInterview> {
    return this.placementRepo.scheduleMockInterview(data);
  }

  async evaluateMockInterview(
    id: string,
    teacherUserId: string,
    userRole: string,
    score: number,
    feedback: string,
    status: "completed" | "cancelled"
  ): Promise<MockInterview> {
    const interview = await this.placementRepo.getMockInterviewById(id);
    if (!interview) throw ApiError.notFound("Mock interview not found.");

    if (interview.teacherUserId !== teacherUserId && !["admin", "super_admin"].includes(userRole)) {
      throw ApiError.forbidden("You are not authorized to evaluate this mock interview.");
    }

    return this.placementRepo.evaluateMockInterview(id, score, feedback, status);
  }

  // Questions
  async getQuestions(category?: string): Promise<InterviewQuestion[]> {
    return this.placementRepo.getQuestions(category);
  }

  async addQuestion(data: Omit<InterviewQuestion, "id">): Promise<InterviewQuestion> {
    return this.placementRepo.addQuestion(data);
  }

  // Placements
  async getPlacements(): Promise<PlacementRecord[]> {
    return this.placementRepo.getPlacements();
  }

  async createPlacement(data: Omit<PlacementRecord, "id">): Promise<PlacementRecord> {
    return this.placementRepo.createPlacement(data);
  }
}
