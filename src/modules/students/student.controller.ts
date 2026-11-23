import type { Request, Response } from "express";

import { sendPaginated, sendSuccess } from "../../utils/send";
import type { StudentService } from "./student.service";
import { ApiError } from "../../utils/api-error";
import type { UpdateStudentInput } from "./student.types";
import type {
  StudentApproveBody,
  StudentIdParams,
  StudentListQuery,
  StudentRejectBody,
  StudentStatusBody,
} from "./student.validation";

/**
 * HTTP adapter for the `students` module: read input, call one service
 * method, send the response. No business rules here.
 *
 * Every handler sits behind `requireAdmin` and `validate()`, so params and
 * query are already parsed (query from `req.validatedQuery`).
 */
/**
 * The authenticated caller's id, or a 401.
 *
 * `requireAdmin` already rejects an anonymous request, so reaching this with
 * no principal means the route was mounted WITHOUT `authenticate` - a wiring
 * mistake, not a client error. It fails closed with the same generic 401
 * rather than recording a decision with no attributable actor, or crashing
 * on a missing field.
 */
const actorId = (req: Request): string => {
  const id = req.principal?.id;

  if (id === undefined || id === "") {
    throw ApiError.unauthorized("Authentication required", "UNAUTHENTICATED");
  }

  return id;
};

export const createStudentController = (service: StudentService) => ({
  async list(req: Request, res: Response): Promise<void> {
    const query = req.validatedQuery as StudentListQuery;
    const result = await service.listStudents(query);
    sendPaginated(res, result);
  },

  async getById(req: Request, res: Response): Promise<void> {
    const { studentId } = req.params as StudentIdParams;
    const student = await service.getStudentById(studentId);
    sendSuccess(res, { data: student });
  },

  /**
   * `POST /students/:studentId/approve` (api-contracts 5 #6).
   *
   * The deciding admin comes from `req.principal`, which only
   * `authenticate` populates from a verified access token - never from the
   * body, a header or a query parameter. A client able to name the approver
   * could forge the audit trail.
   */
  async approve(req: Request, res: Response): Promise<void> {
    const { studentId } = req.params as StudentIdParams;
    const { remarks } = req.body as StudentApproveBody;

    const student = await service.approveStudent(studentId, actorId(req), remarks);

    sendSuccess(res, {
      data: student,
      message: "Registration approved. The student may now proceed to payment (BR-002).",
    });
  },

  /** `POST /students/:studentId/reject` (api-contracts 5 #7). */
  async reject(req: Request, res: Response): Promise<void> {
    const { studentId } = req.params as StudentIdParams;
    const { remarks } = req.body as StudentRejectBody;

    const student = await service.rejectStudent(studentId, actorId(req), remarks);

    sendSuccess(res, { data: student, message: "Registration rejected." });
  },

  async setStatus(req: Request, res: Response): Promise<void> {
    const { studentId } = req.params as StudentIdParams;
    const { status } = req.body as StudentStatusBody;
    const student = await service.setStudentStatus(studentId, status);
    sendSuccess(res, { data: student, message: `Student status set to ${student.status}` });
  },

  /** `GET /students/me` - authenticated student's profile */
  async getMe(req: Request, res: Response): Promise<void> {
    const student = await service.getStudentById(actorId(req));
    sendSuccess(res, { data: student });
  },

  /** `PUT /students/me` - update authenticated student's profile */
  async updateMe(req: Request, res: Response): Promise<void> {
    const student = await service.updateStudentProfile(
      actorId(req),
      req.body as UpdateStudentInput,
    );
    sendSuccess(res, { data: student, message: "Profile updated successfully" });
  },
});

export type StudentController = ReturnType<typeof createStudentController>;
