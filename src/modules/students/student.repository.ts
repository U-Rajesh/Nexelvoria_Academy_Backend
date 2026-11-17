import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type {
  ApprovalDecision,
  CreateStudentInput,
  Student,
  StudentFilter,
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
   */
  findMany(filter: StudentFilter, pagination: PaginationQuery): Promise<PaginatedResult<Student>>;

  /**
   * Creates a student.
   * Throws DuplicateRecordError when the email or mobile is taken.
   */
  create(input: CreateStudentInput): Promise<Student>;

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
