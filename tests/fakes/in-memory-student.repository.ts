import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserStatus } from "../../src/contracts/user.contract";
import type { StudentRepository } from "../../src/modules/students/student.repository";
import type {
  ApprovalDecision,
  CreateStudentInput,
  Student,
  StudentFilter,
  UpdateStudentInput,
} from "../../src/modules/students/student.types";
import { DuplicateRecordError } from "../../src/repositories/repository.errors";
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
export class InMemoryStudentRepository implements StudentRepository {
  private readonly store = new InMemoryStore<Student>("student");

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
  ): Promise<PaginatedResult<Student>> {
    const rows = this.store.filter((student) => {
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

      // filter.batchId is not resolvable from the Student shape alone -
      // batch membership lives on the enrolment. A real adapter joins;
      // the fake deliberately ignores it rather than pretending.
      return true;
    });

    return paginate(rows, pagination);
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
