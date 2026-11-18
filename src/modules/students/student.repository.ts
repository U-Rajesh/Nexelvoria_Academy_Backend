import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type {
  ApprovalDecision,
  CreateStudentInput,
  Student,
  StudentFilter,
  StudentProfileInput,
  StudentSort,
  UpdateStudentInput,
} from "./student.types";

/**
 * The `students` repository PORT. Interface only - no SQL, no driver.
 *
 * Every operation here maps to a confirmed endpoint in
 * docs/api-contracts.md section 5. Nothing speculative is included.
 */
export interface StudentRepository {
  /** Returns the student, or null when absent. */
  findById(id: EntityId): Promise<Student | null>;

  /** Case-insensitive email lookup, for registration conflict checks. */
  findByEmail(email: string): Promise<Student | null>;

  /** True when a student already holds this email. Drives the 409. */
  existsByEmail(email: string): Promise<boolean>;

  /** True when a student already holds this mobile. Drives the 409. */
  existsByMobile(mobile: string): Promise<boolean>;

  /**
   * Paginated list. Backs `GET /students` (admin) and the approvals view
   * via `filter.approvalStatus = "pending"`.
   *
   * `filter.batchId` means "has an enrolment in that batch" - batch
   * membership lives on the enrolment, not the student, so an adapter
   * joins to enrolments to satisfy it.
   *
   * `sort` is OPTIONAL (added at Step 3, Task 3.1; backward compatible).
   * When given, its field has already been checked against
   * `STUDENT_SORT_FIELDS` by the service. When OMITTED, the approved
   * default applies: `createdAt DESC`. In every case `id ASC` is the final
   * tiebreaker, so OFFSET/FETCH paging never repeats or skips rows
   * (database-handoff Q-I1).
   */
  findMany(
    filter: StudentFilter,
    pagination: PaginationQuery,
    sort?: StudentSort,
  ): Promise<PaginatedResult<Student>>;

  /**
   * Creates a student.
   * Throws DuplicateRecordError when the email or mobile is taken.
   */
  create(input: CreateStudentInput): Promise<Student>;

  /**
   * Creates the student profile for a user that ALREADY EXISTS, sharing its
   * id. This is the registration path (Step 6K); `create` above remains the
   * path for a standalone student record and is unchanged.
   *
   * THE INVARIANT: `Student.id === User.id` (open-questions Q25, Option A -
   * a one-to-one shared primary key). An adapter MUST use `userId` as the
   * student's primary key and MUST NOT generate a second id. That shared key
   * is what makes the profile reachable from the identity login resolves; a
   * separately-keyed row would be an orphan invisible to
   * `UserRepository.findByEmail`, and therefore invisible to login.
   *
   * IDENTITY IS NOT DUPLICATED. `name`, `email`, `mobile`, `status`,
   * `avatarUrl` and `createdAt` are read from the user record, never taken
   * from `profile` - which is why `StudentProfileInput` does not carry them.
   * A SQL adapter satisfies this with a join.
   *
   * DOES NOT re-check email or mobile uniqueness. The user row already owns
   * those constraints, so checking again would throw a duplicate on the
   * identifiers registration has just reserved for this same person.
   *
   * DOES NOT create the user, and verifies, approves and activates nothing:
   * the profile starts `adminApprovalStatus: "pending"` with both
   * verification flags false, and `accountState` is left unset.
   *
   * ROLE IS CHECKED, NOT ASSUMED. The registration service fixes
   * `role: "student"` when it creates the user, so a mismatch here is a
   * programming error in the caller rather than a data condition a client
   * can provoke. An adapter must therefore FAIL rather than relabel a
   * teacher or an admin as a student. It throws a plain `Error`, deliberately
   * NOT a `RepositoryError`: the `RepositoryError` subtypes carry an agreed
   * HTTP mapping (not-found -> 404, duplicate -> 409) and this condition is
   * neither - it is a 500 that should reach whoever wrote the call.
   *
   * @throws RecordNotFoundError  when no user has `userId`.
   * @throws DuplicateRecordError when that user already has a profile.
   * @throws Error                when the user's role is not `student`.
   */
  createForUser(userId: EntityId, profile: StudentProfileInput): Promise<Student>;

  /** Patches profile fields. Throws RecordNotFoundError when absent. */
  update(id: EntityId, input: UpdateStudentInput): Promise<Student>;

  /** Admin status change (active / suspended / deactivated). Audited. */
  setStatus(id: EntityId, status: UserStatus): Promise<Student>;

  /**
   * Records an approval or rejection (BR-002: approval gates payment).
   * Separate from `update` because it is an audited decision with an
   * actor and a timestamp, not a profile edit.
   */
  recordApprovalDecision(id: EntityId, decision: ApprovalDecision): Promise<Student>;

  /**
   * Marks a verification channel confirmed.
   *
   * Takes the channel as an argument rather than exposing two methods,
   * because BR-001 wants both and Q3 may reduce it to email only - a
   * channel parameter survives that decision either way.
   */
  markVerified(id: EntityId, channel: "email" | "mobile"): Promise<Student>;

  /**
   * Clears a login lockout. Backs `POST /students/:id/unlock`.
   *
   * The lockout fields themselves belong to the unresolved auth design,
   * so this port only exposes the operation the admin UI confirms.
   */
  clearLockout(id: EntityId): Promise<Student>;
}
