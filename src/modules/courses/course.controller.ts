import type { Request, Response } from "express";

import { HttpStatus } from "../../utils/http-status";
import { sendPaginated, sendSuccess } from "../../utils/send";
import type { CourseAudit } from "./course.repository";
import type { CourseService } from "./course.service";
import type {
  CourseIdParams,
  CourseSlugParams,
  CourseStatusBody,
  CreateCourseBody,
  CurriculumBody,
  PrerequisitesBody,
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
export const createCourseController = (service: CourseService) => {
  /**
   * The audit entry for an administrative course change (ADM-016, SEC audit
   * logs). The repository writes it in the same transaction as the change,
   * so a failed audit write fails the request and leaves nothing changed. No
   * entry without an authenticated actor (management routes always have one).
   */
  const entry = (req: Request, actionType: string, details: string): CourseAudit | undefined => {
    const actorUserId = req.principal?.id;
    return actorUserId ? { actorUserId, actionType, details } : undefined;
  };

  return {
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
    const actorUserId = req.principal?.id;
    const course = await service.createCourse(
      req.body as CreateCourseBody,
      actorUserId ? ({ courseCode }) => ({ actorUserId, actionType: "CREATE_COURSE", details: `Created course ${courseCode}` }) : undefined,
    );
    // 201 + Location, per api-contracts section 3.11.
    res.location(`${req.baseUrl}/manage/${encodeURIComponent(course.id)}`);
    sendSuccess(res, { status: HttpStatus.CREATED, data: course, message: "Course created" });
  },

  async update(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const course = await service.updateCourse(
      courseId,
      req.body as UpdateCourseBody,
      entry(req, "UPDATE_COURSE", `Updated fields: ${Object.keys(req.body ?? {}).join(", ")}`),
    );
    sendSuccess(res, { data: course, message: "Course updated" });
  },

  async replaceCurriculum(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const { modules } = req.body as CurriculumBody;
    const course = await service.replaceCurriculum(courseId, modules, entry(req, "UPDATE_CURRICULUM", `Curriculum saved: ${modules.length} module(s)`));
    sendSuccess(res, { data: course, message: "Curriculum updated" });
  },

  async getPrerequisites(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const prerequisites = await service.getPrerequisites(courseId);
    sendSuccess(res, { data: prerequisites });
  },

  async replacePrerequisites(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const { prerequisiteCourseIds } = req.body as PrerequisitesBody;
    // Audited in the same transaction, only when the set changed.
    const actorUserId = req.principal?.id;
    const result = await service.replacePrerequisites(
      courseId,
      prerequisiteCourseIds,
      actorUserId
        ? (saved) => ({
            actorUserId,
            actionType: "SET_COURSE_PREREQUISITES",
            details: `Prerequisites set to: ${saved.map((p) => p.courseId).join(", ") || "none"}`,
          })
        : undefined,
    );
    sendSuccess(res, {
      data: result.prerequisites,
      message: result.changed ? "Prerequisites updated" : "Prerequisites unchanged",
    });
  },

  async setStatus(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const { status } = req.body as CourseStatusBody;
    // An unchanged status writes nothing and is not audited.
    const course = await service.setCourseStatus(courseId, status, entry(req, "SET_COURSE_STATUS", `Status set to ${status}`));
    sendSuccess(res, { data: course, message: `Course status set to ${course.status ?? status}` });
  },

  async togglePublish(req: Request, res: Response): Promise<void> {
    const { courseId } = req.params as CourseIdParams;
    const course = await service.togglePublish(courseId, (isPublished) =>
      entry(req, isPublished ? "PUBLISH_COURSE" : "UNPUBLISH_COURSE", `Published: ${isPublished}`),
    );
    sendSuccess(res, {
      data: course,
      message: course.isPublished ? "Course published" : "Course unpublished",
    });
  },
  };
};

export type CourseController = ReturnType<typeof createCourseController>;
