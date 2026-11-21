import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserStatus } from "../../src/contracts/user.contract";
import type { EnrollmentRepository } from "../../src/modules/enrollments/enrollment.repository";
import type { StudentRepository } from "../../src/modules/students/student.repository";
import {
  DEFAULT_STUDENT_SORT,
  type ApprovalDecision,
  type CreateStudentInput,
  type Student,
  type StudentFilter,
  type StudentProfileInput,
  type StudentSort,
  type UpdateStudentInput,
} from "../../src/modules/students/student.types";
import type { UserRepository } from "../../src/modules/users/user.repository";
import {
  DuplicateRecordError,
  RecordNotFoundError,
} from "../../src/repositories/repository.errors";
import {
  InMemoryStore,
  containsIgnoreCase,
  equalsIgnoreCase,
  paginate,
} from "./in-memory-store";

/**
 * TEST-ONLY in-memory `StudentRepository`.
 *
 * Implementing the port explicitly is itself a check: if the interface
 * gains a method, this file stops compiling, so the fakes cannot silently
 * drift from the contract.
 */
/**
 * Where the fake learns batch membership for `filter.batchId`.
 *
 * Batch membership lives on the ENROLMENT, not the student, so a real
 * adapter joins to the enrolments table. The fake mirrors that by asking
 * the enrolment fake. Typed as a narrow slice of the PORT, not the fake
 * class, so this test-only wiring adds no production coupling.
 */
export type BatchMembershipSource = Pick<EnrollmentRepository, "findMany">;

/**
 * Where the fake reads the IDENTITY half of a student for `createForUser`.
 *
 * `Student extends User`, so a student row needs `name`, `email`, `mobile`,
 * `status`, `avatarUrl` and `createdAt` - and those live on the user record,
 * in a separate store with its own id sequence. `StudentProfileInput`
 * deliberately does not carry them, so the fake must read the user row, which
 * is exactly the join a real SQL adapter will perform.
 *
 * Typed as a narrow slice of the PORT, not the fake class, so this test-only
 * wiring adds no production coupling - the same approach as
 * `BatchMembershipSource` above.
 */
export type UserIdentitySource = Pick<UserRepository, "findById">;

/** Compares two sort keys case-insensitively (approximates SQL Server CI collation). */
const compareText = (a: string, b: string): number =>
  a.toLowerCase().localeCompare(b.toLowerCase());

/**
 * Final tiebreaker: `id ASC`, compared NUMERICALLY within the string so the
 * fake's sequential ids order like a BIGINT key ("student-2" before
 * "student-10"), not lexically.
 */
const compareIds = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });

const compareStudents = (a: Student, b: Student, sort: StudentSort): number => {
  const primary = compareText(a[sort.field], b[sort.field]);
  const directed = sort.order === "desc" ? -primary : primary;

  // id ASC regardless of direction (approved; database-handoff Q-I1).
  return directed !== 0 ? directed : compareIds(a.id, b.id);
};

export class InMemoryStudentRepository implements StudentRepository {
  private readonly store = new InMemoryStore<Student>("student");

  /**
   * Both dependencies are optional so existing standalone constructions keep
   * working. `createTestHarness()` always connects both. Without them the
   * operation that needs one THROWS rather than being silently ignored: a
   * `batchId` filter without `enrollments`, and `createForUser` without
   * `users`.
   */
  constructor(
    private readonly enrollments?: BatchMembershipSource,
    private readonly users?: UserIdentitySource,
  ) {}

  // --- test helpers ------------------------------------------------------

  /** Clears all data. Call between tests for isolation. */
  reset(): void {
    this.store.reset();
  }

  /** Inserts a fully formed student, bypassing create() validation. */
  seed(student: Student): Student {
    return this.store.set(student);
  }

  get count(): number {
    return this.store.size;
  }

  // --- reads -------------------------------------------------------------

  async findById(id: EntityId): Promise<Student | null> {
    return this.store.get(id);
  }

  async findByEmail(email: string): Promise<Student | null> {
    return this.store.find((s) => equalsIgnoreCase(s.email, email));
  }

  async existsByEmail(email: string): Promise<boolean> {
    return this.store.find((s) => equalsIgnoreCase(s.email, email)) !== null;
  }

  async existsByMobile(mobile: string): Promise<boolean> {
    return this.store.find((s) => s.mobile === mobile) !== null;
  }

  async findMany(
    filter: StudentFilter,
    pagination: PaginationQuery,
    sort: StudentSort = DEFAULT_STUDENT_SORT,
  ): Promise<PaginatedResult<Student>> {
    const inBatch =
      filter.batchId === undefined ? undefined : await this.studentIdsInBatch(filter.batchId);

    const rows = this.store.filter((student) => {
      if (inBatch !== undefined && !inBatch.has(student.id)) return false;

      if (filter.status !== undefined && student.status !== filter.status) return false;

      if (
        filter.approvalStatus !== undefined &&
        student.adminApprovalStatus !== filter.approvalStatus
      ) {
        return false;
      }

      if (filter.passingYear !== undefined && student.passingYear !== filter.passingYear) {
        return false;
      }

      if (
        filter.courseId !== undefined &&
        !student.enrolledCourseIds.includes(filter.courseId)
      ) {
        return false;
      }

      if (filter.search !== undefined) {
        const term = filter.search;
        const matches =
          containsIgnoreCase(student.name, term) ||
          containsIgnoreCase(student.email, term) ||
          containsIgnoreCase(student.mobile, term) ||
          containsIgnoreCase(student.collegeName, term);

        if (!matches) return false;
      }

      return true;
    });

    rows.sort((a, b) => compareStudents(a, b, sort));

    return paginate(rows, pagination);
  }

