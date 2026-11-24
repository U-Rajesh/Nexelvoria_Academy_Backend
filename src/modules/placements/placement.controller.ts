import type { Request, Response, NextFunction } from "express";
import type { PlacementService } from "./placement.service";
import {
  addQuestionSchema,
  announceJobSchema,
  applicationsQuerySchema,
  applyJobSchema,
  createCompanySchema,
  createFeedbackSchema,
  createJobSchema,
  createOfferSchema,
  createPlacementSchema,
  createRoundSchema,
  evaluateMockInterviewSchema,
  feedbackQuerySchema,
  idParamsSchema,
  jobIdParamsSchema,
  offersQuerySchema,
  scheduleMockInterviewSchema,
  setActiveSchema,
  setQuestionActiveSchema,
  updateApplicationStatusSchema,
  updateCompanySchema,
  updateJobSchema,
  updateJobStatusSchema,
  updateQuestionSchema,
  updateRoundSchema,
} from "./placement.validation";
import { ApiError } from "../../utils/api-error";
import { sendSuccess } from "../../utils/send";
import { HttpStatus } from "../../utils/http-status";

function getActor(req: Request): { id: string; role: string } {
  const id = req.principal?.id ?? (req as any).user?.userId ?? (req as any).user?.id;
  if (!id) {
    throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  }
  const role = req.principal?.role ?? (req as any).user?.role ?? "";
  return { id: String(id), role };
}

