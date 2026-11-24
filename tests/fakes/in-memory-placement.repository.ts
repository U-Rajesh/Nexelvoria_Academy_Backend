import { PlacementRuleError, type Changed, type PlacementRepository } from "../../src/modules/placements/placement.repository";
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
} from "../../src/modules/placements/placement.types";
import { DuplicateRecordError, RecordNotFoundError } from "../../src/repositories/repository.errors";

/**
 * Mirrors SqlServerPlacementRepository: numeric identity ids, the same
 * not-found / duplicate / rule errors, no-op handling, audits, and
 * all-or-nothing writes (set `failAudit` to make the audit write fail).
 */
export class InMemoryPlacementRepository implements PlacementRepository {
  companies: HiringCompany[] = [];
  jobs: JobOpening[] = [];
  applications: JobApplication[] = [];
  mockInterviews: MockInterview[] = [];
  questions: InterviewQuestion[] = [];
  placements: PlacementRecord[] = [];
  /** Stands in for NXA_Offers. */
  offers: Array<{ id: string; jobApplicationId: string; offerReference?: string | undefined; offeredSalary?: number | undefined; offerDate?: string | undefined; joiningDate?: string | undefined; createdAt?: string | undefined }> = [];
  rounds: InterviewRound[] = [];
  feedback: CompanyFeedback[] = [];
  eligibility: JobEligibilityCriterion[] = [];
  packages: PlacementPackage[] = [];
  studentPackages: StudentPlacementPackage[] = [];
  /** Students the SQL query would select for placement alerts (student role + ACTIVE enrollment). */
  eligibleStudentIds: string[] = [];
  notifications: Array<{ recipientUserId: string; notificationType: string; title: string; relatedEntityId: string }> = [];
  /** Stands in for NXA_JobApplicationStatusHistory. */
  applicationStatusHistory: Array<{ jobApplicationId: string; previousStatus: string; newStatus: string; changedByUserId: string; changeReason?: string | undefined; changedAt?: string }> = [];
  /** Admin writes recorded as the SQL adapter audits them. */
  audits: Array<{ actorUserId: string; actionType: string; entityId: string }> = [];
  failAudit = false;

  private seq = 100;
  private nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  reset(): void {
    this.companies = [];
    this.jobs = [];
    this.applications = [];
    this.mockInterviews = [];
    this.questions = [];
    this.placements = [];
    this.offers = [];
    this.rounds = [];
    this.feedback = [];
    this.eligibility = [];
    this.packages = [];
    this.studentPackages = [];
    this.eligibleStudentIds = [];
    this.notifications = [];
    this.applicationStatusHistory = [];
    this.audits = [];
    this.failAudit = false;
  }

  private audit(actorUserId: string, actionType: string, entityId: string): void {
    if (this.failAudit) throw new Error("audit write failed");
    this.audits.push({ actorUserId, actionType, entityId });
  }

  /** Deep snapshot / restore so a failed write leaves nothing behind. */
  private tx<T>(work: () => T): T {
    const keys = ["companies", "jobs", "applications", "mockInterviews", "questions", "placements", "offers", "rounds", "feedback", "notifications", "applicationStatusHistory", "audits"] as const;
    const snap = Object.fromEntries(keys.map((k) => [k, structuredClone(this[k])]));
    try {
      return work();
    } catch (err) {
      Object.assign(this, snap);
      throw err;
    }
  }

  // Companies
  async getCompanies(): Promise<HiringCompany[]> {
    return [...this.companies];
  }

  async getCompanyById(id: string): Promise<HiringCompany | null> {
    return this.companies.find((c) => c.id === id) ?? null;
  }

  private assertNameFree(name: string, excludeId?: string): void {
    if (this.companies.some((c) => c.id !== excludeId && c.companyName.trim().toUpperCase() === name.trim().toUpperCase())) {
      throw new PlacementRuleError("COMPANY_NAME_EXISTS", "Another company already has this name.", 409);
    }
  }

  async createCompany(company: CompanyInput & { isActive: boolean }, actorUserId: string): Promise<HiringCompany> {
    this.assertNameFree(company.companyName);
    return this.tx(() => {
      const newComp: HiringCompany = { ...company, hiringStatus: company.isActive ? "active" : "inactive", id: this.nextId(), createdAt: new Date().toISOString() };
      this.companies.push(newComp);
      this.audit(actorUserId, "CREATE_COMPANY", newComp.id);
      return { ...newComp };
    });
  }

