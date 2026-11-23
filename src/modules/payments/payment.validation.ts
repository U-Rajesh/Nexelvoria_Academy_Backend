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

export const manualPaymentSchema = z.object({
  studentUserId: z.string().min(1, "Student User ID is required"),
  enrollmentId: z.string().min(1, "Enrollment ID is required"),
  amount: z.number().positive("Amount must be positive"),
  paymentMode: z.enum(["cash", "bank_transfer", "cheque", "pos_card", "other"]),
  referenceNumber: z.string().min(2, "Reference number is required"),
  proofObjectKey: z.string().optional(),
});

export const createDiscountSchema = z.object({
  code: z.string().min(3, "Coupon code must be at least 3 characters"),
  description: z.string().min(3, "Description is required"),
  discountType: z.enum(["percentage", "fixed_amount"]),
  value: z.number().positive("Discount value must be positive"),
  applicableCourseIds: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  validUntil: z.string().optional(),
});
