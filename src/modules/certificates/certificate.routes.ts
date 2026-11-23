import { Router, type RequestHandler } from "express";
import { CertificateController } from "./certificate.controller";
import { CertificateService } from "./certificate.service";
import type { CertificateRepository } from "./certificate.repository";
import { requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES } from "../../contracts/user.contract";

export interface CertificateRoutesOptions {
  certificates: CertificateRepository;
  authenticate?: RequestHandler;
}

export function createCertificateRoutes(options: CertificateRoutesOptions): Router {
  const router = Router();
  const service = new CertificateService(options.certificates);
  const controller = new CertificateController(service);

  const studentGuards = options.authenticate ? [options.authenticate, requireRoles(["student"])] : [requireRoles(["student"])];
  const adminGuards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];

  // Public verification endpoint
  router.get("/public/verify/:code", controller.verifyPublic);

  // Student endpoints
  router.get("/my", ...studentGuards, controller.getMyCertificates);
  router.get("/eligibility/:courseId", ...studentGuards, controller.checkEligibility);

  // Admin / Super Admin endpoints
  router.get("/admin/all", ...adminGuards, controller.getAll);
  router.post("/issue", ...adminGuards, controller.issue);
  router.post("/:id/revoke", ...adminGuards, controller.revoke);

  return router;
}
