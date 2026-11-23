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
      const ticket = await this.supportService.updateTicketStatus(id, parsed.status, parsed.assignedToUserId);
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
      const notif = await this.supportService.createNotification(parsed);
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
      const notif = await this.supportService.createNotification({
        recipientUserId: actor.id,
        notificationType: parsed.notificationType,
        title: parsed.title,
        messageBody: parsed.messageBody,
        priority: parsed.priority,
      });
      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: notif,
        message: "Broadcast notification dispatched.",
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
