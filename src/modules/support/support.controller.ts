import type { NotificationHistoryFilter } from "./support.types";
import type { Request, Response, NextFunction } from "express";
import type { SupportService } from "./support.service";
import {
  addReplySchema,
  broadcastNotificationSchema,
  createNotificationSchema,
  createTicketSchema,
  updateSettingSchema,
  updateTicketStatusSchema,
} from "./support.validation";
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

export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // Tickets
  createTicket = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      const parsed = createTicketSchema.parse(req.body);
      const ticket = await this.supportService.createTicket(actor.id, parsed);
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: ticket,
        message: "Support ticket created.",
      });
    } catch (err) {
      next(err);
    }
  };

  getMyTickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      const tickets = await this.supportService.getStudentTickets(actor.id);
      sendSuccess(res, { data: tickets });
    } catch (err) {
      next(err);
    }
  };

  getAllTickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const filter: { status?: string; category?: string } = {};
      if (typeof req.query["status"] === "string") filter.status = req.query["status"];
      if (typeof req.query["category"] === "string") filter.category = req.query["category"];
      const tickets = await this.supportService.getAllTickets(filter);
      sendSuccess(res, { data: tickets });
    } catch (err) {
      next(err);
    }
  };

  getTicketById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!id) throw ApiError.badRequest("Ticket ID is required.");
      const actor = getActor(req);
      const ticket = await this.supportService.getTicketById(id, actor.id, actor.role);
      sendSuccess(res, { data: ticket });
    } catch (err) {
      next(err);
    }
  };

  updateTicketStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!id) throw ApiError.badRequest("Ticket ID is required.");
      const parsed = updateTicketStatusSchema.parse(req.body);
      const ticket = await this.supportService.updateTicketStatus(id, parsed.status, getActor(req).id, parsed.assignedToUserId);
      sendSuccess(res, { data: ticket, message: "Ticket status updated." });
    } catch (err) {
      next(err);
    }
  };

  addReply = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!id) throw ApiError.badRequest("Ticket ID is required.");
      const actor = getActor(req);
      const parsed = addReplySchema.parse(req.body);
      const reply = await this.supportService.addReply(id, actor.id, actor.role, parsed);
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: reply,
        message: "Reply added.",
      });
    } catch (err) {
      next(err);
    }
  };

  // ---- COM-010 messaging (every call is scoped to the signed-in user's own conversations)
  getMessageContacts = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      sendSuccess(res, { data: await this.supportService.listMessageContacts() });
    } catch (err) {
      next(err);
    }
  };

  getConversations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      sendSuccess(res, { data: await this.supportService.listConversations(getActor(req).id) });
    } catch (err) {
      next(err);
    }
  };

  getConversation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      sendSuccess(res, { data: await this.supportService.getConversation(getActor(req).id, String(req.params["userId"])) });
    } catch (err) {
      next(err);
    }
  };

  markConversationRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const marked = await this.supportService.markConversationRead(getActor(req).id, String(req.params["userId"]));
      sendSuccess(res, { data: { marked } });
    } catch (err) {
      next(err);
    }
  };

  sendMessage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const msg = await this.supportService.sendMessage(getActor(req), req.body.recipientUserId, req.body.body);
      sendSuccess(res, { status: HttpStatus.CREATED, data: msg, message: "Message sent." });
    } catch (err) {
      next(err);
    }
  };

  // ---- SUP-006 category management, SUP-005 history, COM-008 notification history
  getAllCategories = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      sendSuccess(res, { data: await this.supportService.getAllCategories() });
    } catch (err) {
      next(err);
    }
  };

  createCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await this.supportService.createCategory(req.body.name, getActor(req).id);
      sendSuccess(res, { status: HttpStatus.CREATED, data, message: "Category created." });
    } catch (err) {
      next(err);
    }
  };

  updateCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { category, changed } = await this.supportService.updateCategory(String(req.params["id"]), req.body, getActor(req).id);
      sendSuccess(res, { data: category, message: changed ? "Category updated." : "No changes: the category already has these values." });
    } catch (err) {
      next(err);
    }
  };

  getTicketStatusHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      sendSuccess(res, { data: await this.supportService.getTicketStatusHistory(String(req.params["id"])) });
    } catch (err) {
      next(err);
    }
  };

  getNotificationHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.validatedQuery as NotificationHistoryFilter;
      const result = await this.supportService.getNotificationHistory(q);
      sendSuccess(res, { data: { ...result, page: q.page, pageSize: q.pageSize, totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)) } });
    } catch (err) {
      next(err);
    }
  };

  getCategories = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      sendSuccess(res, { data: await this.supportService.getCategories() });
    } catch (err) {
      next(err);
    }
  };

  // Notifications
  getMyNotifications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      const notifs = await this.supportService.getUserNotifications(actor.id);
      sendSuccess(res, { data: notifs });
    } catch (err) {
      next(err);
    }
  };

  markAsRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!id) throw ApiError.badRequest("Notification ID is required.");
      const actor = getActor(req);
      await this.supportService.markNotificationAsRead(id, actor.id);
      sendSuccess(res, { message: "Notification marked as read." });
    } catch (err) {
      next(err);
    }
  };

  markAllAsRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      await this.supportService.markAllNotificationsAsRead(actor.id);
      sendSuccess(res, { message: "All notifications marked as read." });
    } catch (err) {
      next(err);
    }
  };

  sendNotification = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createNotificationSchema.parse(req.body);
      const notif = await this.supportService.createNotification(parsed, getActor(req).id);
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: notif,
        message: "Notification sent.",
      });
    } catch (err) {
      next(err);
    }
  };

  broadcast = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = getActor(req);
      const parsed = broadcastNotificationSchema.parse(req.body);
      // One notification per user holding an audience role; the count is real.
      const result = await this.supportService.broadcastNotification(
        parsed.audience,
        {
          notificationType: parsed.notificationType,
          title: parsed.title,
          messageBody: parsed.messageBody,
          priority: parsed.priority,
        },
        actor.id,
      );
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: result,
        message: `Broadcast sent to ${result.recipientCount} recipient(s).`,
      });
    } catch (err) {
      next(err);
    }
  };

  // Audit Logs
  getAuditLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = typeof req.query["limit"] === "string" ? parseInt(req.query["limit"], 10) : 100;
      const logs = await this.supportService.getAuditLogs(limit);
      sendSuccess(res, { data: logs });
    } catch (err) {
      next(err);
    }
  };

  // Settings
  getSettings = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const settings = await this.supportService.getSettings();
      sendSuccess(res, { data: settings });
    } catch (err) {
      next(err);
    }
  };

  updateSetting = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = updateSettingSchema.parse(req.body);
      const actor = getActor(req);
      const setting = await this.supportService.updateSetting(parsed.settingKey, parsed.settingValue, actor.id);
      sendSuccess(res, { data: setting, message: "System setting updated." });
    } catch (err) {
      next(err);
    }
  };
}
