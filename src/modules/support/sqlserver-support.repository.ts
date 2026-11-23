import crypto from "node:crypto";
import sql from "mssql";
import { getSqlServerPool } from "../../db/sqlserver.pool";
import type {
  AuditLogEntry,
  InAppNotification,
  SupportTicket,
  SystemSetting,
  TicketReply,
} from "./support.types";
import type { SupportRepository } from "./support.repository";

export class SqlServerSupportRepository implements SupportRepository {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool> = getSqlServerPool) {}

  async createTicket(ticket: Omit<SupportTicket, "id" | "createdAt" | "replies">): Promise<SupportTicket> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("SupportTicketId", sql.UniqueIdentifier, id)
      .input("TicketNumber", sql.NVarChar(50), ticket.ticketNumber)
      .input("StudentUserId", sql.UniqueIdentifier, ticket.studentUserId)
      .input("CategoryId", sql.NVarChar(50), ticket.categoryId)
      .input("Subject", sql.NVarChar(200), ticket.subject)
      .input("Description", sql.NVarChar(sql.MAX), ticket.description)
      .input("Priority", sql.NVarChar(50), ticket.priority)
      .input("TicketStatus", sql.NVarChar(50), ticket.ticketStatus)
      .input("AssignedToUserId", sql.UniqueIdentifier, ticket.assignedToUserId ?? null)
      .input("CreatedAt", sql.DateTime2, now)
      .query(`
        INSERT INTO dbo.NXA_SupportTickets (
          SupportTicketId, TicketNumber, StudentUserId, CategoryId,
          Subject, Description, Priority, TicketStatus, AssignedToUserId, CreatedAt
        ) VALUES (
          @SupportTicketId, @TicketNumber, @StudentUserId, @CategoryId,
          @Subject, @Description, @Priority, @TicketStatus, @AssignedToUserId, @CreatedAt
        )
      `);

    return {
      ...ticket,
      id,
      createdAt: now.toISOString(),
      replies: [],
    };
  }

  async getTicketById(id: string): Promise<SupportTicket | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("SupportTicketId", sql.UniqueIdentifier, id)
      .query(`
        SELECT TOP 1 t.SupportTicketId, t.TicketNumber, t.StudentUserId, us.FullName AS StudentName,
               t.CategoryId, t.Subject, t.Description, t.Priority, t.TicketStatus,
               t.AssignedToUserId, ua.FullName AS AssignedToName, t.CreatedAt, t.ClosedAt
        FROM dbo.NXA_SupportTickets t
        LEFT JOIN dbo.NXA_Users us ON t.StudentUserId = us.UserId
        LEFT JOIN dbo.NXA_Users ua ON t.AssignedToUserId = ua.UserId
        WHERE t.SupportTicketId = @SupportTicketId
      `);

    if (result.recordset.length === 0) return null;
    const r = result.recordset[0];
    const replies = await this.getRepliesByTicket(id, true);

    return {
      id: String(r.SupportTicketId),
      ticketNumber: r.TicketNumber,
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      categoryId: r.CategoryId,
      subject: r.Subject,
      description: r.Description,
      priority: r.Priority ?? "medium",
      ticketStatus: r.TicketStatus ?? "open",
      assignedToUserId: r.AssignedToUserId ? String(r.AssignedToUserId) : undefined,
      assignedToName: r.AssignedToName ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
      closedAt: r.ClosedAt ? new Date(r.ClosedAt).toISOString() : undefined,
      replies,
    };
  }

  async getTicketsByStudent(studentUserId: string): Promise<SupportTicket[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("StudentUserId", sql.UniqueIdentifier, studentUserId)
      .query(`
        SELECT t.SupportTicketId, t.TicketNumber, t.StudentUserId, us.FullName AS StudentName,
               t.CategoryId, t.Subject, t.Description, t.Priority, t.TicketStatus,
               t.AssignedToUserId, ua.FullName AS AssignedToName, t.CreatedAt, t.ClosedAt
        FROM dbo.NXA_SupportTickets t
        LEFT JOIN dbo.NXA_Users us ON t.StudentUserId = us.UserId
        LEFT JOIN dbo.NXA_Users ua ON t.AssignedToUserId = ua.UserId
        WHERE t.StudentUserId = @StudentUserId
        ORDER BY t.CreatedAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.SupportTicketId),
      ticketNumber: r.TicketNumber,
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      categoryId: r.CategoryId,
      subject: r.Subject,
      description: r.Description,
      priority: r.Priority ?? "medium",
      ticketStatus: r.TicketStatus ?? "open",
      assignedToUserId: r.AssignedToUserId ? String(r.AssignedToUserId) : undefined,
      assignedToName: r.AssignedToName ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
      closedAt: r.ClosedAt ? new Date(r.ClosedAt).toISOString() : undefined,
    }));
  }

  async getAllTickets(filter?: { status?: string; category?: string }): Promise<SupportTicket[]> {
    const pool = await this.getPool();
    let q = `
      SELECT t.SupportTicketId, t.TicketNumber, t.StudentUserId, us.FullName AS StudentName,
             t.CategoryId, t.Subject, t.Description, t.Priority, t.TicketStatus,
             t.AssignedToUserId, ua.FullName AS AssignedToName, t.CreatedAt, t.ClosedAt
      FROM dbo.NXA_SupportTickets t
      LEFT JOIN dbo.NXA_Users us ON t.StudentUserId = us.UserId
      LEFT JOIN dbo.NXA_Users ua ON t.AssignedToUserId = ua.UserId
      WHERE 1=1
    `;

    const req = pool.request();
    if (filter?.status) {
      q += ` AND t.TicketStatus = @TicketStatus`;
      req.input("TicketStatus", sql.NVarChar(50), filter.status);
    }
    if (filter?.category) {
      q += ` AND t.CategoryId = @CategoryId`;
      req.input("CategoryId", sql.NVarChar(50), filter.category);
    }

    q += ` ORDER BY t.CreatedAt DESC`;
    const result = await req.query(q);

    return result.recordset.map((r: any) => ({
      id: String(r.SupportTicketId),
      ticketNumber: r.TicketNumber,
      studentUserId: String(r.StudentUserId),
      studentName: r.StudentName ?? undefined,
      categoryId: r.CategoryId,
      subject: r.Subject,
      description: r.Description,
      priority: r.Priority ?? "medium",
      ticketStatus: r.TicketStatus ?? "open",
      assignedToUserId: r.AssignedToUserId ? String(r.AssignedToUserId) : undefined,
      assignedToName: r.AssignedToName ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
      closedAt: r.ClosedAt ? new Date(r.ClosedAt).toISOString() : undefined,
    }));
  }

  async updateTicketStatus(
    id: string,
    status: "open" | "in_progress" | "resolved" | "closed",
    assignedToUserId?: string
  ): Promise<SupportTicket> {
    const pool = await this.getPool();
    const isClosed = status === "resolved" || status === "closed";
    const closedAt = isClosed ? new Date() : null;

    let q = `
      UPDATE dbo.NXA_SupportTickets
      SET TicketStatus = @TicketStatus
    `;
    const req = pool.request()
      .input("SupportTicketId", sql.UniqueIdentifier, id)
      .input("TicketStatus", sql.NVarChar(50), status);

    if (assignedToUserId) {
      q += `, AssignedToUserId = @AssignedToUserId`;
      req.input("AssignedToUserId", sql.UniqueIdentifier, assignedToUserId);
    }
    if (isClosed) {
      q += `, ClosedAt = @ClosedAt`;
      req.input("ClosedAt", sql.DateTime2, closedAt);
    }

    q += ` WHERE SupportTicketId = @SupportTicketId`;
    await req.query(q);

    const updated = await this.getTicketById(id);
    if (!updated) throw new Error("Ticket not found after status update.");
    return updated;
  }

  async addReply(reply: Omit<TicketReply, "id" | "repliedAt">): Promise<TicketReply> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("TicketReplyId", sql.UniqueIdentifier, id)
      .input("SupportTicketId", sql.UniqueIdentifier, reply.ticketId)
      .input("RepliedByUserId", sql.UniqueIdentifier, reply.repliedByUserId)
      .input("ReplyText", sql.NVarChar(sql.MAX), reply.replyText)
      .input("AttachmentObjectKey", sql.NVarChar(500), reply.attachmentObjectKey ?? null)
      .input("IsInternal", sql.Bit, reply.isInternal ? 1 : 0)
      .input("RepliedAt", sql.DateTime2, now)
      .query(`
        INSERT INTO dbo.NXA_TicketReplies (
          TicketReplyId, SupportTicketId, RepliedByUserId, ReplyText,
          AttachmentObjectKey, IsInternal, RepliedAt
        ) VALUES (
          @TicketReplyId, @SupportTicketId, @RepliedByUserId, @ReplyText,
          @AttachmentObjectKey, @IsInternal, @RepliedAt
        )
      `);

    return {
      ...reply,
      id,
      repliedAt: now.toISOString(),
    };
  }

  async getRepliesByTicket(ticketId: string, includeInternal = true): Promise<TicketReply[]> {
    const pool = await this.getPool();
    let q = `
      SELECT r.TicketReplyId, r.SupportTicketId, r.RepliedByUserId, u.FullName AS RepliedByName,
             r.ReplyText, r.AttachmentObjectKey, r.IsInternal, r.RepliedAt
      FROM dbo.NXA_TicketReplies r
      LEFT JOIN dbo.NXA_Users u ON r.RepliedByUserId = u.UserId
      WHERE r.SupportTicketId = @SupportTicketId
    `;

    if (!includeInternal) {
      q += ` AND r.IsInternal = 0`;
    }
    q += ` ORDER BY r.RepliedAt ASC`;

    const result = await pool
      .request()
      .input("SupportTicketId", sql.UniqueIdentifier, ticketId)
      .query(q);

    return result.recordset.map((r: any) => ({
      id: String(r.TicketReplyId),
      ticketId: String(r.SupportTicketId),
      repliedByUserId: String(r.RepliedByUserId),
      repliedByName: r.RepliedByName ?? undefined,
      replyText: r.ReplyText,
      attachmentObjectKey: r.AttachmentObjectKey ?? undefined,
      isInternal: Boolean(r.IsInternal),
      repliedAt: r.RepliedAt ? new Date(r.RepliedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async createNotification(notif: Omit<InAppNotification, "id" | "createdAt">): Promise<InAppNotification> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("NotificationId", sql.UniqueIdentifier, id)
      .input("RecipientUserId", sql.UniqueIdentifier, notif.recipientUserId)
      .input("NotificationType", sql.NVarChar(50), notif.notificationType)
      .input("Title", sql.NVarChar(200), notif.title)
      .input("MessageBody", sql.NVarChar(sql.MAX), notif.messageBody)
      .input("Priority", sql.NVarChar(50), notif.priority)
      .input("CreatedAt", sql.DateTime2, now)
      .input("RelatedEntityId", sql.NVarChar(100), notif.relatedEntityId ?? null)
      .input("RelatedEntityType", sql.NVarChar(50), notif.relatedEntityType ?? null)
      .query(`
        INSERT INTO dbo.NXA_Notifications (
          NotificationId, RecipientUserId, NotificationType, Title,
          MessageBody, Priority, CreatedAt, RelatedEntityId, RelatedEntityType
        ) VALUES (
          @NotificationId, @RecipientUserId, @NotificationType, @Title,
          @MessageBody, @Priority, @CreatedAt, @RelatedEntityId, @RelatedEntityType
        )
      `);

    return {
      ...notif,
      id,
      createdAt: now.toISOString(),
    };
  }

  async getNotificationsByUser(userId: string): Promise<InAppNotification[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("RecipientUserId", sql.UniqueIdentifier, userId)
      .query(`
        SELECT NotificationId, RecipientUserId, NotificationType, Title,
               MessageBody, Priority, ReadAt, CreatedAt, RelatedEntityId, RelatedEntityType
        FROM dbo.NXA_Notifications
        WHERE RecipientUserId = @RecipientUserId
        ORDER BY CreatedAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.NotificationId),
      recipientUserId: String(r.RecipientUserId),
      notificationType: r.NotificationType ?? "system",
      title: r.Title,
      messageBody: r.MessageBody,
      priority: r.Priority ?? "normal",
      readAt: r.ReadAt ? new Date(r.ReadAt).toISOString() : undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
      relatedEntityId: r.RelatedEntityId ?? undefined,
      relatedEntityType: r.RelatedEntityType ?? undefined,
    }));
  }

  async markNotificationAsRead(id: string, userId: string): Promise<void> {
    const pool = await this.getPool();
    const now = new Date();
    await pool
      .request()
      .input("NotificationId", sql.UniqueIdentifier, id)
      .input("RecipientUserId", sql.UniqueIdentifier, userId)
      .input("ReadAt", sql.DateTime2, now)
      .query(`
        UPDATE dbo.NXA_Notifications
        SET ReadAt = @ReadAt
        WHERE NotificationId = @NotificationId AND RecipientUserId = @RecipientUserId
      `);
  }

  async markAllNotificationsAsRead(userId: string): Promise<void> {
    const pool = await this.getPool();
    const now = new Date();
    await pool
      .request()
      .input("RecipientUserId", sql.UniqueIdentifier, userId)
      .input("ReadAt", sql.DateTime2, now)
      .query(`
        UPDATE dbo.NXA_Notifications
        SET ReadAt = @ReadAt
        WHERE RecipientUserId = @RecipientUserId AND ReadAt IS NULL
      `);
  }

  async createAuditLog(log: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry> {
    const pool = await this.getPool();
    const id = crypto.randomUUID();
    const now = new Date();

    await pool
      .request()
      .input("AuditLogId", sql.UniqueIdentifier, id)
      .input("ModuleCode", sql.NVarChar(50), log.moduleCode)
      .input("ActionType", sql.NVarChar(50), log.actionType)
      .input("EntityName", sql.NVarChar(100), log.entityName)
      .input("EntityId", sql.NVarChar(100), log.entityId)
      .input("ActorUserId", sql.UniqueIdentifier, log.actorUserId ?? null)
      .input("OldValues", sql.NVarChar(sql.MAX), log.oldValues ?? null)
      .input("NewValues", sql.NVarChar(sql.MAX), log.newValues ?? null)
      .input("CorrelationId", sql.NVarChar(100), log.correlationId ?? null)
      .input("IpAddress", sql.NVarChar(50), log.ipAddress ?? null)
      .input("UserAgent", sql.NVarChar(500), log.userAgent ?? null)
      .input("CreatedAt", sql.DateTime2, now)
      .query(`
        INSERT INTO dbo.NXA_AuditLogs (
          AuditLogId, ModuleCode, ActionType, EntityName, EntityId,
          ActorUserId, OldValues, NewValues, CorrelationId, IpAddress, UserAgent, CreatedAt
        ) VALUES (
          @AuditLogId, @ModuleCode, @ActionType, @EntityName, @EntityId,
          @ActorUserId, @OldValues, @NewValues, @CorrelationId, @IpAddress, @UserAgent, @CreatedAt
        )
      `);

    return {
      ...log,
      id,
      createdAt: now.toISOString(),
    };
  }

  async getAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("Limit", sql.Int, limit)
      .query(`
        SELECT TOP (@Limit) a.AuditLogId, a.ModuleCode, a.ActionType, a.EntityName, a.EntityId,
               a.ActorUserId, u.FullName AS ActorName, a.OldValues, a.NewValues,
               a.CorrelationId, a.IpAddress, a.UserAgent, a.CreatedAt
        FROM dbo.NXA_AuditLogs a
        LEFT JOIN dbo.NXA_Users u ON a.ActorUserId = u.UserId
        ORDER BY a.CreatedAt DESC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.AuditLogId),
      moduleCode: r.ModuleCode,
      actionType: r.ActionType,
      entityName: r.EntityName,
      entityId: r.EntityId,
      actorUserId: r.ActorUserId ? String(r.ActorUserId) : undefined,
      actorName: r.ActorName ?? undefined,
      oldValues: r.OldValues ?? undefined,
      newValues: r.NewValues ?? undefined,
      correlationId: r.CorrelationId ?? undefined,
      ipAddress: r.IpAddress ?? undefined,
      userAgent: r.UserAgent ?? undefined,
      createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getSettings(): Promise<SystemSetting[]> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .query(`
        SELECT InstituteSettingId, SettingKey, SettingValue, ValueType, IsSecret, UpdatedByUserId, UpdatedAt
        FROM dbo.NXA_InstituteSettings
        ORDER BY SettingKey ASC
      `);

    return result.recordset.map((r: any) => ({
      id: String(r.InstituteSettingId),
      settingKey: r.SettingKey,
      settingValue: r.IsSecret ? "********" : r.SettingValue,
      valueType: r.ValueType ?? "string",
      isSecret: Boolean(r.IsSecret),
      updatedByUserId: r.UpdatedByUserId ? String(r.UpdatedByUserId) : undefined,
      updatedAt: r.UpdatedAt ? new Date(r.UpdatedAt).toISOString() : new Date().toISOString(),
    }));
  }

  async getSettingByKey(key: string): Promise<SystemSetting | null> {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("SettingKey", sql.NVarChar(100), key)
      .query(`
        SELECT TOP 1 InstituteSettingId, SettingKey, SettingValue, ValueType, IsSecret, UpdatedByUserId, UpdatedAt
        FROM dbo.NXA_InstituteSettings
        WHERE SettingKey = @SettingKey
      `);

    if (result.recordset.length === 0) return null;
    const r = result.recordset[0];
    return {
      id: String(r.InstituteSettingId),
      settingKey: r.SettingKey,
      settingValue: r.SettingValue,
      valueType: r.ValueType ?? "string",
      isSecret: Boolean(r.IsSecret),
      updatedByUserId: r.UpdatedByUserId ? String(r.UpdatedByUserId) : undefined,
      updatedAt: r.UpdatedAt ? new Date(r.UpdatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async updateSetting(key: string, value: string, updatedByUserId: string): Promise<SystemSetting> {
    const pool = await this.getPool();
    const now = new Date();
    await pool
      .request()
      .input("SettingKey", sql.NVarChar(100), key)
      .input("SettingValue", sql.NVarChar(sql.MAX), value)
      .input("UpdatedByUserId", sql.UniqueIdentifier, updatedByUserId)
      .input("UpdatedAt", sql.DateTime2, now)
      .query(`
        UPDATE dbo.NXA_InstituteSettings
        SET SettingValue = @SettingValue,
            UpdatedByUserId = @UpdatedByUserId,
            UpdatedAt = @UpdatedAt
        WHERE SettingKey = @SettingKey
      `);

    const updated = await this.getSettingByKey(key);
    if (!updated) throw new Error("Setting not found after update.");
    return updated;
  }
}
