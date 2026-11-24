import { Router, type RequestHandler } from "express";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import type { PaymentRepository } from "./payment.repository";
import type { CourseRepository } from "../courses/course.repository";
import type { EnrollmentRepository } from "../enrollments/enrollment.repository";
import type { UserRepository } from "../users/user.repository";
import type { PaymentGateway } from "./payment.gateway";
import { requireAuth, requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES } from "../../contracts/user.contract";

export interface PaymentRoutesOptions {
  payments: PaymentRepository;
  /** Required for student payments: price lookup and BR-004 activation. */
  courses?: CourseRepository | undefined;
  enrollments?: EnrollmentRepository | undefined;
  users?: UserRepository | undefined;
  /** Real gateway; none is wired until the Razorpay integration exists. */
  gateway?: PaymentGateway | undefined;
  authenticate?: RequestHandler;
}

export function createPaymentRoutes(options: PaymentRoutesOptions): Router {
  const router = Router();
  const service = new PaymentService({
    payments: options.payments,
    courses: options.courses,
    enrollments: options.enrollments,
    users: options.users,
    gateway: options.gateway,
  });
  const controller = new PaymentController(service);

  const authGuards = options.authenticate ? [options.authenticate, requireAuth] : [requireAuth];
  const studentGuards = options.authenticate ? [options.authenticate, requireRoles(["student"])] : [requireRoles(["student"])];
  // CL-001 allowlist: also open to students whose approval is pending (limited access).
  const limitedStudentGuards = options.authenticate
    ? [options.authenticate, requireRoles(["student"], { allowLimitedStudent: true })]
    : [requireRoles(["student"], { allowLimitedStudent: true })];
  const adminGuards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];

  // Public webhook endpoint
  router.post("/webhook", controller.handleWebhook);

  // Student endpoints
  router.post("/orders", ...studentGuards, controller.createOrder);
  router.post("/verify", ...studentGuards, controller.verifyPayment);
  router.get("/me", ...limitedStudentGuards, controller.getMyPaymentHistory);
  router.get("/receipts/:receiptId", ...studentGuards, controller.getReceipt);

  // Discount validation
  router.get("/discounts/validate", ...authGuards, controller.validateDiscount);

  // Admin endpoints
  router.post("/admin/manual", ...adminGuards, controller.recordManualPayment);
  router.get("/admin/manual", ...adminGuards, controller.getManualPayments);
  router.get("/admin/all", ...adminGuards, controller.getAllTransactions);
  router.post("/admin/discounts", ...adminGuards, controller.createDiscount);
  router.get("/admin/discounts", ...adminGuards, controller.getAllDiscounts);

  return router;
}
