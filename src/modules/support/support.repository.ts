import type {
  AuditLogEntry,
  InAppNotification,
  SupportTicket,
  SystemSetting,
  TicketReply,
} from "./support.types";

export interface SupportRepository {
  // Tickets
  createTicket(ticket: Omit<SupportTicket, "id" | "createdAt" | "replies">): Promise<SupportTicket>;
  getTicketById(id: string): Promise<SupportTicket | null>;
  getTicketsByStudent(studentUserId: string): Promise<SupportTicket[]>;
  getAllTickets(filter?: { status?: string; category?: string }): Promise<SupportTicket[]>;
  updateTicketStatus(
    id: string,
    status: "open" | "in_progress" | "resolved" | "closed",
    assignedToUserId?: string
  ): Promise<SupportTicket>;

  // Replies
  addReply(reply: Omit<TicketReply, "id" | "repliedAt">): Promise<TicketReply>;
  getRepliesByTicket(ticketId: string, includeInternal?: boolean): Promise<TicketReply[]>;

  // Notifications
  createNotification(notif: Omit<InAppNotification, "id" | "createdAt">): Promise<InAppNotification>;
  getNotificationsByUser(userId: string): Promise<InAppNotification[]>;
  markNotificationAsRead(id: string, userId: string): Promise<void>;
  markAllNotificationsAsRead(userId: string): Promise<void>;

  // Audit Logs
  createAuditLog(log: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry>;
  getAuditLogs(limit?: number): Promise<AuditLogEntry[]>;

  // System Settings
  getSettings(): Promise<SystemSetting[]>;
  getSettingByKey(key: string): Promise<SystemSetting | null>;
  updateSetting(key: string, value: string, updatedByUserId: string): Promise<SystemSetting>;
}
