import type { PaginatedResult } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import { resolveSortField } from "../../middleware/validate.middleware";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import type { StudentRepository } from "./student.repository";
import {
  DEFAULT_STUDENT_SORT,
  STUDENT_SORT_FIELDS,
  type AdminSettableStudentStatus,
  type Student,
  type StudentFilter,
  type StudentSort,
} from "./student.types";
import type { StudentListQuery } from "./student.validation";

/**
 * Business logic for the `students` module.
 *
 * Task 3.1: admin READ operations only. Status changes, approval,
 * rejection, unlock, admin create and the student's own `/me` endpoints are
 * later tasks, pending decisions D1-D5 from the Step 3 inspection.
 *
 * No `express` import and no `req`/`res` (architecture section 4).
 */

export interface StudentServiceDeps {
  students: StudentRepository;
}

/**
 * The ONLY shape a student leaves the API in - an explicit WHITELIST.
 *
 * TypeScript types do not strip properties at runtime, so returning the
 * repository object would send whatever an adapter happens to map - and
 * because `Student` extends `User`, the users table is exactly where
 * password hashes, OTP state and tokens are likely to live once
 * authentication exists. Building the response field by field means any
 * column not listed here (internal, credential or future) is dropped
 * until someone deliberately adds it.
 *
 * Fields = the agreed `StudentProfile` contract (api-contracts section 5,
 * frontend `src/types/user.types.ts`) MINUS the fields deliberately not
 * modelled (see student.types.ts): the auth/session fields
 * (`twoFactorEnabled`, `twoFactorSettings`, `activeSessions`,
 * `loginHistory`, `failedLoginAttempts`, `lockedUntil`,
 * `lastPasswordChange`) and `resumeDataUrl`. All of those are optional in
 * the frontend type, so this response is still a valid `StudentProfile`.
 */
export const toStudentResponse = (student: Student): Student => ({
  // --- User ---
  id: student.id,
  name: student.name,
  email: student.email,
  mobile: student.mobile,
  role: "student",
  status: student.status,
  createdAt: student.createdAt,
  ...(student.avatarUrl === undefined ? {} : { avatarUrl: student.avatarUrl }),

  // --- admissions data ---
  collegeName: student.collegeName,
  degreeBranch: student.degreeBranch,
  passingYear: student.passingYear,
  courseInterestedIn: student.courseInterestedIn,
  dateOfBirth: student.dateOfBirth,
  gender: student.gender,
  fullAddress: student.fullAddress,
  ...(student.guardianContact === undefined ? {} : { guardianContact: student.guardianContact }),

  // --- resume / profile links ---
  ...(student.resumeUrl === undefined ? {} : { resumeUrl: student.resumeUrl }),
  ...(student.resumeFileName === undefined ? {} : { resumeFileName: student.resumeFileName }),
  ...(student.resumeFileSize === undefined ? {} : { resumeFileSize: student.resumeFileSize }),
  ...(student.linkedInUrl === undefined ? {} : { linkedInUrl: student.linkedInUrl }),
  ...(student.githubUrl === undefined ? {} : { githubUrl: student.githubUrl }),

  // --- verification, approval, lifecycle ---
  isEmailVerified: student.isEmailVerified,
  isMobileVerified: student.isMobileVerified,
  adminApprovalStatus: student.adminApprovalStatus,
  ...(student.adminApprovalRemarks === undefined
    ? {}
    : { adminApprovalRemarks: student.adminApprovalRemarks }),
  ...(student.approvedAt === undefined ? {} : { approvedAt: student.approvedAt }),
  ...(student.accountState === undefined ? {} : { accountState: student.accountState }),

  enrolledCourseIds: [...student.enrolledCourseIds],
});

/**
 * Builds the student service.
 *
 * `deps.students` is read lazily inside each method, never at
 * construction: the production container has no adapter yet, and
 * resolving one throws. Reading it per call keeps the app (and /health)
 * booting - the same pattern as the courses module.
 */
export const createStudentService = (deps: StudentServiceDeps) => ({
  /**
   * `GET /students` - admin list with filters, search, sort and paging.
   * Also backs the approvals view via `approvalStatus=pending`
   * (api-contracts section 5).
   */
  async listStudents(query: StudentListQuery): Promise<PaginatedResult<Student>> {
    // api-contracts 3.8: a client string never reaches the repository. An
    // unknown or hostile `sortBy` falls back to the approved default.
    const field = resolveSortField(query.sortBy, STUDENT_SORT_FIELDS);
    const sort: StudentSort =
      field === undefined ? DEFAULT_STUDENT_SORT : { field, order: query.sortOrder };

    const filter: StudentFilter = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.approvalStatus === undefined ? {} : { approvalStatus: query.approvalStatus }),
      ...(query.courseId === undefined ? {} : { courseId: query.courseId }),
      ...(query.batchId === undefined ? {} : { batchId: query.batchId }),
      ...(query.passingYear === undefined ? {} : { passingYear: query.passingYear }),
      ...(query.search === undefined ? {} : { search: query.search }),
    };

    const result = await deps.students.findMany(
      filter,
      { page: query.page, pageSize: query.pageSize },
      sort,
    );

    // Never the raw repository rows - see toStudentResponse.
    return { ...result, items: result.items.map(toStudentResponse) };
  },

  /** `GET /students/:studentId` - one student, or 404. */
  async getStudentById(id: EntityId): Promise<Student> {
    const student = await deps.students.findById(id);

    if (student === null) {
      throw ApiError.notFound("Student not found");
    }

    return toStudentResponse(student);
  },

  /**
   * `PATCH /students/:studentId/status` - admin sets active / suspended /
   * deactivated (api-contracts 5 #4).
   *
   * Approved at Task 3.2 (D1, Option A): writes `status` ONLY, through the
   * existing `setStatus`. `accountState` is deliberately NOT touched - the
   * frontend mock also rewrites it (and resets failedLoginAttempts), but
   * that mapping is not a confirmed business rule. Consequence, recorded as
   * an integration concern: the admin list badge reads `accountState`, so it
   * will not reflect a suspension until status/accountState are reconciled.
   *
   * No transition rules: any of the three values may follow any status,
   * including the same one (idempotent), matching the frontend.
   *
   * Deferred: the audit entry the port comment calls for (shared audit
   * service, api-contracts section 15). Whether a suspended/deactivated
   * student can log in is enforced by AUTHENTICATION (Developer 1), not here.
   */
  async setStudentStatus(id: EntityId, status: AdminSettableStudentStatus): Promise<Student> {
    try {
      return toStudentResponse(await deps.students.setStatus(id, status));
    } catch (err) {
      if (err instanceof RecordNotFoundError) {
        throw ApiError.notFound("Student not found");
      }
      throw err;
    }
  },
});

export type StudentService = ReturnType<typeof createStudentService>;
