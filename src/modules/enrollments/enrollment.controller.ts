import type { Request, Response } from "express";

import { HttpStatus } from "../../utils/http-status";
import { sendSuccess } from "../../utils/send";
import { ApiError } from "../../utils/api-error";
import type { EnrollmentService } from "./enrollment.service";
import type { CreateEnrollmentBody } from "./enrollment.validation";

const actorId = (req: Request): string => {
  const id = req.principal?.id;
  if (!id) {
    throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  }
  return id;
};

export const createEnrollmentController = (service: EnrollmentService) => ({
  async getMyEnrollments(req: Request, res: Response): Promise<void> {
    const list = await service.getMyEnrollments(actorId(req));
    sendSuccess(res, { data: list });
  },

  async requestEnrollment(req: Request, res: Response): Promise<void> {
    const { courseId, batchId } = req.body as CreateEnrollmentBody;
    const enrollment = await service.requestEnrollment(actorId(req), courseId, batchId);
    sendSuccess(res, {
      status: HttpStatus.CREATED,
      data: enrollment,
      message: "Enrollment requested successfully",
    });
  },
});

export type EnrollmentController = ReturnType<typeof createEnrollmentController>;
