/** NXA_SupportTicketCategories (int identity, CategoryName, IsActive). */
export interface SupportTicketCategory {
  id: string;
  name: string;
}

/** COM-010: one row of NXA_Messages between a student and a staff member. */
export interface DirectMessage {
  id: string;
  senderUserId: string;
  recipientUserId: string;
  body: string;
  sentAt: string;
  readAt?: string | undefined;
}

/** A conversation as seen by the caller: the other participant and the latest message. */
export interface ConversationSummary {
  userId: string;
  name: string;
  lastMessage: string;
  lastSentAt: string;
  /** Messages from that participant the caller has not read yet. */
  unreadCount: number;
}

export interface MessageContact {
  userId: string;
  name: string;
}

/** Admin view of a category (SUP-006): inactive ones included. */
export interface SupportCategoryAdmin extends SupportTicketCategory {
  isActive: boolean;
}

/** One row of NXA_SupportTicketStatusHistory (SUP-005). */
export interface TicketStatusChange {
  id: string;
  previousStatus?: string | undefined;
  newStatus: string;
  changedByUserId?: string | undefined;
  changedByName?: string | undefined;
  changeReason?: string | undefined;
  changedAt: string;
}

/** COM-008: notification history across recipients (Admin view). */
export interface NotificationHistoryFilter {
  recipientUserId?: string | undefined;
  notificationType?: string | undefined;
  /** Inclusive IST calendar dates (YYYY-MM-DD). */
  from?: string | undefined;
  to?: string | undefined;
  search?: string | undefined;
  page: number;
  pageSize: number;
}

/** A broadcast audience is a set of role codes (NXA_Roles.RoleCode). */
export type BroadcastAudience = Array<"student" | "teacher" | "admin" | "super_admin">;

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  studentUserId: string;
  studentName?: string | undefined;
  /** NXA_SupportTicketCategories id (numeric). */
  categoryId: string;
  categoryName?: string | undefined;
  subject: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  ticketStatus: 'open' | 'in_progress' | 'resolved' | 'closed';
  assignedToUserId?: string | undefined;
  assignedToName?: string | undefined;
  createdAt: string;
  closedAt?: string | undefined;
  replies?: TicketReply[] | undefined;
}

export interface TicketReply {
  id: string;
  ticketId: string;
  repliedByUserId: string;
  repliedByName?: string | undefined;
  replyText: string;
  attachmentObjectKey?: string | undefined;
  isInternal: boolean;
  repliedAt: string;
}

export interface NotificationHistoryRow extends Omit<InAppNotification, "notificationType" | "priority"> {
  notificationType: string;
  priority: string;
  recipientName?: string | undefined;
}

export interface InAppNotification {
  id: string;
  recipientUserId: string;
  notificationType: 'system' | 'academic' | 'payment' | 'placement' | 'announcement';
  title: string;
  messageBody: string;
  priority: 'low' | 'normal' | 'high';
  readAt?: string | undefined;
  createdAt: string;
  relatedEntityId?: string | undefined;
  relatedEntityType?: string | undefined;
}

export interface AuditLogEntry {
  id: string;
  moduleCode: string;
  actionType: string;
  entityName: string;
  entityId: string;
  actorUserId?: string | undefined;
  actorName?: string | undefined;
  oldValues?: string | undefined;
  newValues?: string | undefined;
  correlationId?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  createdAt: string;
}

export interface SystemSetting {
  id: string;
  settingKey: string;
  settingValue: string;
  valueType: string;
  isSecret: boolean;
  updatedByUserId?: string | undefined;
  updatedAt: string;
}