  /**
   * Student ids with ANY enrolment in the batch - mirroring a plain join.
   * Which enrolment statuses should count is not specified anywhere yet;
   * flagged for the adapter in the Task 3.1 report.
   */
  private async studentIdsInBatch(batchId: EntityId): Promise<Set<EntityId>> {
    if (this.enrollments === undefined) {
      throw new Error(
        "InMemoryStudentRepository: filter.batchId needs an enrolment source. " +
          "Use createTestHarness(), or pass the enrolment fake to the constructor.",
      );
    }

    const result = await this.enrollments.findMany(
      { batchId },
      { page: 1, pageSize: Number.MAX_SAFE_INTEGER },
    );

    return new Set(result.items.map((enrollment) => enrollment.studentId));
  }

  // --- writes ------------------------------------------------------------

  async create(input: CreateStudentInput): Promise<Student> {
    if (await this.existsByEmail(input.email)) {
      throw new DuplicateRecordError("student", "email", input.email);
    }

    if (await this.existsByMobile(input.mobile)) {
      throw new DuplicateRecordError("student", "mobile", input.mobile);
    }

    const student: Student = {
      ...input,
      id: this.store.nextId(),
      role: "student",
      createdAt: new Date().toISOString(),
      isEmailVerified: false,
      isMobileVerified: false,
      adminApprovalStatus: "pending",
      enrolledCourseIds: [],
    };

    return this.store.set(student);
  }

  /**
   * Registration path (Step 6K-1): the profile for an existing user, keyed by
   * that user's own id.
   *
   * Mirrors what a SQL adapter will do - read the user row (a join), then
   * insert a student row under the SAME key. `this.store.nextId()` is never
   * called here, and that absence is what enforces `Student.id === User.id`.
   */
  async createForUser(userId: EntityId, profile: StudentProfileInput): Promise<Student> {
    if (this.users === undefined) {
      throw new Error(
        "InMemoryStudentRepository: createForUser needs a user source. " +
          "Use createTestHarness(), or pass the user fake to the constructor.",
      );
    }

    const user = await this.users.findById(userId);

    if (user === null) {
      throw new RecordNotFoundError("user", userId);
    }

    // A plain Error, deliberately NOT a RepositoryError: the role is fixed
    // server-side when registration creates the user, so a mismatch is a bug
    // in the caller, and it must never be "resolved" by relabelling a
    // teacher or an admin as a student.
    if (user.role !== "student") {
      throw new Error(
        `Refusing to create a student profile for user ${userId}: the user's ` +
          `role is "${user.role}", not "student". A non-student user must ` +
          "never be converted into a student.",
      );
    }

    // Check and insert in ONE synchronous block, with no `await` between
    // them - the same discipline as InMemoryUserRepository.create. Every
    // await is a microtask boundary, so an await here would leave a race
    // that two concurrent calls could both win, which a SQL PRIMARY KEY
    // cannot have.
    if (this.store.has(userId)) {
      throw new DuplicateRecordError("student", "userId", userId);
    }

    const student: Student = {
      ...profile,

      // --- THE INVARIANT: the user's id, never a fresh one ---
      id: userId,

      // --- identity, from the USER row and never from the input ---
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      status: user.status,
      ...(user.avatarUrl === undefined ? {} : { avatarUrl: user.avatarUrl }),
      createdAt: user.createdAt,

      // --- server owned, exactly as `create` sets them ---
      role: "student",
      isEmailVerified: false,
      isMobileVerified: false,
      adminApprovalStatus: "pending",
      enrolledCourseIds: [],

      // `accountState` is deliberately left unset - see StudentProfileInput.
    };

    return this.store.set(student);
  }

  async update(id: EntityId, input: UpdateStudentInput): Promise<Student> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, ...input });
  }

  async setStatus(id: EntityId, status: UserStatus): Promise<Student> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, status });
  }

  async recordApprovalDecision(id: EntityId, decision: ApprovalDecision): Promise<Student> {
    const existing = this.store.getOrThrow(id);

    return this.store.set({
      ...existing,
      adminApprovalStatus: decision.status,
      ...(decision.remarks === undefined ? {} : { adminApprovalRemarks: decision.remarks }),
      approvedAt: decision.decidedAt,
      accountState: decision.status === "approved" ? "approved" : "rejected",
    });
  }

  async markVerified(id: EntityId, channel: "email" | "mobile"): Promise<Student> {
    const existing = this.store.getOrThrow(id);

    return this.store.set(
      channel === "email"
        ? { ...existing, isEmailVerified: true }
        : { ...existing, isMobileVerified: true },
    );
  }

  async clearLockout(id: EntityId): Promise<Student> {
    const existing = this.store.getOrThrow(id);

    // The lockout fields belong to the unresolved auth design, so the fake
    // only moves the account out of the `locked` state.
    return this.store.set({
      ...existing,
      ...(existing.accountState === "locked" ? { accountState: "approved" } : {}),
    });
  }
}
