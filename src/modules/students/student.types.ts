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

/**
 * Fields accepted when creating a student PROFILE for a user that ALREADY
 * EXISTS - see `StudentRepository.createForUser`. This is the registration
 * path (Step 6K).
 *
 * Unlike `CreateStudentInput` above, which creates a standalone student and
 * therefore carries the identity itself, this type carries the ADMISSIONS
 * DATA ONLY. Three groups are deliberately excluded.
 *
 * 1. IDENTITY - `id`, `name`, `email`, `mobile`, `role`, `status`,
 *    `avatarUrl`, `createdAt`. Owned by the USER record, which is the single
 *    source of truth, and read from there by `createForUser`. Accepting them
 *    here would mean two places to keep in step, and would force the write
 *    to re-check the email and mobile uniqueness the user row already holds
 *    - which would throw a duplicate on the very identifiers registration
 *    just reserved for this same person.
 *
 * 2. VERIFICATION AND APPROVAL - `isEmailVerified`, `isMobileVerified`,
 *    `adminApprovalStatus`, `adminApprovalRemarks`, `approvedAt`. Server
 *    owned, so a caller can never self-verify (BR-001) or self-approve
 *    (BR-002).
 *
 * 3. `enrolledCourseIds` and `accountState`. Enrolments start empty.
 *    `accountState` is left UNSET rather than defaulted, for exactly the
 *    reason `setStudentStatus` leaves it alone (student.service.ts): the
 *    mapping between `status`, `adminApprovalStatus` and `accountState` is
 *    not a confirmed business rule. The field is optional on `Student`, so
 *    absent is valid; inventing a value would hard-code a guess into every
 *    adapter and into the admin list badge that reads it.
 *
 * Derived with `Omit` rather than written out by hand, so it cannot drift
 * from `Student` - the same approach as `CreateStudentInput` and
 * `UpdateStudentInput`.
 */
export type StudentProfileInput = Omit<
  Student,
  // identity - owned by the user record
  | "id"
  | "name"
  | "email"
  | "mobile"
  | "role"
  | "status"
  | "avatarUrl"
  | "createdAt"
  // verification and approval - server owned
  | "isEmailVerified"
  | "isMobileVerified"
  | "adminApprovalStatus"
  | "adminApprovalRemarks"
  | "approvedAt"
  // lifecycle - deliberately not defaulted; see note 3 above
  | "accountState"
  | "enrolledCourseIds"
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
