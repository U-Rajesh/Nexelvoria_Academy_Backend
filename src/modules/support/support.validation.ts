import { z } from "zod";

export const createTicketSchema = z.object({
  categoryId: z.string().min(1, "Category is required"),
  subject: z.string().min(3, "Subject must be at least 3 characters"),
  description: z.string().min(10, "Description must be at least 10 characters"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
});

export const addReplySchema = z.object({
  replyText: z.string().min(1, "Reply message cannot be empty"),
  attachmentObjectKey: z.string().optional(),
  isInternal: z.boolean().default(false),
});

export const updateTicketStatusSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]),
  assignedToUserId: z.string().optional(),
});

export const createNotificationSchema = z.object({
  recipientUserId: z.string().min(1, "Recipient User ID is required"),
  notificationType: z.enum(["system", "academic", "payment", "placement", "announcement"]).default("system"),
  title: z.string().min(2, "Title is required"),
  messageBody: z.string().min(5, "Message body is required"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  relatedEntityId: z.string().optional(),
  relatedEntityType: z.string().optional(),
});

export const broadcastNotificationSchema = z.object({
  notificationType: z.enum(["system", "academic", "payment", "placement", "announcement"]).default("announcement"),
  title: z.string().min(2, "Title is required"),
  messageBody: z.string().min(5, "Message body is required"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

export const updateSettingSchema = z.object({
  settingKey: z.string().min(1, "Setting key is required"),
  settingValue: z.string().min(1, "Setting value is required"),
});
