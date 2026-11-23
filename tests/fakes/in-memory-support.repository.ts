import crypto from "node:crypto";
import type { SupportRepository } from "../../src/modules/support/support.repository";
import type {
  AuditLogEntry,
  InAppNotification,
  SupportTicket,
  SystemSetting,
  TicketReply,
} from "../../src/modules/support/support.types";

export class InMemorySupportRepository implements SupportRepository {
  tickets: SupportTicket[] = [];
  replies: TicketReply[] = [];
  notifications: InAppNotification[] = [];
  auditLogs: AuditLogEntry[] = [];
  settings: SystemSetting[] = [];

  reset(): void {
    this.tickets = [];
    this.replies = [];
    this.notifications = [];
    this.auditLogs = [];
    this.settings = [];
  }

  async createTicket(ticket: Omit<SupportTicket, "id" | "createdAt" | "replies">): Promise<SupportTicket> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newTicket: SupportTicket = {
      ...ticket,
      id,
      createdAt: now,
      replies: [],
    };
    this.tickets.push(newTicket);
    return newTicket;
  }

  async getTicketById(id: string): Promise<SupportTicket | null> {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) return null;
    return {
      ...ticket,
      replies: this.replies.filter((r) => r.ticketId === id),
    };
  }

  async getTicketsByStudent(studentUserId: string): Promise<SupportTicket[]> {
    return this.tickets.filter((t) => t.studentUserId === studentUserId);
  }

  async getAllTickets(filter?: { status?: string; category?: string }): Promise<SupportTicket[]> {
    let result = [...this.tickets];
    if (filter?.status) {
      result = result.filter((t) => t.ticketStatus === filter.status);
    }
    if (filter?.category) {
      result = result.filter((t) => t.categoryId === filter.category);
    }
    return result;
  }

  async updateTicketStatus(
    id: string,
    status: "open" | "in_progress" | "resolved" | "closed",
    assignedToUserId?: string
  ): Promise<SupportTicket> {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) throw new Error("Ticket not found.");
    ticket.ticketStatus = status;
    if (assignedToUserId) {
      ticket.assignedToUserId = assignedToUserId;
    }
    if (status === "resolved" || status === "closed") {
      ticket.closedAt = new Date().toISOString();
    }
    return ticket;
  }

  async addReply(reply: Omit<TicketReply, "id" | "repliedAt">): Promise<TicketReply> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newReply: TicketReply = {
      ...reply,
      id,
      repliedAt: now,
    };
    this.replies.push(newReply);
    return newReply;
  }

  async getRepliesByTicket(ticketId: string, includeInternal = true): Promise<TicketReply[]> {
    return this.replies.filter((r) => r.ticketId === ticketId && (includeInternal || !r.isInternal));
  }

  async createNotification(notif: Omit<InAppNotification, "id" | "createdAt">): Promise<InAppNotification> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newNotif: InAppNotification = {
      ...notif,
      id,
      createdAt: now,
    };
    this.notifications.push(newNotif);
    return newNotif;
  }

  async getNotificationsByUser(userId: string): Promise<InAppNotification[]> {
    return this.notifications.filter((n) => n.recipientUserId === userId);
  }

  async markNotificationAsRead(id: string, userId: string): Promise<void> {
    const notif = this.notifications.find((n) => n.id === id && n.recipientUserId === userId);
    if (notif) {
      notif.readAt = new Date().toISOString();
    }
  }

  async markAllNotificationsAsRead(userId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const notif of this.notifications) {
      if (notif.recipientUserId === userId && !notif.readAt) {
        notif.readAt = now;
      }
    }
  }

  async createAuditLog(log: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newLog: AuditLogEntry = {
      ...log,
      id,
      createdAt: now,
    };
    this.auditLogs.push(newLog);
    return newLog;
  }

  async getAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    return this.auditLogs.slice(-limit).reverse();
  }

  async getSettings(): Promise<SystemSetting[]> {
    return [...this.settings];
  }

  async getSettingByKey(key: string): Promise<SystemSetting | null> {
    return this.settings.find((s) => s.settingKey === key) ?? null;
  }

  async updateSetting(key: string, value: string, updatedByUserId: string): Promise<SystemSetting> {
    let setting = this.settings.find((s) => s.settingKey === key);
    const now = new Date().toISOString();
    if (!setting) {
      setting = {
        id: crypto.randomUUID(),
        settingKey: key,
        settingValue: value,
        valueType: "string",
        isSecret: false,
        updatedByUserId,
        updatedAt: now,
      };
      this.settings.push(setting);
    } else {
      setting.settingValue = value;
      setting.updatedByUserId = updatedByUserId;
      setting.updatedAt = now;
    }
    return setting;
  }
}
