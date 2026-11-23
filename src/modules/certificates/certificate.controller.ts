import type { Request, Response, NextFunction } from "express";
import type { CertificateService } from "./certificate.service";
import { issueCertificateSchema, revokeCertificateSchema } from "./certificate.validation";
import { ApiError } from "../../utils/api-error";
import { sendSuccess } from "../../utils/send";
import { HttpStatus } from "../../utils/http-status";

function getActorId(req: Request): string {
  const id = req.principal?.id ?? (req as any).user?.userId ?? (req as any).user?.id;
  if (!id) {
    throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  }
  return String(id);
}

export class CertificateController {
  constructor(private readonly certificateService: CertificateService) {}

  checkEligibility = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const studentUserId = getActorId(req);
      const courseId = String(req.params["courseId"] ?? "");
      if (!courseId) {
        throw ApiError.badRequest("Course ID is required.");
      }

      const result = await this.certificateService.checkEligibility(studentUserId, courseId);
      sendSuccess(res, { data: result });
    } catch (err) {
      next(err);
    }
  };

  getMyCertificates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const studentUserId = getActorId(req);
      const certs = await this.certificateService.getStudentCertificates(studentUserId);
      sendSuccess(res, { data: certs });
    } catch (err) {
      next(err);
    }
  };

  verifyPublic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const code = String(req.params["code"] ?? "");
      if (!code) {
        throw ApiError.badRequest("Certificate code is required.");
      }
      const ip = req.ip || req.socket.remoteAddress || "127.0.0.1";
      const result = await this.certificateService.verifyCertificate(code, ip);
      sendSuccess(res, { data: result });
    } catch (err) {
      next(err);
    }
  };

  issue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = issueCertificateSchema.parse(req.body);
      const issuedByUserId = getActorId(req);

      const cert = await this.certificateService.issueCertificate({
        ...parsed,
        issuedByUserId,
      });

      sendSuccess(res, {
        status: HttpStatus.CREATED,
        data: cert,
        message: "Certificate issued successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  revoke = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!id) {
        throw ApiError.badRequest("Certificate ID is required.");
      }
      const parsed = revokeCertificateSchema.parse(req.body);
      const adminUserId = getActorId(req);

      const cert = await this.certificateService.revokeCertificate(id, parsed.reason, adminUserId);
      sendSuccess(res, {
        data: cert,
        message: "Certificate revoked successfully.",
      });
    } catch (err) {
      next(err);
    }
  };

  getAll = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const certs = await this.certificateService.getAllCertificates();
      sendSuccess(res, { data: certs });
    } catch (err) {
      next(err);
    }
  };
}
