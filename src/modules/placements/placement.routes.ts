import { Router, type RequestHandler } from "express";
import { PlacementController } from "./placement.controller";
import { PlacementService } from "./placement.service";
import type { PlacementRepository } from "./placement.repository";
import { requireAuth, requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES } from "../../contracts/user.contract";

export interface PlacementRoutesOptions {
  placements: PlacementRepository;
  authenticate?: RequestHandler;
}

export function createPlacementRoutes(options: PlacementRoutesOptions): Router {
  const router = Router();
  const service = new PlacementService(options.placements);
  const controller = new PlacementController(service);

  const authGuards = options.authenticate ? [options.authenticate, requireAuth] : [requireAuth];
  const studentGuards = options.authenticate ? [options.authenticate, requireRoles(["student"])] : [requireRoles(["student"])];
  const teacherGuards = options.authenticate ? [options.authenticate, requireRoles(["teacher", ...ADMIN_ROLES])] : [requireRoles(["teacher", ...ADMIN_ROLES])];
  const adminGuards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];

  // Companies
  router.get("/companies", controller.getCompanies);
  router.post("/companies", ...adminGuards, controller.createCompany);

  // Jobs
  router.get("/jobs", controller.getJobs);
  router.get("/jobs/:jobId", controller.getJobById);
  router.post("/jobs", ...adminGuards, controller.createJob);
  router.patch("/jobs/:jobId/status", ...adminGuards, controller.updateJobStatus);

  // Job Applications
  router.post("/jobs/:jobId/apply", ...studentGuards, controller.applyForJob);
  router.get("/applications/my", ...studentGuards, controller.getMyApplications);
  router.get("/jobs/:jobId/applications", ...adminGuards, controller.getJobApplications);
  router.patch("/applications/:id/status", ...adminGuards, controller.updateApplicationStatus);

  // Mock Interviews
  router.get("/mock-interviews/my", ...studentGuards, controller.getMyMockInterviews);
  router.get("/mock-interviews/teacher", ...teacherGuards, controller.getTeacherMockInterviews);
  router.get("/mock-interviews/all", ...adminGuards, controller.getAllMockInterviews);
  router.post("/mock-interviews/schedule", ...authGuards, controller.scheduleMockInterview);
  router.post("/mock-interviews/:id/evaluate", ...teacherGuards, controller.evaluateMockInterview);

  // Questions
  router.get("/questions", ...authGuards, controller.getQuestions);
  router.post("/questions", ...teacherGuards, controller.addQuestion);

  // Placement Records
  router.get("/records", controller.getPlacements);
  router.post("/records", ...adminGuards, controller.createPlacement);

  return router;
}
