import { PlacementRuleError, type Changed, type PlacementRepository } from "./placement.repository";
import { DuplicateRecordError, RecordNotFoundError } from "../../repositories/repository.errors";
import type { EnrollmentRepository } from "../enrollments/enrollment.repository";
import type { UserRepository } from "../users/user.repository";
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
import { ApiError } from "../../utils/api-error";

/** Repository errors -> HTTP: unknown record 404, duplicate 409, rule 409/422. */
async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof RecordNotFoundError) throw ApiError.notFound(err.message);
    if (err instanceof DuplicateRecordError) throw ApiError.conflict(err.message, "DUPLICATE_RECORD");
    if (err instanceof PlacementRuleError) throw new ApiError(err.status, err.message, err.code);
    throw err;
  }
}

export class PlacementService {
  /**
   * @param enrollments BR-013 / PLC-014 eligibility source. When absent, no
   *   student is eligible (fail closed).
   * @param users Role checks for mock interview participants. When absent,
   *   scheduling is refused (fail closed).
   */
  constructor(
    private readonly placementRepo: PlacementRepository,
    private readonly enrollments?: EnrollmentRepository | undefined,
    private readonly users?: UserRepository | undefined,
  ) {}

  /**
   * BR-013 / PLC-014 (approved rule): the placement portal is open to a
   * student only with an approved account (enforced by authorization) AND at
   * least one ACTIVE enrollment. Approved-unpaid, pending or completed
   * enrollments alone do not qualify.
   */
  async assertPlacementEligible(studentUserId: string): Promise<void> {
    const list = this.enrollments ? await this.enrollments.findByStudent(studentUserId) : [];
    if (!list.some((e) => e.status === "active")) {
      throw ApiError.forbidden(
        "The placement portal is available to students with an active (paid or authorized) enrollment.",
        "PLACEMENT_NOT_ELIGIBLE",
      );
    }
  }

  // Companies
  async getCompanies(): Promise<HiringCompany[]> {
    return this.placementRepo.getCompanies();
  }

  async getCompany(id: string): Promise<HiringCompany> {
    const company = await this.placementRepo.getCompanyById(id);
    if (!company) throw ApiError.notFound("Company not found.");
    return company;
  }

  async createCompany(data: CompanyInput & { isActive: boolean }, actorUserId: string): Promise<HiringCompany> {
    return mapErrors(() => this.placementRepo.createCompany(data, actorUserId));
  }

  async updateCompany(id: string, changes: Partial<CompanyInput>, actorUserId: string): Promise<Changed<HiringCompany>> {
    return mapErrors(() => this.placementRepo.updateCompany(id, changes, actorUserId));
  }

