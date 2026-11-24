import { Router, type RequestHandler } from "express";
import { PlacementController } from "./placement.controller";
import { PlacementService } from "./placement.service";
import type { PlacementRepository } from "./placement.repository";
import type { EnrollmentRepository } from "../enrollments/enrollment.repository";
import type { UserRepository } from "../users/user.repository";
import { requireAuth, requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES } from "../../contracts/user.contract";

export interface PlacementRoutesOptions {
  placements: PlacementRepository;
  /** BR-013 eligibility source (ACTIVE enrollments). Absent: no student is eligible. */
  enrollments?: EnrollmentRepository | undefined;
  /** Role checks for mock interview participants. Absent: scheduling is refused. */
  users?: UserRepository | undefined;
  authenticate?: RequestHandler;
}

export function createPlacementRoutes(options: PlacementRoutesOptions): Router {
  const router = Router();
  const service = new PlacementService(options.placements, options.enrollments, options.users);
  const controller = new PlacementController(service);

  const authGuards = options.authenticate ? [options.authenticate, requireAuth] : [requireAuth];
  const studentGuards = options.authenticate ? [options.authenticate, requireRoles(["student"])] : [requireRoles(["student"])];
  const teacherGuards = options.authenticate ? [options.authenticate, requireRoles(["teacher", ...ADMIN_ROLES])] : [requireRoles(["teacher", ...ADMIN_ROLES])];
  const adminGuards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];

  // Companies (PLC-001). Never deleted here; NXA_Companies is shared with CMS hiring partners.
  router.get("/companies", controller.getCompanies);
  router.post("/companies", ...adminGuards, controller.createCompany);
  router.patch("/companies/:id", ...adminGuards, controller.updateCompany);
  router.patch("/companies/:id/status", ...adminGuards, controller.setCompanyStatus);
  // Employer feedback (PLC-012)
  router.get("/feedback", ...adminGuards, controller.getFeedback);
  router.post("/companies/:id/feedback", ...adminGuards, controller.createFeedback);

  // Jobs (PLC-002)
  // Public: open jobs only (SEC API authorization: drafts are never public).
  router.get("/jobs", controller.getJobs);
  router.get("/jobs/:jobId", controller.getJobById);
  // Admin: every job, including drafts and closed ones.
  router.get("/admin/jobs", ...adminGuards, controller.getAdminJobs);
  router.get("/admin/jobs/:jobId", ...adminGuards, controller.getAdminJobById);
  router.post("/jobs", ...adminGuards, controller.createJob);
  router.patch("/jobs/:jobId", ...adminGuards, controller.updateJob);
  router.patch("/jobs/:jobId/status", ...adminGuards, controller.updateJobStatus);
  // PLC-003 read-only: the criterion vocabulary is not approved.
  router.get("/jobs/:jobId/eligibility", ...adminGuards, controller.getJobEligibility);
  // Placement alert (in-app) to eligible students.
  router.post("/jobs/:jobId/announce", ...adminGuards, controller.announceJob);

  // Job Applications (PLC-004 / PLC-005)
  router.post("/jobs/:jobId/apply", ...studentGuards, controller.applyForJob);
  router.get("/applications/my", ...studentGuards, controller.getMyApplications);
  router.get("/applications", ...adminGuards, controller.getApplications);
  router.get("/jobs/:jobId/applications", ...adminGuards, controller.getJobApplications);
  router.patch("/applications/:id/status", ...adminGuards, controller.updateApplicationStatus);
  router.get("/applications/:id/history", ...adminGuards, controller.getApplicationHistory);
  // Interview rounds (PLC-006)
  router.get("/applications/:id/rounds", ...adminGuards, controller.getInterviewRounds);
  router.post("/applications/:id/rounds", ...adminGuards, controller.createInterviewRound);
  router.patch("/rounds/:id", ...adminGuards, controller.updateInterviewRound);
  // Offers (PLC-007, without the letter file)
  router.get("/offers", ...adminGuards, controller.getOffers);
  router.get("/applications/:id/offers", ...adminGuards, controller.getApplicationOffers);
  router.post("/applications/:id/offers", ...adminGuards, controller.createOffer);

  // Mock Interviews (PLC-009 / PLC-010)
  router.get("/mock-interviews/my", ...studentGuards, controller.getMyMockInterviews);
  router.get("/mock-interviews/teacher", ...teacherGuards, controller.getTeacherMockInterviews);
  router.get("/mock-interviews/all", ...adminGuards, controller.getAllMockInterviews);
  router.post("/mock-interviews/schedule", ...authGuards, controller.scheduleMockInterview);
  router.post("/mock-interviews/:id/evaluate", ...teacherGuards, controller.evaluateMockInterview);

  // Questions (PLC-011)
  router.get("/questions", ...authGuards, controller.getQuestions);
  router.post("/questions", ...teacherGuards, controller.addQuestion);
  router.patch("/questions/:id", ...adminGuards, controller.updateQuestion);
  router.patch("/questions/:id/status", ...adminGuards, controller.setQuestionStatus);

  // Placement Records (PLC-008)
  // Placement records name individual students, so they are not public: no
  // approved requirement exposes them (Admin / Super Admin only).
  router.get("/records", ...adminGuards, controller.getPlacements);
  router.post("/records", ...adminGuards, controller.createPlacement);
  router.patch("/records/:id/verify", ...adminGuards, controller.verifyPlacement);

  // Analytics (PLC-013) and read-only package data
  router.get("/analytics", ...adminGuards, controller.getAnalytics);
  router.get("/packages", ...adminGuards, controller.getPackages);
  router.get("/student-packages", ...adminGuards, controller.getStudentPackages);

  return router;
}
