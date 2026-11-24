import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireRoles } from "../../middleware/authorize.middleware";
import { ADMIN_ROLES, SUPER_ADMIN_ONLY } from "../../contracts/user.contract";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";
import { FinanceRuleError, type FinanceRepository } from "./finance.repository";
import {
  awardsQuerySchema,
  createScholarshipSchema,
  historyQuerySchema,
  idParamsSchema,
  setActiveSchema,
} from "./finance.validation";

export interface FinanceRoutesOptions {
  finance: FinanceRepository;
  authenticate?: RequestHandler;
}

const NOT_FOUND: Record<string, string> = {
  coupon: "Coupon not found.",
  refund: "Refund not found.",
  scholarship: "Scholarship not found.",
};

function actorId(req: Request): string {
  const id = req.principal?.id ?? (req as { user?: { userId?: string } }).user?.userId;
  if (!id) throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  return String(id);
}

const handle =
  (work: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await work(req, res);
    } catch (err) {
      if (err instanceof RecordNotFoundError) return next(ApiError.notFound(NOT_FOUND[err.entity] ?? "Record not found."));
      if (err instanceof FinanceRuleError) return next(new ApiError(err.status, err.message, err.code));
      next(err);
    }
  };

/**
 * Financial administration, mounted at /admin/finance.
 * Admin + Super Admin: coupons, scholarships, financial history.
 * Super Admin only: refund detail (PAY-012 / BR-006).
 */
export function createFinanceRoutes(options: FinanceRoutesOptions): Router {
  const router = Router();
  const repo = () => options.finance;
  const auth = options.authenticate ? [options.authenticate] : [];
  const admin = [...auth, requireRoles(ADMIN_ROLES)];
  const superAdmin = [...auth, requireRoles(SUPER_ADMIN_ONLY)];

  // ---- coupons (NXA_Coupons.IsActive; never deleted)
  router.patch(
    "/coupons/:id/status",
    ...admin,
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      const body = setActiveSchema.parse(req.body);
      const result = await repo().setCouponActive(id, body.isActive, body.reason, actorId(req));
      sendSuccess(res, {
        data: result,
        message: result.changed ? `Coupon ${body.isActive ? "activated" : "deactivated"}.` : "The coupon already had this status; nothing changed.",
      });
    }),
  );
  router.get(
    "/coupons/:id/redemptions",
    ...admin,
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().listCouponRedemptions(id) });
    }),
  );

  // ---- financial audit history (PAY-013)
  router.get(
    "/history",
    ...admin,
    handle(async (req, res) => {
      const q = historyQuerySchema.parse(req.query);
      sendSuccess(res, { data: await repo().getFinancialHistory(q.entityType, q.entityId) });
    }),
  );

  // ---- refunds (Super Admin only)
  router.get(
    "/refunds/:id",
    ...superAdmin,
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      sendSuccess(res, { data: await repo().getRefundDetail(id) });
    }),
  );

  // ---- scholarships (ADM-010)
  router.get(
    "/scholarships",
    ...admin,
    handle(async (_req, res) => {
      sendSuccess(res, { data: await repo().listScholarships() });
    }),
  );
  router.post(
    "/scholarships",
    ...admin,
    handle(async (req, res) => {
      const body = createScholarshipSchema.parse(req.body);
      const created = await repo().createScholarship(
        {
          name: body.name,
          discountType: body.discountType,
          discountValue: body.discountValue,
          isActive: body.isActive,
          ...(body.description ? { description: body.description } : {}),
          ...(body.startsAt ? { startsAt: body.startsAt } : {}),
          ...(body.endsAt ? { endsAt: body.endsAt } : {}),
        },
        actorId(req),
      );
      sendSuccess(res, { status: HttpStatus.CREATED, data: created, message: "Scholarship created." });
    }),
  );
  router.patch(
    "/scholarships/:id/status",
    ...admin,
    handle(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      const body = setActiveSchema.parse(req.body);
      const result = await repo().setScholarshipActive(id, body.isActive, body.reason, actorId(req));
      sendSuccess(res, {
        data: result,
        message: result.changed ? `Scholarship ${body.isActive ? "activated" : "deactivated"}.` : "The scholarship already had this status; nothing changed.",
      });
    }),
  );
  router.get(
    "/scholarship-awards",
    ...admin,
    handle(async (req, res) => {
      const q = awardsQuerySchema.parse(req.query);
      sendSuccess(res, { data: await repo().listScholarshipAwards({ scholarshipId: q.scholarshipId }) });
    }),
  );

  return router;
}
