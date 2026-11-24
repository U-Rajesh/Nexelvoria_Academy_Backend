import { Router, type RequestHandler } from "express";
import { SupportController } from "./support.controller";
import { SupportService } from "./support.service";
import type { SupportRepository } from "./support.repository";
import { requireAuthAllowingLimitedStudent, requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES, SUPER_ADMIN_ONLY } from "../../contracts/user.contract";
import { validate } from "../../middleware/validate.middleware";
import {
  conversationParamsSchema,
  sendMessageSchema,
  categoryIdParamsSchema,
  createCategorySchema,
  notificationHistoryQuerySchema,
  ticketIdParamsSchema,
  updateCategorySchema,
} from "./support.validation";

export interface SupportRoutesOptions {
  support: SupportRepository;
  authenticate?: RequestHandler;
}

export function createSupportRoutes(options: SupportRoutesOptions): Router {
  const router = Router();
  const service = new SupportService(options.support);
  const controller = new SupportController(service);

  // CL-001 allowlist: also open to students whose approval is pending (limited access).
  // Own tickets and own notifications only; ownership is enforced in the service and repository.
  const studentGuards = options.authenticate
    ? [options.authenticate, requireRoles(["student"], { allowLimitedStudent: true })]
    : [requireRoles(["student"], { allowLimitedStudent: true })];
  const ownDataGuards = options.authenticate
    ? [options.authenticate, requireAuthAllowingLimitedStudent]
    : [requireAuthAllowingLimitedStudent];
  const adminGuards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];
  const superAdminGuards = options.authenticate ? [options.authenticate, requireRoles(SUPER_ADMIN_ONLY)] : [requireRoles(SUPER_ADMIN_ONLY)];

  // Student ticket endpoints
  // Active ticket categories (NXA_SupportTicketCategories), needed to raise a ticket.
  router.get("/categories", ...ownDataGuards, controller.getCategories);
  router.post("/tickets", ...studentGuards, controller.createTicket);
  router.get("/tickets/my", ...studentGuards, controller.getMyTickets);
  router.get("/tickets/:id", ...ownDataGuards, controller.getTicketById);
  router.post("/tickets/:id/replies", ...ownDataGuards, controller.addReply);

  // COM-010: student <-> Admin messages. Ownership: every route reads / writes only the caller's
  // conversations; the repository allows only student <-> active Admin / Super Admin pairs.
  router.get("/messages/contacts", ...ownDataGuards, controller.getMessageContacts);
  router.get("/messages/conversations", ...ownDataGuards, controller.getConversations);
  router.get("/messages/conversations/:userId", ...ownDataGuards, validate({ params: conversationParamsSchema }), controller.getConversation);
  router.post("/messages/conversations/:userId/read", ...ownDataGuards, validate({ params: conversationParamsSchema }), controller.markConversationRead);
  router.post("/messages", ...ownDataGuards, validate({ body: sendMessageSchema }), controller.sendMessage);

  // Admin ticket endpoints
  router.get("/admin/tickets", ...adminGuards, controller.getAllTickets);
  router.patch("/admin/tickets/:id/status", ...adminGuards, controller.updateTicketStatus);
  // SUP-005: full status history of a ticket.
  router.get("/admin/tickets/:id/history", ...adminGuards, validate({ params: ticketIdParamsSchema }), controller.getTicketStatusHistory);

  // SUP-006: ticket categories (Admin and Super Admin; deactivate instead of delete).
  router.get("/admin/categories", ...adminGuards, controller.getAllCategories);
  router.post("/admin/categories", ...adminGuards, validate({ body: createCategorySchema }), controller.createCategory);
  router.patch("/admin/categories/:id", ...adminGuards, validate({ params: categoryIdParamsSchema, body: updateCategorySchema }), controller.updateCategory);

  // Notifications
  router.get("/notifications/my", ...ownDataGuards, controller.getMyNotifications);
  router.patch("/notifications/:id/read", ...ownDataGuards, controller.markAsRead);
  router.post("/notifications/read-all", ...ownDataGuards, controller.markAllAsRead);
  router.post("/notifications/send", ...adminGuards, controller.sendNotification);
  router.post("/notifications/broadcast", ...adminGuards, controller.broadcast);
  // COM-008: every notification sent, across recipients (Admin view).
  router.get("/admin/notifications", ...adminGuards, validate({ query: notificationHistoryQuerySchema }), controller.getNotificationHistory);

  // Audit Logs (admin/super_admin)
  router.get("/admin/audit-logs", ...adminGuards, controller.getAuditLogs);

  // System Configuration (super_admin / admin read)
  router.get("/admin/system-config", ...adminGuards, controller.getSettings);
  router.put("/admin/system-config", ...superAdminGuards, controller.updateSetting);

  return router;
}
