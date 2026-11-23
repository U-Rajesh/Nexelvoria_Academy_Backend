export interface SupportTicket {
  id: string;
  ticketNumber: string;
  studentUserId: string;
  studentName?: string | undefined;
  categoryId: string;
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
