import type { Request, Response } from "express";

import { sendPaginated, sendSuccess } from "../../utils/send";
import type { TeacherService } from "./teacher.service";
import type { TeacherIdParams, TeacherListQuery, UpdateTeacherBody } from "./teacher.validation";

/**
 * HTTP adapter for the `teachers` module: read input, call one service
 * method, send the response. No business rules here.
 *
 * Every handler sits behind `authenticate`, `requireAdmin` and `validate()`,
 * so params, query and body are already parsed (query from
 * `req.validatedQuery`).
 */
export const createTeacherController = (service: TeacherService) => ({
  async list(req: Request, res: Response): Promise<void> {
    const query = req.validatedQuery as TeacherListQuery;
    const result = await service.listTeachers(query);
    sendPaginated(res, result);
  },

  async getById(req: Request, res: Response): Promise<void> {
    const { teacherId } = req.params as TeacherIdParams;
    const teacher = await service.getTeacherById(teacherId);
    sendSuccess(res, { data: teacher });
  },

  async update(req: Request, res: Response): Promise<void> {
    const { teacherId } = req.params as TeacherIdParams;
    const teacher = await service.updateTeacher(teacherId, req.body as UpdateTeacherBody);
    sendSuccess(res, { data: teacher, message: "Teacher profile updated" });
  },
});

export type TeacherController = ReturnType<typeof createTeacherController>;
