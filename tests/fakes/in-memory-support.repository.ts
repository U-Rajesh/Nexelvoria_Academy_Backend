import { SupportRuleError, type SupportRepository, type TicketStatusValue } from "../../src/modules/support/support.repository";
import type {
  AuditLogEntry,
  BroadcastAudience,
  InAppNotification,
  ConversationSummary,
  DirectMessage,
  MessageContact,
  NotificationHistoryFilter,
  NotificationHistoryRow,
  SupportCategoryAdmin,
  SupportTicket,
  SupportTicketCategory,
  SystemSetting,
  TicketReply,
  TicketStatusChange,
} from "../../src/modules/support/support.types";
import { istDayStartUtc } from "../../src/modules/reports/reports.rules";
import { DuplicateRecordError, RecordNotFoundError } from "../../src/repositories/repository.errors";

/**
 * Mirrors SqlServerSupportRepository: numeric identity ids, categories must
 * exist and be active, settings are updated (never created), status changes
 * write history, a no-op writes nothing.
 */
export class InMemorySupportRepository implements SupportRepository {
  tickets: SupportTicket[] = [];
  replies: TicketReply[] = [];
  notifications: InAppNotification[] = [];
  auditLogs: AuditLogEntry[] = [];
  settings: SystemSetting[] = [];
  /** Stands in for NXA_SupportTicketCategories. */
  categories: Array<SupportTicketCategory & { isActive: boolean }> = [];
  /** Stands in for NXA_SupportTicketStatusHistory. */
  statusHistory: Array<{ ticketId: string; previousStatus: string | null; newStatus: string; changedByUserId: string; changedAt?: string }> = [];
  /** Display names for history and notification views (stands in for NXA_Users.FullName). */
  userNames: Record<string, string> = {};
  /** When true the next category audit write fails and the change is discarded. */
  failCategoryAudit = false;
  private categorySeq = 100;
  /** Users per role code, for broadcasts and assignee checks (stands in for NXA_UserRoles). */
  usersByRole: Record<string, string[]> = {};

  private seq = 1000;
  private nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  reset(): void {
    this.tickets = [];
    this.replies = [];
    this.notifications = [];
    this.auditLogs = [];
    this.settings = [];
    this.categories = [];
    this.statusHistory = [];
    this.usersByRole = {};
    this.userNames = {};
    this.failCategoryAudit = false;
    this.messages = [];
    this.inactiveUserIds = new Set();
  }

  /** COM-010: stands in for NXA_Messages. */
  messages: DirectMessage[] = [];
  /** Users that are not active (cannot receive messages). */
  inactiveUserIds = new Set<string>();
  private messageSeq = 5000;

  private roleOf(userId: string): string {
    return Object.entries(this.usersByRole).find(([, ids]) => ids.includes(userId))?.[0] ?? "student";
  }

  async listMessageContacts(): Promise<MessageContact[]> {
    return [...(this.usersByRole["admin"] ?? []), ...(this.usersByRole["super_admin"] ?? [])]
      .filter((id) => !this.inactiveUserIds.has(id))
      .map((id) => ({ userId: id, name: this.userNames[id] ?? `User ${id}` }));
  }

  async listConversations(userId: string): Promise<ConversationSummary[]> {
    const mine = this.messages.filter((m) => m.senderUserId === userId || m.recipientUserId === userId);
    const others = [...new Set(mine.map((m) => (m.senderUserId === userId ? m.recipientUserId : m.senderUserId)))];
    return others
      .map((other) => {
        const conv = mine.filter((m) => m.senderUserId === other || m.recipientUserId === other);
        const last = conv[conv.length - 1]!;
        return {
          userId: other,
          name: this.userNames[other] ?? `User ${other}`,
          lastMessage: last.body,
          lastSentAt: last.sentAt,
          unreadCount: conv.filter((m) => m.recipientUserId === userId && !m.readAt).length,
        };
      })
      .sort((a, b) => b.lastSentAt.localeCompare(a.lastSentAt));
  }

  async getConversation(userId: string, otherUserId: string): Promise<DirectMessage[]> {
    return this.messages.filter(
      (m) => (m.senderUserId === userId && m.recipientUserId === otherUserId) || (m.senderUserId === otherUserId && m.recipientUserId === userId),
    );
  }

