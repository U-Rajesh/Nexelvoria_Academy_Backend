import { z } from "zod";

/** NXA_SupportTicketCategories.SupportTicketCategoryId is an INT identity. */
const categoryId = z
  .union([z.string().trim(), z.number().int()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,9}$/.test(v), { message: "Category must be a valid category id" });

/** BIGINT identity, accepted as a numeric string. */
const numericId = (label: string) => z.string().trim().regex(/^\d{1,19}$/, `${label} must be a numeric id`);

export const createTicketSchema = z.object({
  categoryId,
  subject: z.string().trim().min(3, "Subject must be at least 3 characters").max(200),
  description: z.string().min(10, "Description must be at least 10 characters"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
});

export const addReplySchema = z.object({
  replyText: z.string().min(1, "Reply message cannot be empty"),
  attachmentObjectKey: z.string().max(700).optional(),
  isInternal: z.boolean().default(false),
});

export const updateTicketStatusSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]),
  assignedToUserId: numericId("Assignee").optional(),
});

export const createNotificationSchema = z.object({
  recipientUserId: z.string().trim().min(1, "Recipient User ID is required"),
  notificationType: z.enum(["system", "academic", "payment", "placement", "announcement"]).default("system"),
  title: z.string().trim().min(2, "Title is required").max(250),
  messageBody: z.string().min(5, "Message body is required"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  // NXA_Notifications.RelatedEntityId is BIGINT; RelatedEntityType varchar(50).
  relatedEntityId: numericId("Related entity").optional(),
  relatedEntityType: z.string().trim().max(50).optional(),
});

/**
 * A broadcast goes to every user holding one of the chosen roles. The
 * audience is required: there is no implicit "everyone".
 */
export const broadcastNotificationSchema = z.object({
  audience: z.array(z.enum(["student", "teacher", "admin", "super_admin"])).min(1, "Choose at least one audience role"),
  notificationType: z.enum(["system", "academic", "payment", "placement", "announcement"]).default("announcement"),
  title: z.string().trim().min(2, "Title is required").max(250),
  messageBody: z.string().min(5, "Message body is required"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

// ---- COM-010 messaging (NXA_Messages; text only: attachments need file storage)
export const sendMessageSchema = z
  .object({
    recipientUserId: numericId("Recipient"),
    body: z.string().trim().min(1, "Message cannot be empty").max(4000),
  })
  .strict();
export const conversationParamsSchema = z.object({ userId: z.string().regex(/^\d{1,19}$/, "Invalid user id") });

// ---- SUP-006 categories (NXA_SupportTicketCategories.CategoryName)
export const createCategorySchema = z.object({ name: z.string().trim().min(2, "Category name is required").max(100) }).strict();
export const updateCategorySchema = z
  .object({ name: z.string().trim().min(2).max(100).optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.isActive !== undefined, { message: "Nothing to change" });
export const categoryIdParamsSchema = z.object({ id: z.string().regex(/^\d{1,9}$/, "Invalid category id") });
export const ticketIdParamsSchema = z.object({ id: z.string().regex(/^\d{1,19}$/, "Invalid ticket id") });

// ---- COM-008 notification history
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "Not a valid date");
export const notificationHistoryQuerySchema = z
  .object({
    recipientUserId: numericId("Recipient").optional(),
    notificationType: z.enum(["system", "academic", "payment", "placement", "announcement"]).optional(),
    from: day.optional(),
    to: day.optional(),
    search: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["from"], message: "The start date must not be after the end date." });

export const updateSettingSchema = z.object({
  settingKey: z.string().trim().min(1, "Setting key is required").max(150),
  settingValue: z.string().min(1, "Setting value is required"),
});
