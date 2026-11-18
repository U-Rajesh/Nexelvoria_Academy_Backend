import type { PaginatedResult } from "../../contracts/api.contract";
import { toPaginatedResult } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import { resolveSortField } from "../../middleware/validate.middleware";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import type { TeacherRepository } from "./teacher.repository";
import {
  DEFAULT_TEACHER_SORT,
  TEACHER_SORT_FIELDS,
  type Teacher,
  type TeacherFilter,
  type TeacherSort,
  type UpdateTeacherInput,
} from "./teacher.types";
import type { TeacherListQuery, UpdateTeacherBody } from "./teacher.validation";

/**
 * Business logic for the `teachers` module.
 *
 * Teacher Management T1/T2: admin list, read and profile update only.
 * Deliberately NOT here (deferred by approval): teacher creation and
 * `/teachers/me` (both depend on the unresolved teacher-to-user linkage),
 * status management (not in the contract), allocations (need the batches
 * module), public profiles (Q20). The audit trail is deferred project-wide
 * (api-contracts section 15).
 *
 * No `express` import and no `req`/`res` (architecture section 4).
 */

export interface TeacherServiceDeps {
  teachers: TeacherRepository;
}

/**
 * The ONLY shape a teacher leaves the API in - an explicit WHITELIST.
 *
 * TypeScript types do not strip properties at runtime, so returning the
 * repository object would send whatever an adapter maps. `Teacher` extends
 * `User`, and the users table is where credentials will live, so any
 * column not listed here (credential, internal or future) is dropped until
 * someone deliberately adds it. Fields = the frontend's `TeacherProfile`.
 */
export const toTeacherResponse = (teacher: Teacher): Teacher => ({
  // --- User ---
  id: teacher.id,
  name: teacher.name,
  email: teacher.email,
  mobile: teacher.mobile,
  role: "teacher",
  status: teacher.status,
  createdAt: teacher.createdAt,
  ...(teacher.avatarUrl === undefined ? {} : { avatarUrl: teacher.avatarUrl }),

  // --- teacher profile ---
  specialization: teacher.specialization,
  experienceYears: teacher.experienceYears,
  bio: teacher.bio,
  qualifications: teacher.qualifications,

  // --- allocations (read-only here) and rating (derivation unconfirmed) ---
  assignedCourseIds: [...teacher.assignedCourseIds],
  assignedBatchIds: [...teacher.assignedBatchIds],
  rating: teacher.rating,
});

/** Repository errors -> HTTP errors, per repositories/repository.errors.ts. */
const rethrowAsApiError = (err: unknown): never => {
  if (err instanceof RecordNotFoundError) {
    throw ApiError.notFound("Teacher not found");
  }

  if (err instanceof DuplicateRecordError) {
    throw ApiError.conflict(`A teacher with this ${err.field} already exists`);
  }

  throw err;
};

/**
 * Builds the teacher service.
 *
 * `deps.teachers` is read lazily inside each method, never at construction:
 * the production container has no adapter yet and resolving one throws, so
 * reading it per call keeps the app (and /health) booting - the courses and
 * students pattern.
 */
export const createTeacherService = (deps: TeacherServiceDeps) => ({
  /** `GET /teachers` - admin list with filters, search, sort and paging. */
  async listTeachers(query: TeacherListQuery): Promise<PaginatedResult<Teacher>> {
    // api-contracts 3.8: a client string never reaches the repository. An
    // unknown or hostile `sortBy` falls back to the default order.
    const field = resolveSortField(query.sortBy, TEACHER_SORT_FIELDS);
    const sort: TeacherSort =
      field === undefined ? DEFAULT_TEACHER_SORT : { field, order: query.sortOrder };

    const filter: TeacherFilter = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.specialization === undefined ? {} : { specialization: query.specialization }),
      ...(query.courseId === undefined ? {} : { courseId: query.courseId }),
      ...(query.batchId === undefined ? {} : { batchId: query.batchId }),
      ...(query.search === undefined ? {} : { search: query.search }),
    };

    const result = await deps.teachers.findMany(
      filter,
      { page: query.page, pageSize: query.pageSize },
      sort,
    );

    // Built field by field - never `{ ...result }`. Spreading the adapter's
    // object would forward any extra property it returns (a debug query, a
    // cursor) straight to the client, bypassing the whitelist. Only the
    // contract's PaginatedResult fields leave: items (each whitelisted),
    // total, page, pageSize, and totalPages derived by the shared helper.
    return toPaginatedResult(result.items.map(toTeacherResponse), result.total, {
      page: result.page,
      pageSize: result.pageSize,
    });
  },

  /** `GET /teachers/:teacherId` - one teacher, or 404. */
  async getTeacherById(id: EntityId): Promise<Teacher> {
    const teacher = await deps.teachers.findById(id);

    if (teacher === null) {
      throw ApiError.notFound("Teacher not found");
    }

    return toTeacherResponse(teacher);
  },

  /**
   * `PATCH /teachers/:teacherId` - admin updates PROFILE fields.
   *
   * The repository input is built from an explicit WHITELIST, never from
   * the request body: even a caller that bypasses the HTTP schema (a job, a
   * script) cannot change `email`, `role`, `status`, `rating`, assignments,
   * `avatarUrl` (a user-record field, Q25), or the deferred identity fields
   * `name` / `mobile` - note that `UpdateTeacherInput` itself still permits
   * `name` and `mobile`, so it is this list, not the type, that enforces the
   * rule for those two.
   */
  async updateTeacher(id: EntityId, body: UpdateTeacherBody): Promise<Teacher> {
    const input: UpdateTeacherInput = {
      ...(body.specialization === undefined ? {} : { specialization: body.specialization }),
      ...(body.experienceYears === undefined ? {} : { experienceYears: body.experienceYears }),
      ...(body.bio === undefined ? {} : { bio: body.bio }),
      ...(body.qualifications === undefined ? {} : { qualifications: body.qualifications }),
    };

    if (Object.keys(input).length === 0) {
      // Also enforced by the schema; repeated so the service is safe when
      // called without HTTP validation, and never "succeeds" doing nothing.
      throw ApiError.validation([
        { field: "body", message: "Provide at least one updatable field" },
      ]);
    }

    return toTeacherResponse(await deps.teachers.update(id, input).catch(rethrowAsApiError));
  },
});

export type TeacherService = ReturnType<typeof createTeacherService>;