  async updateCompany(id: string, changes: Partial<CompanyInput>, actorUserId: string): Promise<Changed<HiringCompany>> {
    const c = this.companies.find((x) => x.id === id);
    if (!c) throw new RecordNotFoundError("company", id);
    const diff = (Object.keys(changes) as Array<keyof CompanyInput>).filter((k) => changes[k] !== undefined && (changes[k] ?? null) !== (c[k] ?? null));
    if (diff.length === 0) return { record: { ...c }, changed: false };
    if (changes.companyName !== undefined && changes.companyName.trim().toUpperCase() !== c.companyName.trim().toUpperCase()) this.assertNameFree(changes.companyName, id);
    return this.tx(() => {
      for (const k of diff) (c as unknown as Record<string, unknown>)[k] = changes[k] ?? undefined;
      this.audit(actorUserId, "UPDATE_COMPANY", id);
      return { record: { ...c }, changed: true };
    });
  }

  async setCompanyActive(id: string, isActive: boolean, _reason: string | undefined, actorUserId: string): Promise<Changed<HiringCompany>> {
    const c = this.companies.find((x) => x.id === id);
    if (!c) throw new RecordNotFoundError("company", id);
    if (c.isActive === isActive) return { record: { ...c }, changed: false };
    return this.tx(() => {
      c.isActive = isActive;
      c.hiringStatus = isActive ? "active" : "inactive";
      this.audit(actorUserId, isActive ? "ACTIVATE_COMPANY" : "DEACTIVATE_COMPANY", id);
      return { record: { ...c }, changed: true };
    });
  }

  // Jobs
  async getJobs(filter?: { status?: string; companyId?: string }): Promise<JobOpening[]> {
    let result = [...this.jobs];
    if (filter?.status) result = result.filter((j) => j.jobStatus === filter.status!.toLowerCase());
    if (filter?.companyId) result = result.filter((j) => j.companyId === filter.companyId);
    return result;
  }

  async getJobById(id: string): Promise<JobOpening | null> {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  private assertCompanyActive(companyId: string): HiringCompany {
    const company = this.companies.find((c) => c.id === companyId);
    if (!company) throw new RecordNotFoundError("company", companyId);
    if (!company.isActive) throw new PlacementRuleError("COMPANY_INACTIVE", "The company is inactive.", 409);
    return company;
  }

  async createJob(job: Omit<JobOpening, "id" | "createdAt">, actorUserId: string): Promise<JobOpening> {
    const company = this.assertCompanyActive(job.companyId);
    if (job.salaryMin != null && job.salaryMax != null && job.salaryMin > job.salaryMax) throw new PlacementRuleError("SALARY_RANGE_INVALID", "Min > max.");
    return this.tx(() => {
      const open = job.jobStatus === "open";
      const newJob: JobOpening = {
        ...job,
        publishedByUserId: open ? actorUserId : undefined,
        publishedAt: open ? new Date().toISOString() : undefined,
        companyName: company.companyName,
        id: this.nextId(),
        createdAt: new Date().toISOString(),
      };
      this.jobs.push(newJob);
      this.audit(actorUserId, "CREATE_JOB", newJob.id);
      return { ...newJob };
    });
  }

  async updateJob(id: string, changes: JobUpdate, actorUserId: string): Promise<Changed<JobOpening>> {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new RecordNotFoundError("job", id);
    const min = changes.salaryMin !== undefined ? changes.salaryMin : (j.salaryMin ?? null);
    const max = changes.salaryMax !== undefined ? changes.salaryMax : (j.salaryMax ?? null);
    if (min != null && max != null && min > max) throw new PlacementRuleError("SALARY_RANGE_INVALID", "Min > max.");
    const diff = (Object.keys(changes) as Array<keyof JobUpdate>).filter((k) => changes[k] !== undefined && (changes[k] ?? null) !== ((j as unknown as Record<string, unknown>)[k] ?? null));
    if (diff.length === 0) return { record: { ...j }, changed: false };
    return this.tx(() => {
      for (const k of diff) (j as unknown as Record<string, unknown>)[k] = changes[k] ?? undefined;
      this.audit(actorUserId, "UPDATE_JOB", id);
      return { record: { ...j }, changed: true };
    });
  }

  async updateJobStatus(id: string, status: JobStatus, actorUserId: string): Promise<Changed<JobOpening>> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new RecordNotFoundError("job", id);
    if (job.jobStatus === status) return { record: { ...job }, changed: false };
    if (status === "open") this.assertCompanyActive(job.companyId);
    return this.tx(() => {
      if (status === "open" && !job.publishedAt) {
        job.publishedAt = new Date().toISOString();
        job.publishedByUserId = actorUserId;
      }
      job.jobStatus = status;
      this.audit(actorUserId, "SET_JOB_STATUS", id);
      return { record: { ...job }, changed: true };
    });
  }

