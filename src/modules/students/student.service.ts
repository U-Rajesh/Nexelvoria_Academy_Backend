import type { PaginatedResult } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import { resolveSortField } from "../../middleware/validate.middleware";
import { RecordNotFoundError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import { HttpStatus } from "../../utils/http-status";
import { deriveAccountState } from "./account-state";
import type { StudentAudit, StudentRepository } from "./student.repository";
import {
  DEFAULT_STUDENT_SORT,
  STUDENT_SORT_FIELDS,
  type AdminApprovalStatus,
  type AdminSettableStudentStatus,
  type Student,
  type StudentFilter,
  type StudentSort,
  type UpdateStudentInput,
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
  /**
   * DERIVED, never passed through from storage.
   *
   * Approved by the backend lead at Phase 5 Stage 0: `accountState` is a
   * view over `status`, `isEmailVerified` and `adminApprovalStatus`, all of
   * which are already stored. Reading a stored copy here would make it a
   * SECOND source of truth that can disagree with the three facts behind it
   * - an approved student still showing `pending_approval` because a write
   * site forgot to update it.
   *
   * Computing it on the way out means the response cannot be stale, and the
   * database needs no column (database-handoff section 16.1).
   *
   * API behaviour is unchanged: the field is still present and still carries
   * one of the same six values. It is simply correct by construction now.
   * `undefined` is omitted exactly as before, which happens only when the
   * stored facts name no `AccountState` - see `deriveAccountState`.
   */
  ...(() => {
    const accountState = deriveAccountState({
      status: student.status,
      isEmailVerified: student.isEmailVerified,
      adminApprovalStatus: student.adminApprovalStatus,
    });

    return accountState === undefined ? {} : { accountState };
  })(),

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
/**
 * The ONLY approval states a decision may be made from.
 *
 * `pending` alone. A student who has already been approved or rejected has
 * had their decision; re-deciding is a different operation with different
 * rules (who may overturn a rejection, and what that does to a paid
 * enrolment), and none of those rules is confirmed. Refusing with a 409 is
 * honest - silently overwriting the first decision would destroy the audit
 * trail `recordApprovalDecision` exists to keep.
 */
const DECIDABLE_FROM: AdminApprovalStatus = "pending";

/**
 * Shared implementation behind approve and reject.
 *
 * Module-level and taking `deps` explicitly, because `createStudentService`
 * returns an object literal and has no closure body to hold it.
 *
 * ORDER OF CHECKS, and why: the student is READ FIRST so an unknown id is a
 * 404 and a wrong-state id is a 409. Calling `recordApprovalDecision`
 * straight away would collapse both into whatever the adapter threw, and a
 * 409 for a student who does not exist is actively misleading.
 *
 * The read-then-write is NOT atomic: two admins deciding simultaneously
 * could both pass the state check. The window is small and the outcome is a
 * second audited decision rather than corrupt data, so it is accepted and
 * recorded here rather than guarded with a transaction that does not exist
 * yet (open-questions Q-X1).
 */
const recordDecision = async (
  deps: StudentServiceDeps,
  id: EntityId,
  status: Extract<AdminApprovalStatus, "approved" | "rejected">,
  decidedByUserId: EntityId,
  remarks?: string,
  audit?: StudentAudit,
): Promise<Student> => {
  const existing = await deps.students.findById(id);

  if (existing === null) {
    throw ApiError.notFound("Student not found");
  }

  if (existing.adminApprovalStatus !== DECIDABLE_FROM) {
    // 409, per api-contracts 5 #7 ("not in a rejectable state").
    throw ApiError.conflict(
      `This registration has already been ${existing.adminApprovalStatus}. ` +
        "A decision can only be recorded once.",
    );
  }

  // BR-001 before BR-002: a student can be APPROVED only after the email OTP
  // is verified. Mobile OTP is deferred at launch (BR-001 clarification
  // CL-001, docs/open-questions.md Q3; BR-014 unchanged), so mobile
  // verification is not required. Rejection is not gated.
  if (status === "approved" && !existing.isEmailVerified) {
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "The student's email address is not verified yet. Approval requires email verification.",
      "EMAIL_NOT_VERIFIED",
    );
  }

  try {
    return toStudentResponse(
      await deps.students.recordApprovalDecision(id, {
        status,
        decidedByUserId,
        decidedAt: new Date().toISOString(),
        ...(remarks === undefined || remarks === "" ? {} : { remarks }),
      }, audit),
    );
  } catch (err) {
    // Lost the race described above, or the row vanished between the two
    // calls.
    if (err instanceof RecordNotFoundError) {
      throw ApiError.notFound("Student not found");
    }

    throw err;
  }
};

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
  async setStudentStatus(id: EntityId, status: AdminSettableStudentStatus, audit?: StudentAudit): Promise<Student> {
    // Approved rule (Milestone 4 review, as clarified by CL-001): only an
    // approved student with a verified email can be activated, so activation
    // never bypasses BR-001 / BR-002 - including for an account an admin has
    // just created. Mobile OTP is deferred at launch. Suspension and
    // deactivation stay available for every student.
    if (status === "active") {
      const existing = await deps.students.findById(id);
      if (existing === null) {
        throw ApiError.notFound("Student not found");
      }
      if (existing.adminApprovalStatus !== "approved") {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "Only an approved student can be activated.",
          "STUDENT_NOT_APPROVED",
        );
      }
      if (!existing.isEmailVerified) {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "A student must have a verified email address before activation.",
          "STUDENT_NOT_VERIFIED",
        );
      }
    }

    try {
      return toStudentResponse(await deps.students.setStatus(id, status, audit));
    } catch (err) {
      if (err instanceof RecordNotFoundError) {
        throw ApiError.notFound("Student not found");
      }
      throw err;
    }
  },

  /**
   * `POST /students/:studentId/approve` - the BR-002 approval gate
   * (api-contracts 5 #6).
   *
   * Records an audited decision through `recordApprovalDecision`, never
   * through `update`: the port separates the two precisely because a
   * decision carries an actor and a timestamp.
   *
   * `decidedByUserId` is the AUTHENTICATED ADMIN, passed in by the
   * controller from `req.principal`. It is never read from the request body
   * - a client that could name the deciding admin could forge an audit
   * trail, which is the whole value of the field.
   *
   * WHAT THIS DOES NOT DO: it does not set `status = "active"`. BR-002 says
   * approval gates PAYMENT, and activation follows payment, so activating
   * here would skip a step nobody has approved. It also writes no
   * `accountState` - that value is derived (see account-state.ts).
   *
   * Approval IS blocked until the email is verified (BR-001 as clarified by
   * CL-001): 422 EMAIL_NOT_VERIFIED. Mobile OTP is deferred at launch, so the
   * mobile number stays recorded as unverified. Rejection is not gated.
   */
  async approveStudent(
    id: EntityId,
    decidedByUserId: EntityId,
    remarks?: string,
    audit?: StudentAudit,
  ): Promise<Student> {
    return recordDecision(deps, id, "approved", decidedByUserId, remarks, audit);
  },

  /**
   * `POST /students/:studentId/reject` - api-contracts 5 #7.
   *
   * Remarks are mandatory and validated at the edge
   * (`studentRejectBodySchema`), so by here they are present and non-blank.
   */
  async rejectStudent(
    id: EntityId,
    decidedByUserId: EntityId,
    remarks: string,
    audit?: StudentAudit,
  ): Promise<Student> {
    return recordDecision(deps, id, "rejected", decidedByUserId, remarks, audit);
  },

  /** `PUT /students/me` - student updates their own profile */
  async updateStudentProfile(id: EntityId, input: UpdateStudentInput): Promise<Student> {
    try {
      const updated = await deps.students.update(id, input);
      return toStudentResponse(updated);
    } catch (err) {
      if (err instanceof RecordNotFoundError) {
        throw ApiError.notFound("Student not found");
      }
      throw err;
    }
  },
});

export type StudentService = ReturnType<typeof createStudentService>;
