import crypto from "node:crypto";
import type { SupportRepository } from "./support.repository";
import type {
  AuditLogEntry,
  InAppNotification,
  SupportTicket,
  SystemSetting,
  TicketReply,
} from "./support.types";
import { ApiError } from "../../utils/api-error";

export class SupportService {
  constructor(private readonly supportRepo: SupportRepository) {}

  // Tickets
  async createTicket(
    studentUserId: string,
    data: {
      categoryId: string;
      subject: string;
      description: string;
      priority: "low" | "medium" | "high" | "urgent";
    }
  ): Promise<SupportTicket> {
    const randomSuffix = crypto.randomBytes(3).toString("hex").toUpperCase();
    const ticketNumber = `TCK-${randomSuffix}`;

    return this.supportRepo.createTicket({
      ticketNumber,
      studentUserId,
      categoryId: data.categoryId,
      subject: data.subject,
      description: data.description,
      priority: data.priority,
      ticketStatus: "open",
    });
  }

  async getTicketById(
    ticketId: string,
    requestingUserId: string,
    role: string
  ): Promise<SupportTicket> {
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) throw ApiError.notFound("Support ticket not found.");

    if (role === "student" && ticket.studentUserId !== requestingUserId) {
      throw ApiError.forbidden("You are not authorized to view this ticket.");
    }

    if (role === "student" && ticket.replies) {
      ticket.replies = ticket.replies.filter((r) => !r.isInternal);
    }

    return ticket;
  }

  async getStudentTickets(studentUserId: string): Promise<SupportTicket[]> {
    return this.supportRepo.getTicketsByStudent(studentUserId);
  }

  async getAllTickets(filter?: { status?: string; category?: string }): Promise<SupportTicket[]> {
    return this.supportRepo.getAllTickets(filter);
  }

  async updateTicketStatus(
    id: string,
    status: "open" | "in_progress" | "resolved" | "closed",
    assignedToUserId?: string
  ): Promise<SupportTicket> {
    return this.supportRepo.updateTicketStatus(id, status, assignedToUserId);
  }

  async addReply(
    ticketId: string,
    userId: string,
    role: string,
    data: { replyText: string; attachmentObjectKey?: string | undefined; isInternal?: boolean }
  ): Promise<TicketReply> {
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) throw ApiError.notFound("Support ticket not found.");

    if (role === "student" && ticket.studentUserId !== userId) {
      throw ApiError.forbidden("You are not authorized to reply to this ticket.");
    }

    const isInternal = role === "student" ? false : Boolean(data.isInternal);

    const reply = await this.supportRepo.addReply({
      ticketId,
      repliedByUserId: userId,
      replyText: data.replyText,
      attachmentObjectKey: data.attachmentObjectKey,
      isInternal,
    });

    if (role !== "student" && ticket.ticketStatus === "open") {
      await this.supportRepo.updateTicketStatus(ticketId, "in_progress");
    }

    return reply;
  }

  // Notifications
  async createNotification(notif: Omit<InAppNotification, "id" | "createdAt">): Promise<InAppNotification> {
    return this.supportRepo.createNotification(notif);
  }

  async getUserNotifications(userId: string): Promise<InAppNotification[]> {
    return this.supportRepo.getNotificationsByUser(userId);
  }

  async markNotificationAsRead(id: string, userId: string): Promise<void> {
    return this.supportRepo.markNotificationAsRead(id, userId);
  }

  async markAllNotificationsAsRead(userId: string): Promise<void> {
    return this.supportRepo.markAllNotificationsAsRead(userId);
  }

  // Audit Logs
  async logAction(log: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry> {
    return this.supportRepo.createAuditLog(log);
  }

  async getAuditLogs(limit?: number): Promise<AuditLogEntry[]> {
    return this.supportRepo.getAuditLogs(limit);
  }

  // System Settings
  async getSettings(): Promise<SystemSetting[]> {
    return this.supportRepo.getSettings();
  }

  async updateSetting(key: string, value: string, updatedByUserId: string): Promise<SystemSetting> {
    return this.supportRepo.updateSetting(key, value, updatedByUserId);
  }
}
