/**
 * Coupon rules shared by the Admin enrollment path (sqlserver-admin.repository)
 * and the payment module (payment.service), so both apply the same checks.
 *
 * Live schema: a coupon (NXA_Coupons: CouponCode, IsActive, UsageLimit,
 * PerUserLimit, UsageCount) points at a discount (NXA_Discounts: DiscountType,
 * DiscountValue, StartsAt, EndsAt, IsActive). Redemptions are recorded in
 * NXA_CouponRedemptions. A NULL limit means "no limit".
 */

export interface CouponRuleInput {
  /** NXA_Coupons.IsActive AND NXA_Discounts.IsActive. */
  isActive: boolean;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
  usageLimit?: number | null | undefined;
  usageCount?: number | null | undefined;
  perUserLimit?: number | null | undefined;
}

export interface CouponRejection {
  code:
    | "DISCOUNT_INACTIVE"
    | "DISCOUNT_NOT_STARTED"
    | "DISCOUNT_EXPIRED"
    | "DISCOUNT_USAGE_LIMIT_REACHED"
    | "DISCOUNT_PER_USER_LIMIT_REACHED";
  message: string;
}

/**
 * Returns why the coupon cannot be used now, or null when it can.
 * `userRedemptions` is the number of NXA_CouponRedemptions rows this user
 * already has for the coupon; pass null when no user is known (the per-user
 * limit is then not evaluated).
 */
export function checkCouponUsable(
  coupon: CouponRuleInput,
  now: Date,
  userRedemptions: number | null,
): CouponRejection | null {
  if (!coupon.isActive) return { code: "DISCOUNT_INACTIVE", message: "This coupon code is no longer active." };
  if (coupon.startsAt && coupon.startsAt > now) {
    return { code: "DISCOUNT_NOT_STARTED", message: "This coupon code is not valid yet." };
  }
  if (coupon.endsAt && coupon.endsAt < now) return { code: "DISCOUNT_EXPIRED", message: "This coupon code has expired." };
  if (coupon.usageLimit != null && (coupon.usageCount ?? 0) >= coupon.usageLimit) {
    return { code: "DISCOUNT_USAGE_LIMIT_REACHED", message: "This coupon code has reached its usage limit." };
  }
  if (coupon.perUserLimit != null && userRedemptions != null && userRedemptions >= coupon.perUserLimit) {
    return {
      code: "DISCOUNT_PER_USER_LIMIT_REACHED",
      message: "This coupon code has already been used the maximum number of times for this student.",
    };
  }
  return null;
}

/** Discount in whole rupees: a percentage of the price, or a fixed amount capped at the price. */
export function couponDiscountAmount(discountType: string, value: number, price: number): number {
  const raw = (discountType ?? "").toLowerCase() === "percentage" ? Math.round((price * value) / 100) : value;
  return Math.max(0, Math.min(raw, price));
}
