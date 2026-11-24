import crypto from "node:crypto";
import { SupportRuleError, type SupportRepository, type TicketStatusValue } from "./support.repository";
import type {
  AuditLogEntry,
  BroadcastAudience,
  InAppNotification,
  NotificationHistoryFilter,
  SupportTicket,
  SupportTicketCategory,
  SystemSetting,
  TicketReply,
} from "./support.types";
import { ApiError } from "../../utils/api-error";
import { SETTINGS_CATALOG } from "../admin/settings-catalog";
import { DuplicateRecordError, RecordNotFoundError } from "../../repositories/repository.errors";

/** Repository errors -> HTTP: unknown record 404, rule 422/409. */
async function mapErrors<T>(work: () => Promise<T>, notFound = "Support ticket not found."): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof RecordNotFoundError) throw ApiError.notFound(notFound);
    if (err instanceof SupportRuleError) throw new ApiError(err.status, err.message, err.code);
    throw err;
  }
}

const newTicketNumber = (): string => `TCK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

export class SupportService {
  constructor(private readonly supportRepo: SupportRepository) {}

  // Categories
  async getCategories(): Promise<SupportTicketCategory[]> {
    return this.supportRepo.getActiveCategories();
  }

  // SUP-006: Admin category management (audited; deactivate instead of delete)
  getAllCategories() {
    return this.supportRepo.getAllCategories();
  }
  createCategory(name: string, actorUserId: string) {
    return mapErrors(() => this.supportRepo.createCategory(name, actorUserId), "Category not found.");
  }
  updateCategory(id: string, changes: { name?: string | undefined; isActive?: boolean | undefined }, actorUserId: string) {
    return mapErrors(() => this.supportRepo.updateCategory(id, changes, actorUserId), "Category not found.");
  }

  // COM-010: student <-> Admin messaging
  listMessageContacts() {
    return this.supportRepo.listMessageContacts();
  }
  listConversations(userId: string) {
    return this.supportRepo.listConversations(userId);
  }
  getConversation(userId: string, otherUserId: string) {
    return this.supportRepo.getConversation(userId, otherUserId);
  }
  /** Staff sends are audited (ids only); a student's own messages are the record themselves. */
  sendMessage(sender: { id: string; role: string }, recipientUserId: string, body: string) {
    const staff = sender.role === "admin" || sender.role === "super_admin";
    return mapErrors(() => this.supportRepo.sendMessage(sender.id, recipientUserId, body, staff), "Recipient not found.");
  }
  markConversationRead(userId: string, otherUserId: string) {
    return this.supportRepo.markConversationRead(userId, otherUserId);
  }

  // SUP-005: status history of a ticket
  getTicketStatusHistory(ticketId: string) {
    return mapErrors(() => this.supportRepo.getTicketStatusHistory(ticketId));
  }

  // COM-008: notification history across recipients
  getNotificationHistory(filter: NotificationHistoryFilter) {
    return this.supportRepo.getNotificationHistory(filter);
  }

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
    // TicketNumber is unique: a (very unlikely) collision is retried with a new number.
    for (let attempt = 0; ; attempt++) {
      try {
        return await mapErrors(() =>
          this.supportRepo.createTicket({
            ticketNumber: newTicketNumber(),
            studentUserId,
            categoryId: data.categoryId,
            subject: data.subject,
            description: data.description,
            priority: data.priority,
            ticketStatus: "open",
          }),
        );
      } catch (err) {
        if (err instanceof DuplicateRecordError && attempt < 2) continue;
        throw err;
      }
    }
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
    status: TicketStatusValue,
    changedByUserId: string,
    assignedToUserId?: string
  ): Promise<SupportTicket> {
    return mapErrors(() => this.supportRepo.updateTicketStatus(id, status, changedByUserId, assignedToUserId));
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

    // The reply and (for staff) the move to in_progress are one transaction.
    return mapErrors(() =>
      this.supportRepo.addReply(
        {
          ticketId,
          repliedByUserId: userId,
          replyText: data.replyText,
          attachmentObjectKey: data.attachmentObjectKey,
          isInternal,
        },
        { staffReply: role !== "student" },
      ),
    );
  }

  // Notifications
  async createNotification(notif: Omit<InAppNotification, "id" | "createdAt">, actorUserId?: string): Promise<InAppNotification> {
    return mapErrors(() => this.supportRepo.createNotification(notif, actorUserId));
  }

  /** Sends one notification to every user holding an audience role. */
  async broadcastNotification(
    audience: BroadcastAudience,
    notif: Omit<InAppNotification, "id" | "createdAt" | "recipientUserId">,
    actorUserId: string,
  ): Promise<{ recipientCount: number }> {
    return mapErrors(() => this.supportRepo.broadcastNotification(audience, notif, actorUserId));
  }

  async getUserNotifications(userId: string): Promise<InAppNotification[]> {
    return this.supportRepo.getNotificationsByUser(userId);
  }

  async markNotificationAsRead(id: string, userId: string): Promise<void> {
    const found = await this.supportRepo.markNotificationAsRead(id, userId);
    // Another user's notification is indistinguishable from a missing one.
    if (!found) throw ApiError.notFound("Notification not found.");
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
    // Catalog keys have their own validated, audited endpoints (and blocked keys must stay refused);
    // this generic endpoint must not become a way around them.
    const catalogued = SETTINGS_CATALOG.find((s) => s.key === key);
    if (catalogued) {
      const where = key.startsWith("maintenance") ? "PUT /api/v1/super-admin/maintenance" : "PUT /api/v1/admin/settings";
      throw ApiError.validation(
        [{ field: "settingKey", message: catalogued.status === "blocked" ? catalogued.note : `Use ${where} for this setting.` }],
        catalogued.status === "blocked" ? `"${key}" cannot be changed yet.` : `"${key}" is changed through ${where}.`,
      );
    }
    return mapErrors(() => this.supportRepo.updateSetting(key, value, updatedByUserId), "Setting not found.");
  }
}
