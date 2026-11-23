import type { Request, Response, NextFunction } from "express";
import type { PlacementService } from "./placement.service";
import {
  addQuestionSchema,
  applyJobSchema,
  createCompanySchema,
  createJobSchema,
  evaluateMockInterviewSchema,
  scheduleMockInterviewSchema,
  updateApplicationStatusSchema,
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

export class PlacementController {
  constructor(private readonly placementService: PlacementService) {}

  // Companies
  getCompanies = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const companies = await this.placementService.getCompanies();
      sendSuccess(res, { data: companies });
    } catch (err) {
      next(err);
    }
  };

  createCompany = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createCompanySchema.parse(req.body);
      const company = await this.placementService.createCompany(parsed);
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: company,
        message: "Company created successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  // Jobs
  getJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const filter: { status?: string; companyId?: string } = {};
      if (typeof req.query["status"] === "string") filter.status = req.query["status"];
      if (typeof req.query["companyId"] === "string") filter.companyId = req.query["companyId"];
      const jobs = await this.placementService.getJobs(filter);
      sendSuccess(res, { data: jobs });
    } catch (err) {
      next(err);
    }
  };

  getJobById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = String(req.params["jobId"] ?? "");
      if (!jobId) throw ApiError.badRequest("Job ID is required.");
      const job = await this.placementService.getJob(jobId);
      sendSuccess(res, { data: job });
    } catch (err) {
      next(err);
    }
  };

  createJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createJobSchema.parse(req.body);
      const actor = getActor(req);
      const job = await this.placementService.createJob({
        ...parsed,
        publishedByUserId: actor.id,
        publishedAt: new Date().toISOString(),
      });
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: job,
        message: "Job opening created successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  updateJobStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = String(req.params["jobId"] ?? "");
      if (!jobId) throw ApiError.badRequest("Job ID is required.");
      const status = req.body.status as "open" | "closed" | "draft";
      const job = await this.placementService.updateJobStatus(jobId, status);
      sendSuccess(res, { data: job, message: "Job status updated." });
    } catch (err) {
      next(err);
    }
  };

  // Applications
  applyForJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = String(req.params["jobId"] ?? "");
      if (!jobId) throw ApiError.badRequest("Job ID is required.");
      const actor = getActor(req);
      const parsed = applyJobSchema.parse(req.body);
      const app = await this.placementService.applyForJob(actor.id, jobId, parsed);
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: app,
        message: "Application submitted successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  getMyApplications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      const apps = await this.placementService.getStudentApplications(actor.id);
      sendSuccess(res, { data: apps });
    } catch (err) {
      next(err);
    }
  };

  getJobApplications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = String(req.params["jobId"] ?? "");
      if (!jobId) throw ApiError.badRequest("Job ID is required.");
      const apps = await this.placementService.getJobApplications(jobId);
      sendSuccess(res, { data: apps });
    } catch (err) {
      next(err);
    }
  };

  updateApplicationStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!id) throw ApiError.badRequest("Application ID is required.");
      const parsed = updateApplicationStatusSchema.parse(req.body);
      const app = await this.placementService.updateApplicationStatus(id, parsed.status);
      sendSuccess(res, { data: app, message: "Application status updated." });
    } catch (err) {
      next(err);
    }
  };

  // Mock Interviews
  getMyMockInterviews = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      const interviews = await this.placementService.getStudentMockInterviews(actor.id);
      sendSuccess(res, { data: interviews });
    } catch (err) {
      next(err);
    }
  };

  getTeacherMockInterviews = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      const interviews = await this.placementService.getTeacherMockInterviews(actor.id);
      sendSuccess(res, { data: interviews });
    } catch (err) {
      next(err);
    }
  };

  getAllMockInterviews = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const interviews = await this.placementService.getAllMockInterviews();
      sendSuccess(res, { data: interviews });
    } catch (err) {
      next(err);
    }
  };

  scheduleMockInterview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = scheduleMockInterviewSchema.parse(req.body);
      const interview = await this.placementService.scheduleMockInterview({
        ...parsed,
        interviewStatus: "scheduled",
      });
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: interview,
        message: "Mock interview scheduled.",
      });
    } catch (err) {
      next(err);
    }
  };

  evaluateMockInterview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!id) throw ApiError.badRequest("Mock Interview ID is required.");
      const actor = getActor(req);
      const parsed = evaluateMockInterviewSchema.parse(req.body);

      const interview = await this.placementService.evaluateMockInterview(
        id,
        actor.id,
        actor.role,
        parsed.overallScore,
        parsed.feedback,
        parsed.status
      );
      sendSuccess(res, { data: interview, message: "Mock interview evaluation recorded." });
    } catch (err) {
      next(err);
    }
  };

  // Questions
  getQuestions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const category = typeof req.query["category"] === "string" ? req.query["category"] : undefined;
      const questions = await this.placementService.getQuestions(category);
      sendSuccess(res, { data: questions });
    } catch (err) {
      next(err);
    }
  };

  addQuestion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = addQuestionSchema.parse(req.body);
      const actor = getActor(req);
      const q = await this.placementService.addQuestion({
        ...parsed,
        createdByUserId: actor.id,
      });
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: q,
        message: "Question added to question bank.",
      });
    } catch (err) {
      next(err);
    }
  };

  // Placements
  getPlacements = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const records = await this.placementService.getPlacements();
      sendSuccess(res, { data: records });
    } catch (err) {
      next(err);
    }
  };

  createPlacement = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const record = await this.placementService.createPlacement(req.body);
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: record,
        message: "Placement record added.",
      });
    } catch (err) {
      next(err);
    }
  };
}