  async getJobEligibility(jobId: string): Promise<JobEligibilityCriterion[]> {
    if (!this.jobs.some((j) => j.id === jobId)) throw new RecordNotFoundError("job", jobId);
    return this.eligibility.filter((e) => e.jobId === jobId);
  }

  async announceJob(jobId: string, title: string, _messageBody: string, actorUserId: string): Promise<JobAnnouncementResult> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new RecordNotFoundError("job", jobId);
    if (job.jobStatus !== "open") throw new PlacementRuleError("JOB_NOT_OPEN", "Only an open job can be announced.", 409);
    if (this.audits.some((a) => a.actionType === "ANNOUNCE_JOB" && a.entityId === jobId)) {
      throw new PlacementRuleError("JOB_ALREADY_ANNOUNCED", "This job has already been announced.", 409);
    }
    return this.tx(() => {
      for (const s of this.eligibleStudentIds) this.notifications.push({ recipientUserId: s, notificationType: "placement", title, relatedEntityId: jobId });
      this.audit(actorUserId, "ANNOUNCE_JOB", jobId);
      return { jobId, recipientCount: this.eligibleStudentIds.length };
    });
  }

  // Applications
  async applyForJob(app: Omit<JobApplication, "id" | "appliedAt" | "updatedAt">): Promise<JobApplication> {
    // Mirrors UNIQUE (JobId, StudentUserId).
    if (this.applications.some((a) => a.jobId === app.jobId && a.studentUserId === app.studentUserId)) {
      throw new DuplicateRecordError("job application", "jobId", app.jobId);
    }
    const now = new Date().toISOString();
    const job = this.jobs.find((j) => j.id === app.jobId);
    const newApp: JobApplication = {
      ...app,
      jobTitle: job?.jobTitle,
      companyId: job?.companyId,
      companyName: job?.companyName,
      id: this.nextId(),
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

  async getApplications(filter: ApplicationFilter): Promise<JobApplication[]> {
    return this.applications.filter(
      (a) =>
        (filter.jobId === undefined || a.jobId === filter.jobId) &&
        (filter.companyId === undefined || (a.companyId ?? this.jobs.find((j) => j.id === a.jobId)?.companyId) === filter.companyId) &&
        (filter.studentUserId === undefined || a.studentUserId === filter.studentUserId) &&
        (filter.status === undefined || a.applicationStatus === filter.status),
    );
  }

  async getApplicationById(id: string): Promise<JobApplication | null> {
    return this.applications.find((a) => a.id === id) ?? null;
  }

  async getApplicationHistory(applicationId: string): Promise<ApplicationStatusChange[]> {
    if (!this.applications.some((a) => a.id === applicationId)) throw new RecordNotFoundError("job application", applicationId);
    return this.applicationStatusHistory
      .filter((h) => h.jobApplicationId === applicationId)
      .map((h, i) => ({ id: String(i + 1), jobApplicationId: h.jobApplicationId, previousStatus: h.previousStatus, newStatus: h.newStatus, changeReason: h.changeReason, changedByUserId: h.changedByUserId, changedAt: h.changedAt ?? "" }))
      .reverse();
  }

  async updateApplicationStatus(
    applicationId: string,
    status: ApplicationStatus,
    changedByUserId: string,
    reason?: string | undefined,
  ): Promise<JobApplication> {
    const app = this.applications.find((a) => a.id === applicationId);
    if (!app) throw new RecordNotFoundError("job application", applicationId);
    if (app.applicationStatus === status) return app;
    return this.tx(() => {
      this.applicationStatusHistory.push({ jobApplicationId: applicationId, previousStatus: app.applicationStatus, newStatus: status, changedByUserId, changeReason: reason, changedAt: new Date().toISOString() });
      app.applicationStatus = status;
      app.updatedAt = new Date().toISOString();
      this.audit(changedByUserId, "SET_APPLICATION_STATUS", applicationId);
      return app;
    });
  }

  // Interview rounds
  async getInterviewRounds(applicationId: string): Promise<InterviewRound[]> {
    if (!this.applications.some((a) => a.id === applicationId)) throw new RecordNotFoundError("job application", applicationId);
    return this.rounds.filter((r) => r.jobApplicationId === applicationId).sort((a, b) => a.roundNumber - b.roundNumber);
  }

  async createInterviewRound(applicationId: string, input: InterviewRoundInput, actorUserId: string): Promise<InterviewRound> {
    if (!this.applications.some((a) => a.id === applicationId)) throw new RecordNotFoundError("job application", applicationId);
    const numbers = this.rounds.filter((r) => r.jobApplicationId === applicationId).map((r) => r.roundNumber);
    const roundNumber = input.roundNumber ?? (numbers.length ? Math.max(...numbers) + 1 : 1);
    if (numbers.includes(roundNumber)) throw new PlacementRuleError("ROUND_NUMBER_EXISTS", `Round ${roundNumber} already exists.`, 409);
    return this.tx(() => {
      const round: InterviewRound = {
        id: this.nextId(), jobApplicationId: applicationId, roundNumber, roundName: input.roundName,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt).toISOString() : undefined, meetingUrl: input.meetingUrl, roundStatus: "scheduled",
      };
      this.rounds.push(round);
      this.audit(actorUserId, "CREATE_INTERVIEW_ROUND", round.id);
      return { ...round };
    });
  }

  async updateInterviewRound(roundId: string, changes: InterviewRoundUpdate, actorUserId: string): Promise<Changed<InterviewRound>> {
    const r = this.rounds.find((x) => x.id === roundId);
    if (!r) throw new RecordNotFoundError("interview round", roundId);
    const norm = (k: keyof InterviewRoundUpdate, v: unknown) => (k === "scheduledAt" && v ? new Date(String(v)).toISOString() : (v ?? null));
    const diff = (Object.keys(changes) as Array<keyof InterviewRoundUpdate>).filter((k) => changes[k] !== undefined && norm(k, changes[k]) !== norm(k, r[k]));
    if (diff.length === 0) return { record: { ...r }, changed: false };
    return this.tx(() => {
      for (const k of diff) (r as unknown as Record<string, unknown>)[k] = (norm(k, changes[k]) ?? undefined) as unknown;
      this.audit(actorUserId, "UPDATE_INTERVIEW_ROUND", roundId);
      return { record: { ...r }, changed: true };
    });
  }

  // Offers
  private toOffer(o: InMemoryPlacementRepository["offers"][number]): JobOffer {
    const app = this.applications.find((a) => a.id === o.jobApplicationId);
    return {
      id: o.id, jobApplicationId: o.jobApplicationId, studentUserId: app?.studentUserId, studentName: app?.studentName, jobTitle: app?.jobTitle, companyName: app?.companyName,
      offerReference: o.offerReference ?? "", offeredSalary: o.offeredSalary, offerDate: o.offerDate, joiningDate: o.joiningDate, hasLetter: false, createdAt: o.createdAt ?? "",
    };
  }

  async getOffers(filter: { jobApplicationId?: string | undefined }): Promise<JobOffer[]> {
    return this.offers.filter((o) => filter.jobApplicationId === undefined || o.jobApplicationId === filter.jobApplicationId).map((o) => this.toOffer(o));
  }

  async createOffer(applicationId: string, input: OfferInput, actorUserId: string): Promise<JobOffer> {
    if (!this.applications.some((a) => a.id === applicationId)) throw new RecordNotFoundError("job application", applicationId);
    if (this.offers.some((o) => (o.offerReference ?? "").toUpperCase() === input.offerReference.toUpperCase())) {
      throw new PlacementRuleError("OFFER_REFERENCE_EXISTS", "An offer with this reference already exists.", 409);
    }
    return this.tx(() => {
      const o = { id: this.nextId(), jobApplicationId: applicationId, ...input, createdAt: new Date().toISOString() };
      this.offers.push(o);
      this.audit(actorUserId, "CREATE_OFFER", o.id);
      return this.toOffer(o);
    });
  }

  // Mock interviews
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

  async scheduleMockInterview(interview: Omit<MockInterview, "id" | "createdAt">, actorUserId?: string | undefined): Promise<MockInterview> {
    return this.tx(() => {
      const newInterview: MockInterview = { ...interview, id: this.nextId(), createdAt: new Date().toISOString() };
      this.mockInterviews.push(newInterview);
      if (actorUserId) this.audit(actorUserId, "SCHEDULE_MOCK_INTERVIEW", newInterview.id);
      return { ...newInterview };
    });
  }

  async evaluateMockInterview(
    id: string,
    score: number,
    feedback: string,
    status: "completed" | "cancelled",
    actorUserId?: string | undefined,
  ): Promise<MockInterview> {
    const m = this.mockInterviews.find((x) => x.id === id);
    if (!m) throw new RecordNotFoundError("mock interview", id);
    if (m.interviewStatus !== "scheduled") throw new PlacementRuleError("MOCK_INTERVIEW_FINALIZED", `Already ${m.interviewStatus}.`, 409);
    return this.tx(() => {
      m.overallScore = score;
      m.feedback = feedback;
      m.interviewStatus = status;
      if (actorUserId) this.audit(actorUserId, status === "completed" ? "EVALUATE_MOCK_INTERVIEW" : "CANCEL_MOCK_INTERVIEW", id);
      return { ...m };
    });
  }

  // Question bank
  async getQuestions(category?: string, includeInactive = false): Promise<InterviewQuestion[]> {
    return this.questions
      .filter((q) => includeInactive || q.isActive !== false)
      .filter((q) => !category || q.category.toLowerCase() === category.toLowerCase());
  }

  async addQuestion(q: Omit<InterviewQuestion, "id" | "isActive">, actorUserId?: string | undefined): Promise<InterviewQuestion> {
    return this.tx(() => {
      const newQ: InterviewQuestion = { ...q, id: this.nextId(), isActive: true };
      this.questions.push(newQ);
      if (actorUserId) this.audit(actorUserId, "CREATE_INTERVIEW_QUESTION", newQ.id);
      return { ...newQ };
    });
  }

  async updateQuestion(id: string, changes: QuestionUpdate, actorUserId: string): Promise<Changed<InterviewQuestion>> {
    const q = this.questions.find((x) => x.id === id);
    if (!q) throw new RecordNotFoundError("interview question", id);
    const diff = (Object.keys(changes) as Array<keyof QuestionUpdate>).filter((k) => changes[k] !== undefined && (changes[k] ?? null) !== (q[k] ?? null));
    if (diff.length === 0) return { record: { ...q }, changed: false };
    return this.tx(() => {
      for (const k of diff) (q as unknown as Record<string, unknown>)[k] = changes[k] ?? undefined;
      this.audit(actorUserId, "UPDATE_INTERVIEW_QUESTION", id);
      return { record: { ...q }, changed: true };
    });
  }

  async setQuestionActive(id: string, isActive: boolean, actorUserId: string): Promise<Changed<InterviewQuestion>> {
    const q = this.questions.find((x) => x.id === id);
    if (!q) throw new RecordNotFoundError("interview question", id);
    if ((q.isActive !== false) === isActive) return { record: { ...q }, changed: false };
    return this.tx(() => {
      q.isActive = isActive;
      this.audit(actorUserId, isActive ? "ACTIVATE_INTERVIEW_QUESTION" : "DEACTIVATE_INTERVIEW_QUESTION", id);
      return { record: { ...q }, changed: true };
    });
  }

  // Placement records
  async getPlacements(): Promise<PlacementRecord[]> {
    return [...this.placements];
  }

  async createPlacement(input: CreatePlacementInput, actorUserId: string): Promise<PlacementRecord> {
    const app = this.applications.find((a) => a.id === input.jobApplicationId);
    if (!app) throw new RecordNotFoundError("job application", input.jobApplicationId);
    const job = this.jobs.find((j) => j.id === app.jobId);
    if (!job) throw new RecordNotFoundError("job", app.jobId);
    const offer = input.offerId !== undefined ? this.offers.find((o) => o.id === input.offerId) : undefined;
    if (input.offerId !== undefined) {
      if (!offer) throw new RecordNotFoundError("offer", input.offerId);
      if (offer.jobApplicationId !== input.jobApplicationId) {
        throw new PlacementRuleError("OFFER_APPLICATION_MISMATCH", "The offer does not belong to this job application.");
      }
    }
    if (this.placements.some((p) => p.jobApplicationId === input.jobApplicationId)) {
      throw new DuplicateRecordError("placement record", "jobApplicationId", input.jobApplicationId);
    }
    return this.tx(() => {
      const verified = input.verificationStatus === "verified";
      const record: PlacementRecord = {
        id: this.nextId(),
        studentUserId: app.studentUserId,
        companyId: job.companyId,
        companyName: job.companyName,
        jobId: job.id,
        jobTitle: job.jobTitle,
        jobApplicationId: app.id,
        offerId: input.offerId,
        packageOffered: offer?.offeredSalary,
        offerDate: offer?.offerDate,
        joiningDate: input.joiningDate,
        verificationStatus: verified ? "verified" : "pending",
        ...(verified ? { verifiedAt: new Date().toISOString(), verifiedByUserId: actorUserId } : {}),
      };
      this.placements.push(record);
      this.audit(actorUserId, "CREATE_PLACEMENT_RECORD", record.id);
      return { ...record };
    });
  }

  async verifyPlacement(id: string, actorUserId: string): Promise<PlacementRecord> {
    const p = this.placements.find((x) => x.id === id);
    if (!p) throw new RecordNotFoundError("placement record", id);
    if (p.verificationStatus === "verified") throw new PlacementRuleError("PLACEMENT_ALREADY_VERIFIED", "Already verified.", 409);
    return this.tx(() => {
      Object.assign(p, { verificationStatus: "verified", verifiedAt: new Date().toISOString(), verifiedByUserId: actorUserId });
      this.audit(actorUserId, "VERIFY_PLACEMENT_RECORD", id);
      return { ...p };
    });
  }

  // Employer feedback
  async getCompanyFeedback(filter: { companyId?: string | undefined }): Promise<CompanyFeedback[]> {
    return this.feedback.filter((f) => filter.companyId === undefined || f.companyId === filter.companyId);
  }

  async createCompanyFeedback(companyId: string, input: { feedbackText: string; jobApplicationId?: string | undefined }, actorUserId: string): Promise<CompanyFeedback> {
    const company = this.companies.find((c) => c.id === companyId);
    if (!company) throw new RecordNotFoundError("company", companyId);
    let studentUserId: string | undefined;
    if (input.jobApplicationId !== undefined) {
      const app = this.applications.find((a) => a.id === input.jobApplicationId);
      if (!app) throw new RecordNotFoundError("job application", input.jobApplicationId);
      const job = this.jobs.find((j) => j.id === app.jobId);
      if (job?.companyId !== companyId) throw new PlacementRuleError("APPLICATION_COMPANY_MISMATCH", "Not a job of this company.");
      studentUserId = app.studentUserId;
    }
    return this.tx(() => {
      const fb: CompanyFeedback = { id: this.nextId(), companyId, companyName: company.companyName, jobApplicationId: input.jobApplicationId, studentUserId, feedbackText: input.feedbackText, submittedAt: new Date().toISOString() };
      this.feedback.push(fb);
      this.audit(actorUserId, "RECORD_EMPLOYER_FEEDBACK", fb.id);
      return { ...fb };
    });
  }

  // Analytics and packages
  async getPlacementAnalytics(): Promise<PlacementAnalytics> {
    const group = (vals: string[]) => vals.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
    const salaries = this.offers.map((o) => o.offeredSalary).filter((v): v is number => v != null);
    const scored = this.mockInterviews.map((m) => m.overallScore).filter((v): v is number => v != null);
    const verified = this.placements.filter((p) => p.verificationStatus === "verified").length;
    const byCompany = group(this.placements.map((p) => p.companyId));
    return {
      companies: { total: this.companies.length, active: this.companies.filter((c) => c.isActive).length },
      jobs: { total: this.jobs.length, byStatus: group(this.jobs.map((j) => j.jobStatus)) },
      applications: { total: this.applications.length, byStatus: group(this.applications.map((a) => a.applicationStatus)) },
      interviewRounds: this.rounds.length,
      offers: { total: this.offers.length, averageOfferedSalary: salaries.length ? salaries.reduce((a, b) => a + b, 0) / salaries.length : null, highestOfferedSalary: salaries.length ? Math.max(...salaries) : null },
      placements: { total: this.placements.length, verified, pending: this.placements.length - verified },
      mockInterviews: { total: this.mockInterviews.length, byStatus: group(this.mockInterviews.map((m) => m.interviewStatus)), averageScore: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null },
      placementsByCompany: Object.entries(byCompany).map(([companyId, placements]) => ({ companyId, companyName: this.companies.find((c) => c.id === companyId)?.companyName, placements })),
    };
  }

  async getPlacementPackages(): Promise<PlacementPackage[]> {
    return [...this.packages];
  }

  async getStudentPlacementPackages(): Promise<StudentPlacementPackage[]> {
    return [...this.studentPackages];
  }
}
