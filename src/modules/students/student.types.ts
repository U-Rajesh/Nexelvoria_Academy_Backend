import type { SortOrder } from "../../contracts/api.contract";
import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";
import type { AccountState } from "../../contracts/user.contract";
import type { User } from "../users/user.types";

/**
 * The `students` domain.
 *
 * CONFIRMED - every field is copied from the frontend's `StudentProfile`
 * in `src/types/user.types.ts`. Nothing is invented.
 *
 * Note the deliberate omissions at the end of this file: security and
 * session fields that belong to authentication, which is not designed yet.
 */

/**
 * Approval outcome for a student registration (BR-002).
 * A const array so the zod schemas derive from the same list - the union
 * is unchanged.
 */
export const ADMIN_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type AdminApprovalStatus = (typeof ADMIN_APPROVAL_STATUSES)[number];

/**
 * The `status` values an admin may SET through
 * `PATCH /students/:studentId/status` (api-contracts 5 #4: "active /
 * suspended / deactivated"). A strict subset of `UserStatus`: `pending` is
 * a valid stored status but is not set by this endpoint, so it is a 422.
 */
export const ADMIN_SETTABLE_STUDENT_STATUSES = ["active", "suspended", "deactivated"] as const;
export type AdminSettableStudentStatus = (typeof ADMIN_SETTABLE_STUDENT_STATUSES)[number];

/**
 * Sortable student fields - the allow-list every `sortBy` is checked
 * against (api-contracts 3.6 / 3.8). Approved by the backend lead at
 * Step 3, Task 3.1.
 */
export const STUDENT_SORT_FIELDS = ["name", "createdAt", "passingYear"] as const;
export type StudentSortField = (typeof STUDENT_SORT_FIELDS)[number];

/** Sort instruction passed to `StudentRepository.findMany`. */
export interface StudentSort {
  field: StudentSortField;
  order: SortOrder;
}

/**
 * The approved DEFAULT order when a caller requests none: newest
 * registrations first. (`id ASC` is always appended as the final
 * tiebreaker - see the repository port.)
 */
export const DEFAULT_STUDENT_SORT: StudentSort = { field: "createdAt", order: "desc" };

/** Gender values, exactly as the frontend declares them. */
export type Gender = "male" | "female" | "other";

/**
 * A student. Extends the shared `User` identity with the academic and
 * admissions fields the frontend already collects and renders.
 */
export interface Student extends User {
  role: "student";

  /** Lifecycle state, distinct from `status`. */
  accountState?: AccountState;

  // --- Admissions data captured at registration ---
  collegeName: string;
  degreeBranch: string;
  passingYear: string;
  courseInterestedIn: string;
  dateOfBirth: string;
  gender: Gender;
  fullAddress: string;
  guardianContact?: string;

  // --- Resume / profile links ---
  resumeUrl?: string;
  resumeFileName?: string;
  resumeFileSize?: string;
  linkedInUrl?: string;
  githubUrl?: string;

  // --- Verification (BR-001, blocked by open-questions Q3) ---
  isEmailVerified: boolean;
  isMobileVerified: boolean;

  // --- Admin approval gate before payment (BR-002) ---
  adminApprovalStatus: AdminApprovalStatus;
  adminApprovalRemarks?: string;
  approvedAt?: IsoDateTime;

  /**
   * Courses this student is enrolled on.
   *
   * The frontend models this as an array on the student. Whether the
   * database stores it that way or derives it from the enrolments table is
   * the database team's call - this field is how the API must RESPOND, not
   * a statement about storage. Flagged in the handoff document.
   */
  enrolledCourseIds: EntityId[];
}

/**
 * DELIBERATELY NOT MODELLED YET - the frontend's `StudentProfile` also
 * carries `twoFactorEnabled`, `twoFactorSettings`, `activeSessions`,
 * `loginHistory`, `failedLoginAttempts`, `lockedUntil`,
 * `lastPasswordChange` and `resumeDataUrl`.
 *
 * The first seven belong to authentication and session management, which
 * is unresolved (Q13 token strategy, Q14 2FA methods). Modelling them now
 * would hard-code a guess into the repository port. `resumeDataUrl` is a
 * base64 artefact of the localStorage mock and must NOT be persisted
 * (Q11) - a file goes to object storage and the row keeps a key.
 *
 * `lockedUntil` is referenced by `clearLockout()` below because the admin
 * unlock endpoint is confirmed; the field itself is owned by the auth
 * design.
 */

/** Filters the student list endpoints need (api-contracts section 5). */
export interface StudentFilter {
  status?: Student["status"];
  approvalStatus?: AdminApprovalStatus;
  /**
   * Currently resolved against `student.enrolledCourseIds` (the in-memory
   * fake does exactly that). Whether that array is stored or derived from
   * enrolments is UNRESOLVED (database-handoff Q-R1), so this filter's
   * long-term source of truth - and which enrolment statuses count - is
   * not yet decided.
   */
  courseId?: EntityId;
  batchId?: EntityId;
  passingYear?: string;
  /** Free-text across name, email, mobile and collegeName. */
  search?: string;
}

/** Fields accepted when an admin creates a student, or one registers. */
export type CreateStudentInput = Omit<
  Student,
  | "id"
  | "createdAt"
  | "role"
  | "isEmailVerified"
  | "isMobileVerified"
  | "adminApprovalStatus"
  | "enrolledCourseIds"
  | "approvedAt"
  | "adminApprovalRemarks"
>;

/** Fields a student may change on their own profile. */
export type UpdateStudentInput = Partial<
  Pick<
    Student,
    | "name"
    | "mobile"
    | "avatarUrl"
    | "collegeName"
    | "degreeBranch"
    | "passingYear"
    | "dateOfBirth"
    | "gender"
    | "fullAddress"
    | "guardianContact"
    | "linkedInUrl"
    | "githubUrl"
    | "resumeUrl"
    | "resumeFileName"
    | "resumeFileSize"
  >
>;

/** Recorded when an admin approves or rejects a registration. */
export interface ApprovalDecision {
  status: Extract<AdminApprovalStatus, "approved" | "rejected">;
  /** Mandatory for a rejection; the frontend requires it. */
  remarks?: string;
  /** The deciding admin, taken from the session - never from the body. */
  decidedByUserId: EntityId;
  decidedAt: IsoDateTime;
}
