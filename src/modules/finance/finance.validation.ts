import { z } from "zod";
import { ADMIN_HISTORY_ENTITY_TYPES, SCHOLARSHIP_DISCOUNT_TYPES } from "./finance.repository";

const numericId = (label: string) => z.string().trim().regex(/^\d{1,19}$/, `${label} must be a numeric id`);
const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: `${label} must be a valid date` });

export const idParamsSchema = z.object({ id: numericId("Id") });

/** NXA_FinancialAuditHistory.Reason nvarchar(500). */
export const setActiveSchema = z
  .object({
    isActive: z.boolean(),
    reason: z.string().trim().min(5, "Reason must be at least 5 characters").max(500).optional(),
  })
  .strict();

export const historyQuerySchema = z.object({
  entityType: z.enum(ADMIN_HISTORY_ENTITY_TYPES),
  entityId: numericId("Entity"),
});

/** NXA_Scholarships: ScholarshipName nvarchar(150), Description nvarchar(1000), DiscountValue decimal(12,2). */
export const createScholarshipSchema = z
  .object({
    name: z.string().trim().min(3).max(150),
    description: z.string().trim().max(1000).optional(),
    discountType: z.enum(SCHOLARSHIP_DISCOUNT_TYPES),
    discountValue: z.number().positive().max(9999999999.99),
    startsAt: isoDate("startsAt").optional(),
    endsAt: isoDate("endsAt").optional(),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.discountType !== "percentage" || v.discountValue <= 100, {
    message: "A percentage scholarship cannot exceed 100",
    path: ["discountValue"],
  })
  .refine((v) => !v.startsAt || !v.endsAt || Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export const awardsQuerySchema = z.object({ scholarshipId: numericId("Scholarship").optional() });
