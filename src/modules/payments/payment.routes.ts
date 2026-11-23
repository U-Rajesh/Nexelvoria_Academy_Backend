import { Router, type RequestHandler } from "express";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import type { PaymentRepository } from "./payment.repository";
import { requireAuth, requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES } from "../../contracts/user.contract";

export interface PaymentRoutesOptions {
  payments: PaymentRepository;
  authenticate?: RequestHandler;
}

export function createPaymentRoutes(options: PaymentRoutesOptions): Router {
  const router = Router();
  const service = new PaymentService({ payments: options.payments });
  const controller = new PaymentController(service);

  const authGuards = options.authenticate ? [options.authenticate, requireAuth] : [requireAuth];
  const studentGuards = options.authenticate ? [options.authenticate, requireRoles(["student"])] : [requireRoles(["student"])];
  const adminGuards = options.authenticate ? [options.authenticate, requireRoles(ADMIN_ROLES)] : [requireRoles(ADMIN_ROLES)];

  // Public webhook endpoint
  router.post("/webhook", controller.handleWebhook);

  // Student endpoints
  router.post("/orders", ...studentGuards, controller.createOrder);
  router.post("/verify", ...studentGuards, controller.verifyPayment);
  router.get("/me", ...studentGuards, controller.getMyPaymentHistory);
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
