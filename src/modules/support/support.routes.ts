import { Router, type RequestHandler } from "express";
import { SupportController } from "./support.controller";
import { SupportService } from "./support.service";
import type { SupportRepository } from "./support.repository";
import { requireAuth, requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES, SUPER_ADMIN_ONLY } from "../../contracts/user.contract";

export interface SupportRoutesOptions {
  support: SupportRepository;
  authenticate?: RequestHandler;
}

export function createSupportRoutes(options: SupportRoutesOptions): Router {
  const router = Router();
  const service = new SupportService(options.support);
  const controller = new SupportController(service);

  const authGuards = options.authenticate ? [options.authenticate, requireAuth] : [requireAuth];
  const studentGuards = options.authenticate ? [options.authenticate, requireRoles(["student"])] : [requireRoles(["student"])];
  const adminGuards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];
  const superAdminGuards = options.authenticate ? [options.authenticate, requireRoles(SUPER_ADMIN_ONLY)] : [requireRoles(SUPER_ADMIN_ONLY)];

  // Student ticket endpoints
  router.post("/tickets", ...studentGuards, controller.createTicket);
  router.get("/tickets/my", ...studentGuards, controller.getMyTickets);
  router.get("/tickets/:id", ...authGuards, controller.getTicketById);
  router.post("/tickets/:id/replies", ...authGuards, controller.addReply);

  // Admin ticket endpoints
  router.get("/admin/tickets", ...adminGuards, controller.getAllTickets);
  router.patch("/admin/tickets/:id/status", ...adminGuards, controller.updateTicketStatus);

  // Notifications
  router.get("/notifications/my", ...authGuards, controller.getMyNotifications);
  router.patch("/notifications/:id/read", ...authGuards, controller.markAsRead);
  router.post("/notifications/read-all", ...authGuards, controller.markAllAsRead);
  router.post("/notifications/send", ...adminGuards, controller.sendNotification);
  router.post("/notifications/broadcast", ...adminGuards, controller.broadcast);

  // Audit Logs (admin/super_admin)
  router.get("/admin/audit-logs", ...adminGuards, controller.getAuditLogs);

  // System Configuration (super_admin / admin read)
  router.get("/admin/system-config", ...adminGuards, controller.getSettings);
  router.put("/admin/system-config", ...superAdminGuards, controller.updateSetting);

  return router;
}
