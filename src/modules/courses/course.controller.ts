import type { Request, Response } from "express";

import { HttpStatus } from "../../utils/http-status";
import { sendPaginated, sendSuccess } from "../../utils/send";
import type { CourseService } from "./course.service";
import type {
  CourseIdParams,
  CourseSlugParams,
  CourseStatusBody,
  CreateCourseBody,
  CurriculumBody,
  ManageCourseListQuery,
  PublicCourseListQuery,
  UpdateCourseBody,
} from "./course.validation";

/**
 * HTTP adapter for the `courses` module: read input, call one service
 * method, send the response. No business rules here.
 *
 * Every handler sits behind `validate()`, so params, query and body are
 * already parsed and normalised - query from `req.validatedQuery` (never
 * `req.query`, see architecture section 10).
 */
export const createCourseController = (service: CourseService) => ({
  // --- public (Step 1) -----------------------------------------------------

  async listPublic(req: Request, res: Response): Promise<void> {
    const query = req.validatedQuery as PublicCourseListQuery;
    const result = await service.listPublishedCourses(query);
    sendPaginated(res, result);
  },

  async getPublicBySlug(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as CourseSlugParams;
    const course = await service.getPublishedCourseBySlug(slug);
    sendSuccess(res, { data: course });
  },

  // --- management (Step 2A, admin-only) --------------------------------------

  async listManaged(req: Request, res: Response): Promise<void> {
    const query = req.validatedQuery as ManageCourseListQuery;
    const result = await service.listCourses(query);
    sendPaginated(res, result);
  },

  async getManagedById(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const course = await service.getCourseById(courseId);
    sendSuccess(res, { data: course });
  },

  async create(req: Request, res: Response): Promise<void> {
    const course = await service.createCourse(req.body as CreateCourseBody);
    // 201 + Location, per api-contracts section 3.11.
    res.location(`${req.baseUrl}/manage/${encodeURIComponent(course.id)}`);
    sendSuccess(res, { status: HttpStatus.CREATED, data: course, message: "Course created" });
  },

  async update(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const course = await service.updateCourse(courseId, req.body as UpdateCourseBody);
    sendSuccess(res, { data: course, message: "Course updated" });
  },

  async replaceCurriculum(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const { modules } = req.body as CurriculumBody;
    const course = await service.replaceCurriculum(courseId, modules);
    sendSuccess(res, { data: course, message: "Curriculum updated" });
  },

  async setStatus(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const { status } = req.body as CourseStatusBody;
    const course = await service.setCourseStatus(courseId, status);
    sendSuccess(res, { data: course, message: `Course status set to ${course.status ?? status}` });
  },

  async togglePublish(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const course = await service.togglePublish(courseId);
    sendSuccess(res, {
      data: course,
      message: course.isPublished ? "Course published" : "Course unpublished",
    });
  },
});

export type CourseController = ReturnType<typeof createCourseController>;