  async sendMessage(senderUserId: string, recipientUserId: string, body: string, audit: boolean): Promise<DirectMessage> {
    if (senderUserId === recipientUserId) throw new SupportRuleError("MESSAGING_NOT_ALLOWED", "You cannot message yourself.", 422);
    const known = Object.values(this.usersByRole).flat();
    if (!known.includes(recipientUserId) || this.inactiveUserIds.has(recipientUserId)) {
      throw new SupportRuleError("RECIPIENT_NOT_FOUND", "The recipient does not exist or is not active.");
    }
    const staff = (r: string) => r === "admin" || r === "super_admin";
    const s = this.roleOf(senderUserId);
    const r = this.roleOf(recipientUserId);
    if (!((s === "student" && staff(r)) || (staff(s) && r === "student"))) {
      throw new SupportRuleError("MESSAGING_NOT_ALLOWED", "Messages can only be exchanged between a student and the Admin team.", 403);
    }
    const msg: DirectMessage = { id: String(++this.messageSeq), senderUserId, recipientUserId, body, sentAt: new Date(Date.now() + this.messageSeq).toISOString() };
    this.messages.push(msg);
    if (audit) {
      await this.createAuditLog({ moduleCode: "COMMUNICATION", actionType: "SEND_MESSAGE", entityName: "Message", entityId: msg.id, actorUserId: senderUserId, newValues: JSON.stringify({ recipientUserId }) } as never);
    }
    return msg;
  }

  async markConversationRead(userId: string, otherUserId: string): Promise<number> {
    let n = 0;
    for (const m of this.messages) {
      if (m.recipientUserId === userId && m.senderUserId === otherUserId && !m.readAt) {
        m.readAt = new Date().toISOString();
        n++;
      }
    }
    return n;
  }