  async setCompanyActive(id: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<Changed<HiringCompany>> {
    return mapErrors(() => this.placementRepo.setCompanyActive(id, isActive, reason, actorUserId));
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

  async createJob(data: Omit<JobOpening, "id" | "createdAt">, actorUserId: string): Promise<JobOpening> {
    return mapErrors(() => this.placementRepo.createJob(data, actorUserId));
  }

  async updateJob(id: string, changes: JobUpdate, actorUserId: string): Promise<Changed<JobOpening>> {
    return mapErrors(() => this.placementRepo.updateJob(id, changes, actorUserId));
  }

  async updateJobStatus(id: string, status: JobStatus, actorUserId: string): Promise<Changed<JobOpening>> {
    return mapErrors(() => this.placementRepo.updateJobStatus(id, status, actorUserId));
  }

  async getJobEligibility(jobId: string): Promise<JobEligibilityCriterion[]> {
    return mapErrors(() => this.placementRepo.getJobEligibility(jobId));
  }

  async announceJob(jobId: string, input: { title?: string | undefined; messageBody?: string | undefined }, actorUserId: string): Promise<JobAnnouncementResult> {
    const job = await this.getJob(jobId);
    const title = input.title ?? `New opening: ${job.jobTitle}${job.companyName ? ` at ${job.companyName}` : ""}`;
    const body =
      input.messageBody ??
      [`${job.jobTitle}${job.companyName ? ` at ${job.companyName}` : ""}`, job.workLocation, job.applicationDeadline ? `Apply by ${job.applicationDeadline}.` : ""]
        .filter(Boolean)
        .join(" · ");
    return mapErrors(() => this.placementRepo.announceJob(jobId, title, body, actorUserId));
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

    return mapErrors(() => this.placementRepo.applyForJob({
      jobId,
      studentUserId,
      applicationStatus: "applied",
      resumeObjectKey: data.resumeObjectKey,
      coverLetter: data.coverLetter,
    }));
  }

  async getStudentApplications(studentUserId: string): Promise<JobApplication[]> {
    return this.placementRepo.getApplicationsByStudent(studentUserId);
  }

  async getJobApplications(jobId: string): Promise<JobApplication[]> {
    return this.placementRepo.getApplicationsByJob(jobId);
  }

  async getApplications(filter: ApplicationFilter): Promise<JobApplication[]> {
    return this.placementRepo.getApplications(filter);
  }

  async getApplicationHistory(applicationId: string): Promise<ApplicationStatusChange[]> {
    return mapErrors(() => this.placementRepo.getApplicationHistory(applicationId));
  }

  async updateApplicationStatus(
    applicationId: string,
    status: ApplicationStatus,
    changedByUserId: string,
    reason?: string | undefined,
  ): Promise<JobApplication> {
    return mapErrors(() => this.placementRepo.updateApplicationStatus(applicationId, status, changedByUserId, reason));
  }

  // Interview rounds
  async getInterviewRounds(applicationId: string): Promise<InterviewRound[]> {
    return mapErrors(() => this.placementRepo.getInterviewRounds(applicationId));
  }

  async createInterviewRound(applicationId: string, input: InterviewRoundInput, actorUserId: string): Promise<InterviewRound> {
    return mapErrors(() => this.placementRepo.createInterviewRound(applicationId, input, actorUserId));
  }

  async updateInterviewRound(roundId: string, changes: InterviewRoundUpdate, actorUserId: string): Promise<Changed<InterviewRound>> {
    return mapErrors(() => this.placementRepo.updateInterviewRound(roundId, changes, actorUserId));
  }

  // Offers
  async getOffers(filter: { jobApplicationId?: string | undefined }): Promise<JobOffer[]> {
    if (filter.jobApplicationId !== undefined && !(await this.placementRepo.getApplicationById(filter.jobApplicationId))) {
      throw ApiError.notFound("Job application not found.");
    }
    return this.placementRepo.getOffers(filter);
  }

  async createOffer(applicationId: string, input: OfferInput, actorUserId: string): Promise<JobOffer> {
    return mapErrors(() => this.placementRepo.createOffer(applicationId, input, actorUserId));
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

  /**
   * PLC-009: the interviewer must hold the teacher role and the candidate the
   * student role with placement eligibility (BR-013), whoever schedules it.
   */
  async scheduleMockInterview(data: Omit<MockInterview, "id" | "createdAt">, actorUserId: string): Promise<MockInterview> {
    if (!this.users) throw ApiError.serviceUnavailable("User directory unavailable; the interview was not scheduled.");
    const [teacher, student] = await Promise.all([this.users.findById(data.teacherUserId), this.users.findById(data.studentUserId)]);
    if (!teacher || teacher.role !== "teacher") {
      throw new ApiError(422, "The interviewer must be an existing teacher.", "INTERVIEWER_NOT_TEACHER");
    }
    if (!student || student.role !== "student") {
      throw new ApiError(422, "The candidate must be an existing student.", "CANDIDATE_NOT_STUDENT");
    }
    await this.assertPlacementEligible(data.studentUserId);
    return mapErrors(() => this.placementRepo.scheduleMockInterview(data, actorUserId));
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

    return mapErrors(() => this.placementRepo.evaluateMockInterview(id, score, feedback, status, teacherUserId));
  }

  // Questions
  async getQuestions(category?: string, includeInactive = false): Promise<InterviewQuestion[]> {
    return this.placementRepo.getQuestions(category, includeInactive);
  }

  async addQuestion(data: Omit<InterviewQuestion, "id" | "isActive">, actorUserId?: string | undefined): Promise<InterviewQuestion> {
    return mapErrors(() => this.placementRepo.addQuestion(data, actorUserId));
  }

  async updateQuestion(id: string, changes: QuestionUpdate, actorUserId: string): Promise<Changed<InterviewQuestion>> {
    return mapErrors(() => this.placementRepo.updateQuestion(id, changes, actorUserId));
  }

  async setQuestionActive(id: string, isActive: boolean, actorUserId: string): Promise<Changed<InterviewQuestion>> {
    return mapErrors(() => this.placementRepo.setQuestionActive(id, isActive, actorUserId));
  }

  // Placements
  async getPlacements(): Promise<PlacementRecord[]> {
    return this.placementRepo.getPlacements();
  }

  async createPlacement(data: CreatePlacementInput, actorUserId: string): Promise<PlacementRecord> {
    return mapErrors(() => this.placementRepo.createPlacement(data, actorUserId));
  }

  async verifyPlacement(id: string, actorUserId: string): Promise<PlacementRecord> {
    return mapErrors(() => this.placementRepo.verifyPlacement(id, actorUserId));
  }

  // Employer feedback
  async getCompanyFeedback(filter: { companyId?: string | undefined }): Promise<CompanyFeedback[]> {
    return this.placementRepo.getCompanyFeedback(filter);
  }

  async createCompanyFeedback(
    companyId: string,
    input: { feedbackText: string; jobApplicationId?: string | undefined },
    actorUserId: string,
  ): Promise<CompanyFeedback> {
    return mapErrors(() => this.placementRepo.createCompanyFeedback(companyId, input, actorUserId));
  }

  // Analytics and packages (read-only)
  async getAnalytics(): Promise<PlacementAnalytics> {
    return this.placementRepo.getPlacementAnalytics();
  }

  async getPackages(): Promise<PlacementPackage[]> {
    return this.placementRepo.getPlacementPackages();
  }

  async getStudentPackages(): Promise<StudentPlacementPackage[]> {
    return this.placementRepo.getStudentPlacementPackages();
  }
}