/** Drops keys whose value is undefined (exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

const unchangedMessage = "Nothing changed.";

export class PlacementController {
  constructor(private readonly placementService: PlacementService) {}

  // Companies
  getCompanies = wrap(async (_req, res) => {
    sendSuccess(res, { data: await this.placementService.getCompanies() });
  });

  createCompany = wrap(async (req, res) => {
    const parsed = createCompanySchema.parse(req.body);
    const company = await this.placementService.createCompany(
      {
        companyName: parsed.companyName,
        ...defined({
          websiteUrl: parsed.websiteUrl,
          industry: parsed.industry,
          description: parsed.description,
          address: parsed.address,
          contactName: parsed.contactName,
          contactEmail: parsed.contactEmail,
          contactMobile: parsed.contactMobile,
        }),
        isActive: parsed.hiringStatus === "active",
      },
      getActor(req).id,
    );
    sendSuccess(res, { status: HttpStatus.CREATED, data: company, message: "Company created successfully." });
  });

  updateCompany = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = updateCompanySchema.parse(req.body);
    // null clears a column; the repository stores it as NULL.
    const result = await this.placementService.updateCompany(id, body as Record<string, string | undefined>, getActor(req).id);
    sendSuccess(res, { data: result, message: result.changed ? "Company updated." : unchangedMessage });
  });

  setCompanyStatus = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = setActiveSchema.parse(req.body);
    const result = await this.placementService.setCompanyActive(id, body.isActive, body.reason, getActor(req).id);
    sendSuccess(res, {
      data: result,
      message: result.changed ? `Company ${body.isActive ? "activated" : "deactivated"}.` : unchangedMessage,
    });
  });

  // Jobs
  /** Public / student listing: open jobs only. Draft and closed jobs are never exposed here. */
  getJobs = wrap(async (req, res) => {
    const filter: { status?: string; companyId?: string } = { status: "open" };
    if (typeof req.query["companyId"] === "string") filter.companyId = req.query["companyId"];
    sendSuccess(res, { data: await this.placementService.getJobs(filter) });
  });

  /** Public / student detail: a job that is not open is reported as not found. */
  getJobById = wrap(async (req, res) => {
    const jobId = String(req.params["jobId"] ?? "");
    if (!jobId) throw ApiError.badRequest("Job ID is required.");
    const job = await this.placementService.getJob(jobId);
    if (job.jobStatus !== "open") throw ApiError.notFound("Job not found.");
    sendSuccess(res, { data: job });
  });

  /** Admin listing: every status, optional status / company filter. */
  getAdminJobs = wrap(async (req, res) => {
    const filter: { status?: string; companyId?: string } = {};
    if (typeof req.query["status"] === "string") filter.status = req.query["status"];
    if (typeof req.query["companyId"] === "string") filter.companyId = req.query["companyId"];
    sendSuccess(res, { data: await this.placementService.getJobs(filter) });
  });

  getAdminJobById = wrap(async (req, res) => {
    const jobId = String(req.params["jobId"] ?? "");
    if (!jobId) throw ApiError.badRequest("Job ID is required.");
    sendSuccess(res, { data: await this.placementService.getJob(jobId) });
  });

  createJob = wrap(async (req, res) => {
    const parsed = createJobSchema.parse(req.body);
    const actor = getActor(req);
    const job = await this.placementService.createJob(
      { ...parsed, ...(parsed.jobStatus === "open" ? { publishedByUserId: actor.id } : {}) },
      actor.id,
    );
    sendSuccess(res, { status: HttpStatus.CREATED, data: job, message: "Job opening created successfully." });
  });

  updateJob = wrap(async (req, res) => {
    const { jobId } = jobIdParamsSchema.parse(req.params);
    const body = updateJobSchema.parse(req.body);
    const result = await this.placementService.updateJob(jobId, body, getActor(req).id);
    sendSuccess(res, { data: result, message: result.changed ? "Job updated." : unchangedMessage });
  });

  updateJobStatus = wrap(async (req, res) => {
    const jobId = String(req.params["jobId"] ?? "");
    if (!jobId) throw ApiError.badRequest("Job ID is required.");
    const { status } = updateJobStatusSchema.parse(req.body);
    const result = await this.placementService.updateJobStatus(jobId, status, getActor(req).id);
    // `data` stays the job (existing contract); `changed` tells a no-op apart.
    sendSuccess(res, { data: { ...result.record, changed: result.changed }, message: result.changed ? "Job status updated." : unchangedMessage });
  });

  getJobEligibility = wrap(async (req, res) => {
    const { jobId } = jobIdParamsSchema.parse(req.params);
    sendSuccess(res, { data: await this.placementService.getJobEligibility(jobId) });
  });

  announceJob = wrap(async (req, res) => {
    const { jobId } = jobIdParamsSchema.parse(req.params);
    const body = announceJobSchema.parse(req.body ?? {});
    const result = await this.placementService.announceJob(jobId, body, getActor(req).id);
    sendSuccess(res, {
      status: HttpStatus.CREATED,
      data: result,
      message: `Placement alert sent to ${result.recipientCount} eligible student(s).`,
    });
  });

  // Applications
  applyForJob = wrap(async (req, res) => {
    const jobId = String(req.params["jobId"] ?? "");
    if (!jobId) throw ApiError.badRequest("Job ID is required.");
    const actor = getActor(req);
    await this.placementService.assertPlacementEligible(actor.id);
    const parsed = applyJobSchema.parse(req.body);
    const app = await this.placementService.applyForJob(actor.id, jobId, parsed);
    sendSuccess(res, { status: HttpStatus.CREATED, data: app, message: "Application submitted successfully." });
  });

  getMyApplications = wrap(async (req, res) => {
    const actor = getActor(req);
    await this.placementService.assertPlacementEligible(actor.id);
    sendSuccess(res, { data: await this.placementService.getStudentApplications(actor.id) });
  });

  getJobApplications = wrap(async (req, res) => {
    const jobId = String(req.params["jobId"] ?? "");
    if (!jobId) throw ApiError.badRequest("Job ID is required.");
    sendSuccess(res, { data: await this.placementService.getJobApplications(jobId) });
  });

  getApplications = wrap(async (req, res) => {
    const q = applicationsQuerySchema.parse(req.query);
    sendSuccess(res, { data: await this.placementService.getApplications(defined(q)) });
  });

  getApplicationHistory = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    sendSuccess(res, { data: await this.placementService.getApplicationHistory(id) });
  });

  updateApplicationStatus = wrap(async (req, res) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw ApiError.badRequest("Application ID is required.");
    const parsed = updateApplicationStatusSchema.parse(req.body);
    const app = await this.placementService.updateApplicationStatus(id, parsed.status, getActor(req).id, parsed.reason || undefined);
    sendSuccess(res, { data: app, message: "Application status updated." });
  });

  // Interview rounds
  getInterviewRounds = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    sendSuccess(res, { data: await this.placementService.getInterviewRounds(id) });
  });

  createInterviewRound = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = createRoundSchema.parse(req.body);
    const round = await this.placementService.createInterviewRound(id, { roundName: body.roundName, ...defined({ roundNumber: body.roundNumber, scheduledAt: body.scheduledAt, meetingUrl: body.meetingUrl }) }, getActor(req).id);
    sendSuccess(res, { status: HttpStatus.CREATED, data: round, message: "Interview round added." });
  });

  updateInterviewRound = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = updateRoundSchema.parse(req.body);
    const result = await this.placementService.updateInterviewRound(id, body, getActor(req).id);
    sendSuccess(res, { data: result, message: result.changed ? "Interview round updated." : unchangedMessage });
  });

  // Offers
  getOffers = wrap(async (req, res) => {
    const q = offersQuerySchema.parse(req.query);
    sendSuccess(res, { data: await this.placementService.getOffers({ jobApplicationId: q.jobApplicationId }) });
  });

  getApplicationOffers = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    sendSuccess(res, { data: await this.placementService.getOffers({ jobApplicationId: id }) });
  });

  createOffer = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = createOfferSchema.parse(req.body);
    const offer = await this.placementService.createOffer(id, { offerReference: body.offerReference, ...defined({ offeredSalary: body.offeredSalary, offerDate: body.offerDate, joiningDate: body.joiningDate }) }, getActor(req).id);
    sendSuccess(res, { status: HttpStatus.CREATED, data: offer, message: "Offer recorded. The offer letter file cannot be stored yet (no file storage)." });
  });

  // Mock Interviews
  getMyMockInterviews = wrap(async (req, res) => {
    const actor = getActor(req);
    await this.placementService.assertPlacementEligible(actor.id);
    sendSuccess(res, { data: await this.placementService.getStudentMockInterviews(actor.id) });
  });

  getTeacherMockInterviews = wrap(async (req, res) => {
    const actor = getActor(req);
    sendSuccess(res, { data: await this.placementService.getTeacherMockInterviews(actor.id) });
  });

  getAllMockInterviews = wrap(async (_req, res) => {
    sendSuccess(res, { data: await this.placementService.getAllMockInterviews() });
  });

  scheduleMockInterview = wrap(async (req, res) => {
    const parsed = scheduleMockInterviewSchema.parse(req.body);
    const actor = getActor(req);
    if (actor.role === "student" && parsed.studentUserId !== actor.id) {
      // A student may book only their own interview.
      throw ApiError.forbidden("You can schedule mock interviews only for yourself.", "NOT_OWN_RECORD");
    }
    const interview = await this.placementService.scheduleMockInterview(
      {
        studentUserId: parsed.studentUserId,
        teacherUserId: parsed.teacherUserId,
        scheduledAt: new Date(parsed.scheduledAt).toISOString(),
        ...defined({ meetingUrl: parsed.meetingUrl }),
        interviewStatus: "scheduled",
      },
      actor.id,
    );
    sendSuccess(res, { status: HttpStatus.CREATED, data: interview, message: "Mock interview scheduled." });
  });

  evaluateMockInterview = wrap(async (req, res) => {
    const id = String(req.params["id"] ?? "");
    if (!id) throw ApiError.badRequest("Mock Interview ID is required.");
    const actor = getActor(req);
    const parsed = evaluateMockInterviewSchema.parse(req.body);
    const interview = await this.placementService.evaluateMockInterview(id, actor.id, actor.role, parsed.overallScore, parsed.feedback, parsed.status);
    sendSuccess(res, { data: interview, message: "Mock interview evaluation recorded." });
  });

  // Questions
  getQuestions = wrap(async (req, res) => {
    const category = typeof req.query["category"] === "string" ? req.query["category"] : undefined;
    const actor = getActor(req);
    if (actor.role === "student") await this.placementService.assertPlacementEligible(actor.id);
    // Inactive questions are visible to staff only.
    const includeInactive = req.query["includeInactive"] === "true" && actor.role !== "student";
    sendSuccess(res, { data: await this.placementService.getQuestions(category, includeInactive) });
  });

  addQuestion = wrap(async (req, res) => {
    const parsed = addQuestionSchema.parse(req.body);
    // NXA_InterviewQuestionBank has no creator column; the author is kept in the audit log.
    const q = await this.placementService.addQuestion(parsed, getActor(req).id);
    sendSuccess(res, { status: HttpStatus.CREATED, data: q, message: "Question added to question bank." });
  });

  updateQuestion = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = updateQuestionSchema.parse(req.body);
    const result = await this.placementService.updateQuestion(id, body, getActor(req).id);
    sendSuccess(res, { data: result, message: result.changed ? "Question updated." : unchangedMessage });
  });

  setQuestionStatus = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = setQuestionActiveSchema.parse(req.body);
    const result = await this.placementService.setQuestionActive(id, body.isActive, getActor(req).id);
    sendSuccess(res, { data: result, message: result.changed ? `Question ${body.isActive ? "activated" : "deactivated"}.` : unchangedMessage });
  });

  // Placements
  getPlacements = wrap(async (_req, res) => {
    sendSuccess(res, { data: await this.placementService.getPlacements() });
  });

  createPlacement = wrap(async (req, res) => {
    const parsed = createPlacementSchema.parse(req.body);
    const record = await this.placementService.createPlacement(parsed, getActor(req).id);
    sendSuccess(res, { status: HttpStatus.CREATED, data: record, message: "Placement record added." });
  });

  verifyPlacement = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    sendSuccess(res, { data: await this.placementService.verifyPlacement(id, getActor(req).id), message: "Placement record verified." });
  });

  // Employer feedback
  getFeedback = wrap(async (req, res) => {
    const q = feedbackQuerySchema.parse(req.query);
    sendSuccess(res, { data: await this.placementService.getCompanyFeedback({ companyId: q.companyId }) });
  });

  createFeedback = wrap(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = createFeedbackSchema.parse(req.body);
    const fb = await this.placementService.createCompanyFeedback(id, { feedbackText: body.feedbackText, ...defined({ jobApplicationId: body.jobApplicationId }) }, getActor(req).id);
    sendSuccess(res, { status: HttpStatus.CREATED, data: fb, message: "Employer feedback recorded." });
  });

  // Analytics and packages
  getAnalytics = wrap(async (_req, res) => {
    sendSuccess(res, { data: await this.placementService.getAnalytics() });
  });

  getPackages = wrap(async (_req, res) => {
    sendSuccess(res, { data: await this.placementService.getPackages() });
  });

  getStudentPackages = wrap(async (_req, res) => {
    sendSuccess(res, { data: await this.placementService.getStudentPackages() });
  });
}
