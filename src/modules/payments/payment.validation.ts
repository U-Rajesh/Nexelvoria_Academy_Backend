import { z } from "zod";

export const createPaymentOrderSchema = z.object({
  courseId: z.string().min(1, "Course ID is required"),
  enrollmentId: z.string().min(1, "Enrollment ID is required"),
  couponCode: z.string().optional(),
});

export const verifyPaymentSchema = z.object({
  orderId: z.string().min(1, "Order ID is required"),
  gatewayPaymentId: z.string().min(1, "Gateway Payment ID is required"),
  gatewaySignature: z.string().min(1, "Gateway Signature is required"),
  paymentMethod: z.enum(["upi", "card", "netbanking", "wallet"]).default("upi"),
});

export const validateCouponSchema = z.object({
  code: z.string().min(1, "Coupon code is required"),
  courseId: z.string().optional(),
  grossAmountINR: z.number().nonnegative().optional(),
});

/** NXA_ManualPaymentRecords: ReferenceNumber varchar(100), ProofObjectKey nvarchar(700), Amount decimal(12,2). */
export const manualPaymentSchema = z.object({
  // Non-numeric ids are answered 404 by the repository (BIGINT keys).
  studentUserId: z.string().trim().min(1, "Student User ID is required"),
  enrollmentId: z.string().trim().min(1, "Enrollment ID is required"),
  amount: z
    .number()
    .positive("Amount must be positive")
    .max(9999999999.99)
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, "Amount may have at most 2 decimals"),
  paymentMode: z.enum(["cash", "bank_transfer", "cheque", "pos_card", "other"]),
  referenceNumber: z
    .string()
    .trim()
    .min(2, "Reference number is required")
    .max(100, "Reference number must be at most 100 characters"),
  proofObjectKey: z.string().trim().max(700).optional(),
});

export const createDiscountSchema = z
  .object({
    // NXA_Coupons.CouponCode is varchar(40); NXA_Discounts.DiscountName is nvarchar(150).
    code: z
      .string()
      .trim()
      .min(3, "Coupon code must be at least 3 characters")
      .max(40, "Coupon code must be at most 40 characters")
      .regex(/^[A-Za-z0-9_-]+$/, "Coupon code may contain only letters, digits, - and _"),
    description: z.string().trim().min(3, "Description is required").max(150),
    discountType: z.enum(["percentage", "fixed_amount"]),
    value: z.number().positive("Discount value must be positive"),
    // No coupon-course table exists, so a course restriction cannot be stored.
    applicableCourseIds: z
      .array(z.string())
      .max(0, "Course-restricted coupons cannot be stored: the database has no coupon-course mapping")
      .default([]),
    isActive: z.boolean().default(true),
    validUntil: z.string().optional(),
    // NULL (omitted) means no limit.
    usageLimit: z.number().int().positive().optional(),
    perUserLimit: z.number().int().positive().optional(),
  })
  .refine((v) => v.discountType !== "percentage" || v.value <= 100, {
    message: "A percentage discount cannot exceed 100",
    path: ["value"],
  });
