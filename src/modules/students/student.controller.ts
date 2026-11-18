import type { Request, Response } from "express";

import { sendPaginated, sendSuccess } from "../../utils/send";
import type { StudentService } from "./student.service";
import type { StudentIdParams, StudentListQuery, StudentStatusBody } from "./student.validation";

/**
 * HTTP adapter for the `students` module: read input, call one service
 * method, send the response. No business rules here.
 *
 * Every handler sits behind `requireAdmin` and `validate()`, so params and
 * query are already parsed (query from `req.validatedQuery`).
 */
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

  async setStatus(req: Request, res: Response): Promise<void> {
    const { studentId } = req.params as StudentIdParams;
    const { status } = req.body as StudentStatusBody;
    const student = await service.setStudentStatus(studentId, status);
    sendSuccess(res, { data: student, message: `Student status set to ${student.status}` });
  },
});

export type StudentController = ReturnType<typeof createStudentController>;