  async getAllCategories(): Promise<SupportCategoryAdmin[]> {
    return [...this.categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c }));
  }

  async createCategory(name: string, actorUserId: string): Promise<SupportCategoryAdmin> {
    if (this.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new SupportRuleError("CATEGORY_EXISTS", "A category with this name already exists.", 409);
    }
    if (this.failCategoryAudit) throw new Error("audit write failed");
    const category = { id: String(++this.categorySeq), name, isActive: true };
    this.categories.push(category);
    await this.createAuditLog({ actorUserId, actionType: "CREATE_SUPPORT_CATEGORY", moduleCode: "SUPPORT", entityName: "SupportTicketCategory", entityId: category.id, newValues: JSON.stringify({ name, isActive: true }) } as never);
    return { ...category };
  }

  async updateCategory(id: string, changes: { name?: string | undefined; isActive?: boolean | undefined }, actorUserId: string) {
    const c = this.categories.find((x) => x.id === id);
    if (!c) throw new RecordNotFoundError("support category", id);
    const after = { name: changes.name ?? c.name, isActive: changes.isActive ?? c.isActive };
    if (after.name === c.name && after.isActive === c.isActive) return { category: { ...c }, changed: false };
    if (after.name !== c.name && this.categories.some((x) => x.id !== id && x.name.toLowerCase() === after.name.toLowerCase())) {
      throw new SupportRuleError("CATEGORY_EXISTS", "A category with this name already exists.", 409);
    }
    if (this.failCategoryAudit) throw new Error("audit write failed");
    const diff = (["name", "isActive"] as const).filter((k) => after[k] !== c[k]);
    const action = diff.length === 1 && diff[0] === "isActive" ? (after.isActive ? "ACTIVATE_SUPPORT_CATEGORY" : "DEACTIVATE_SUPPORT_CATEGORY") : "UPDATE_SUPPORT_CATEGORY";
    await this.createAuditLog({
      actorUserId,
      actionType: action,
      moduleCode: "SUPPORT",
      entityName: "SupportTicketCategory",
      entityId: id,
      oldValues: JSON.stringify(Object.fromEntries(diff.map((k) => [k, c[k]]))),
      newValues: JSON.stringify(Object.fromEntries(diff.map((k) => [k, after[k]]))),
    } as never);
    Object.assign(c, after);
    return { category: { ...c }, changed: true };
  }

  async getTicketStatusHistory(ticketId: string): Promise<TicketStatusChange[]> {
    if (!this.tickets.some((t) => t.id === ticketId)) throw new RecordNotFoundError("support ticket", ticketId);
    return this.statusHistory
      .filter((h) => h.ticketId === ticketId)
      .map((h, i) => ({
        id: String(i + 1),
        ...(h.previousStatus ? { previousStatus: h.previousStatus } : {}),
        newStatus: h.newStatus,
        changedByUserId: h.changedByUserId,
        ...(this.userNames[h.changedByUserId] ? { changedByName: this.userNames[h.changedByUserId] } : {}),
        changedAt: h.changedAt ?? new Date(0).toISOString(),
      }));
  }

  async getNotificationHistory(filter: NotificationHistoryFilter): Promise<{ rows: NotificationHistoryRow[]; total: number }> {
    const all = this.notifications
      .filter((n) => !filter.recipientUserId || n.recipientUserId === filter.recipientUserId)
      .filter((n) => !filter.notificationType || n.notificationType === filter.notificationType)
      .filter((n) => !filter.from || Date.parse(n.createdAt) >= istDayStartUtc(filter.from).getTime())
      .filter((n) => !filter.to || Date.parse(n.createdAt) < istDayStartUtc(filter.to, 1).getTime())
      .filter((n) => {
        if (!filter.search) return true;
        const q = filter.search.toLowerCase();
        return [n.title, n.messageBody, this.userNames[n.recipientUserId] ?? ""].some((t) => t.toLowerCase().includes(q));
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(b.id) - Number(a.id));
    const rows = all.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize).map((n) => ({
      ...n,
      ...(this.userNames[n.recipientUserId] ? { recipientName: this.userNames[n.recipientUserId] } : {}),
    }));
    return { rows, total: all.length };
  }

  async getActiveCategories(): Promise<SupportTicketCategory[]> {
    return this.categories.filter((c) => c.isActive).map(({ id, name }) => ({ id, name }));
  }

  async createTicket(ticket: Omit<SupportTicket, "id" | "createdAt" | "replies">): Promise<SupportTicket> {
    const category = this.categories.find((c) => c.id === ticket.categoryId && c.isActive);
    if (!category) throw new SupportRuleError("CATEGORY_NOT_FOUND", "The selected support category does not exist or is inactive.");
    if (this.tickets.some((t) => t.ticketNumber === ticket.ticketNumber)) {
      throw new DuplicateRecordError("support ticket", "ticketNumber", ticket.ticketNumber);
    }
    const newTicket: SupportTicket = {
      ...ticket,
      categoryName: category.name,
      id: this.nextId(),
      createdAt: new Date().toISOString(),
      replies: [],
    };
    this.tickets.push(newTicket);
    this.statusHistory.push({ ticketId: newTicket.id, previousStatus: null, newStatus: ticket.ticketStatus, changedByUserId: ticket.studentUserId, changedAt: new Date().toISOString() });
    return { ...newTicket };
  }

  async getTicketById(id: string): Promise<SupportTicket | null> {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) return null;
    return { ...ticket, replies: await this.getRepliesByTicket(id, true) };
  }

  async getTicketsByStudent(studentUserId: string): Promise<SupportTicket[]> {
    return this.tickets.filter((t) => t.studentUserId === studentUserId).map((t) => ({ ...t }));
  }

  async getAllTickets(filter?: { status?: string; category?: string }): Promise<SupportTicket[]> {
    return this.tickets
      .filter((t) => (filter?.status ? t.ticketStatus === filter.status.toLowerCase() : true))
      .filter((t) => (filter?.category !== undefined ? t.categoryId === filter.category : true))
      .map((t) => ({ ...t }));
  }

  async updateTicketStatus(
    id: string,
    status: TicketStatusValue,
    changedByUserId: string,
    assignedToUserId?: string,
  ): Promise<SupportTicket> {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) throw new RecordNotFoundError("support ticket", id);
    if (assignedToUserId !== undefined) {
      const staff = [...(this.usersByRole["admin"] ?? []), ...(this.usersByRole["super_admin"] ?? [])];
      if (!staff.includes(assignedToUserId)) {
        throw new SupportRuleError("ASSIGNEE_NOT_STAFF", "Tickets can be assigned only to an Admin or Super Admin.");
      }
    }
    const statusChanged = ticket.ticketStatus !== status;
    const assigneeChanged = assignedToUserId !== undefined && ticket.assignedToUserId !== assignedToUserId;
    if (statusChanged || assigneeChanged) {
      if (statusChanged) {
        this.statusHistory.push({ ticketId: id, previousStatus: ticket.ticketStatus, newStatus: status, changedByUserId, changedAt: new Date().toISOString() });
      }
      ticket.ticketStatus = status;
      if (assignedToUserId !== undefined) ticket.assignedToUserId = assignedToUserId;
      ticket.closedAt = status === "resolved" || status === "closed" ? (ticket.closedAt ?? new Date().toISOString()) : undefined;
      await this.createAuditLog({ moduleCode: "SUPPORT_MGMT", actionType: "UPDATE_SUPPORT_TICKET", entityName: "SupportTicket", entityId: id, actorUserId: changedByUserId });
    }
    return (await this.getTicketById(id))!;
  }

  async addReply(reply: Omit<TicketReply, "id" | "repliedAt">, options: { staffReply: boolean }): Promise<TicketReply> {
    const ticket = this.tickets.find((t) => t.id === reply.ticketId);
    if (!ticket) throw new RecordNotFoundError("support ticket", reply.ticketId);
    const newReply: TicketReply = { ...reply, id: this.nextId(), repliedAt: new Date().toISOString() };
    this.replies.push(newReply);
    if (options.staffReply && ticket.ticketStatus === "open") {
      this.statusHistory.push({ ticketId: ticket.id, previousStatus: "open", newStatus: "in_progress", changedByUserId: reply.repliedByUserId, changedAt: new Date().toISOString() });
      ticket.ticketStatus = "in_progress";
    }
    return newReply;
  }

  async getRepliesByTicket(ticketId: string, includeInternal = true): Promise<TicketReply[]> {
    return this.replies.filter((r) => r.ticketId === ticketId && (includeInternal || !r.isInternal));
  }

  async createNotification(notif: Omit<InAppNotification, "id" | "createdAt">, actorUserId?: string): Promise<InAppNotification> {
    const newNotif: InAppNotification = { ...notif, id: this.nextId(), createdAt: new Date().toISOString() };
    this.notifications.push(newNotif);
    if (actorUserId) {
      await this.createAuditLog({ moduleCode: "COMMUNICATION", actionType: "SEND_NOTIFICATION", entityName: "Notification", entityId: newNotif.id, actorUserId } as never);
    }
    return newNotif;
  }

  async broadcastNotification(
    audience: BroadcastAudience,
    notif: Omit<InAppNotification, "id" | "createdAt" | "recipientUserId">,
    actorUserId: string,
  ): Promise<{ recipientCount: number }> {
    const recipients = [...new Set([...new Set(audience)].flatMap((role) => this.usersByRole[role] ?? []))];
    for (const recipientUserId of recipients) await this.createNotification({ ...notif, recipientUserId });
    await this.createAuditLog({ moduleCode: "COMMUNICATION", actionType: "BROADCAST_NOTIFICATION", entityName: "Notification", entityId: "broadcast", actorUserId });
    return { recipientCount: recipients.length };
  }

  async getNotificationsByUser(userId: string): Promise<InAppNotification[]> {
    return this.notifications.filter((n) => n.recipientUserId === userId);
  }

  async markNotificationAsRead(id: string, userId: string): Promise<boolean> {
    const notif = this.notifications.find((n) => n.id === id && n.recipientUserId === userId);
    if (!notif) return false;
    notif.readAt = notif.readAt ?? new Date().toISOString();
    return true;
  }

  async markAllNotificationsAsRead(userId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const notif of this.notifications) {
      if (notif.recipientUserId === userId && !notif.readAt) notif.readAt = now;
    }
  }

  async createAuditLog(log: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = { ...log, id: this.nextId(), createdAt: new Date().toISOString() };
    this.auditLogs.push(entry);
    return entry;
  }

  async getAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    return [...this.auditLogs].reverse().slice(0, limit);
  }

  async getSettings(): Promise<SystemSetting[]> {
    return this.settings.map((s) => ({ ...s, settingValue: s.isSecret ? "********" : s.settingValue }));
  }

  async getSettingByKey(key: string): Promise<SystemSetting | null> {
    const s = this.settings.find((x) => x.settingKey === key);
    return s ? { ...s, settingValue: s.isSecret ? "********" : s.settingValue } : null;
  }

  async updateSetting(key: string, value: string, updatedByUserId: string): Promise<SystemSetting> {
    const s = this.settings.find((x) => x.settingKey === key);
    if (!s) throw new RecordNotFoundError("setting", key);
    if (s.settingValue !== value) {
      s.settingValue = value;
      s.updatedByUserId = updatedByUserId;
      s.updatedAt = new Date().toISOString();
      await this.createAuditLog({ moduleCode: "INSTITUTE_SETTINGS", actionType: "UPDATE_SETTING", entityName: "InstituteSetting", entityId: key, actorUserId: updatedByUserId });
    }
    return (await this.getSettingByKey(key))!;
  }
}
