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

/** A well-formed request that the placement data does not allow (mapped to 409 / 422). */
export class PlacementRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "PlacementRuleError";
  }
}

/** Result of a status change that may be a no-op. */
export interface Changed<T> {
  record: T;
  /** false when the record already had the requested state (nothing written, nothing audited). */
  changed: boolean;
}

/**
 * Ids are BIGINT identities. Lookups with a non-numeric id find nothing;
 * writes referencing one throw RecordNotFoundError. Unique violations throw
 * DuplicateRecordError; foreign-key violations throw PlacementRuleError.
 * Every Admin write runs in one transaction with its NXA_AuditLogs row.
 * Nothing is ever deleted.
 */
export interface PlacementRepository {
  // Companies (PLC-001; NXA_Companies is shared with CMS hiring partners)
  getCompanies(): Promise<HiringCompany[]>;
  getCompanyById(id: string): Promise<HiringCompany | null>;
  /** Refuses a name another company already has (case-insensitive, 409). Audited. */
  createCompany(company: CompanyInput & { isActive: boolean }, actorUserId: string): Promise<HiringCompany>;
  /** Edits columns only; same duplicate-name rule. An unchanged company writes nothing. */
  updateCompany(id: string, changes: Partial<CompanyInput>, actorUserId: string): Promise<Changed<HiringCompany>>;
  /** Sets IsActive. Existing jobs and records are untouched. */
  setCompanyActive(id: string, isActive: boolean, reason: string | undefined, actorUserId: string): Promise<Changed<HiringCompany>>;

  // Jobs (PLC-002)
  getJobs(filter?: { status?: string; companyId?: string }): Promise<JobOpening[]>;
  getJobById(id: string): Promise<JobOpening | null>;
  /** The company must exist and be active. Audited in the same transaction. */
  createJob(job: Omit<JobOpening, "id" | "createdAt">, actorUserId: string): Promise<JobOpening>;
  /** An unchanged job writes nothing. salaryMin may not exceed salaryMax (422). */
  updateJob(id: string, changes: JobUpdate, actorUserId: string): Promise<Changed<JobOpening>>;
  /**
   * Opening requires an active company. The first opening stamps
   * PublishedAt/PublishedByUserId. An unchanged status writes nothing.
   */
  updateJobStatus(id: string, status: JobStatus, actorUserId: string): Promise<Changed<JobOpening>>;
  /** Read-only (PLC-003 vocabulary is not approved). RecordNotFoundError for an unknown job. */
  getJobEligibility(jobId: string): Promise<JobEligibilityCriterion[]>;
  /**
   * Placement alert (in-app): one NXA_Notifications row (type 'placement') per
   * student with an ACTIVE enrollment (BR-013). The job must be open; a job is
   * announced once (409 on repeat).
   */
  announceJob(jobId: string, title: string, messageBody: string, actorUserId: string): Promise<JobAnnouncementResult>;

  // Applications (PLC-005)
  /** DuplicateRecordError when the student already applied to the job. */
  applyForJob(app: Omit<JobApplication, "id" | "appliedAt" | "updatedAt">): Promise<JobApplication>;
  getApplicationsByStudent(studentUserId: string): Promise<JobApplication[]>;
  getApplicationsByJob(jobId: string): Promise<JobApplication[]>;
  getApplications(filter: ApplicationFilter): Promise<JobApplication[]>;
  getApplicationById(id: string): Promise<JobApplication | null>;
  /** RecordNotFoundError for an unknown application. */
  getApplicationHistory(applicationId: string): Promise<ApplicationStatusChange[]>;
  /**
   * Updates the status, records NXA_JobApplicationStatusHistory (with the
   * reason) and the audit record in one transaction. Unchanged: nothing written.
   */
  updateApplicationStatus(
    applicationId: string,
    status: ApplicationStatus,
    changedByUserId: string,
    reason?: string | undefined,
  ): Promise<JobApplication>;

  // Interview rounds (PLC-006)
  getInterviewRounds(applicationId: string): Promise<InterviewRound[]>;
  /** Round numbers are unique per application (409). RoundStatus takes its table default. */
  createInterviewRound(applicationId: string, input: InterviewRoundInput, actorUserId: string): Promise<InterviewRound>;
  /** Schedule, link, name and feedback only; RoundStatus is never written. Unchanged: nothing written. */
  updateInterviewRound(roundId: string, changes: InterviewRoundUpdate, actorUserId: string): Promise<Changed<InterviewRound>>;

  // Offers (PLC-007, without the letter file)
  getOffers(filter: { jobApplicationId?: string | undefined }): Promise<JobOffer[]>;
  /** OfferReference is unique (409). OfferStatus takes its table default. */
  createOffer(applicationId: string, input: OfferInput, actorUserId: string): Promise<JobOffer>;

  // Mock interviews (PLC-009 / PLC-010)
  getMockInterviewsByStudent(studentUserId: string): Promise<MockInterview[]>;
  getMockInterviewsByTeacher(teacherUserId: string): Promise<MockInterview[]>;
  getAllMockInterviews(): Promise<MockInterview[]>;
  getMockInterviewById(id: string): Promise<MockInterview | null>;
  /** Audited when an actor is given (every HTTP call gives one). */
  scheduleMockInterview(interview: Omit<MockInterview, "id" | "createdAt">, actorUserId?: string | undefined): Promise<MockInterview>;
  /** Only a 'scheduled' interview can be evaluated or cancelled (409 otherwise). Audited. */
  evaluateMockInterview(
    id: string,
    score: number,
    feedback: string,
    status: "completed" | "cancelled",
    actorUserId?: string | undefined,
  ): Promise<MockInterview>;

  // Question bank (PLC-011)
  /** Active questions only unless includeInactive (staff). */
  getQuestions(category?: string, includeInactive?: boolean): Promise<InterviewQuestion[]>;
  addQuestion(q: Omit<InterviewQuestion, "id" | "isActive">, actorUserId?: string | undefined): Promise<InterviewQuestion>;
  updateQuestion(id: string, changes: QuestionUpdate, actorUserId: string): Promise<Changed<InterviewQuestion>>;
  setQuestionActive(id: string, isActive: boolean, actorUserId: string): Promise<Changed<InterviewQuestion>>;

  // Placement records (PLC-008)
  getPlacements(): Promise<PlacementRecord[]>;
  /**
   * Records a placement for an existing job application (student, job and
   * company come from it), optionally linked to that application's offer.
   * One record per application. Audited in the same transaction.
   */
  createPlacement(input: CreatePlacementInput, actorUserId: string): Promise<PlacementRecord>;
  /** Sets VerifiedAt/VerifiedByUserId; 409 when already verified. */
  verifyPlacement(id: string, actorUserId: string): Promise<PlacementRecord>;

  // Employer feedback (PLC-012)
  getCompanyFeedback(filter: { companyId?: string | undefined }): Promise<CompanyFeedback[]>;
  /**
   * The company must exist; a linked application must be for one of its jobs
   * (the student comes from it). Rating is never written (scale not approved).
   */
  createCompanyFeedback(
    companyId: string,
    input: { feedbackText: string; jobApplicationId?: string | undefined },
    actorUserId: string,
  ): Promise<CompanyFeedback>;

  // Analytics (PLC-013) and read-only package data
  getPlacementAnalytics(): Promise<PlacementAnalytics>;
  getPlacementPackages(): Promise<PlacementPackage[]>;
  getStudentPlacementPackages(): Promise<StudentPlacementPackage[]>;
}
