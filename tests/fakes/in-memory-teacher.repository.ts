import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId } from "../../src/contracts/identifier.contract";
import type { UserStatus } from "../../src/contracts/user.contract";
import type { TeacherRepository } from "../../src/modules/teachers/teacher.repository";
import type {
  CreateTeacherInput,
  Teacher,
  TeacherAllocation,
  TeacherFilter,
  UpdateTeacherInput,
} from "../../src/modules/teachers/teacher.types";
import { DuplicateRecordError } from "../../src/repositories/repository.errors";
import {
  InMemoryStore,
  containsIgnoreCase,
  equalsIgnoreCase,
  paginate,
} from "./in-memory-store";

/** TEST-ONLY in-memory `TeacherRepository`. See in-memory-store.ts. */
export class InMemoryTeacherRepository implements TeacherRepository {
  private readonly store = new InMemoryStore<Teacher>("teacher");

  /**
   * Allocations are held separately, not derived from the two arrays on
   * `Teacher`, because an allocation carries teacher + course + batch
   * together and those arrays cannot express the triple.
   */
  private allocations: TeacherAllocation[] = [];

  reset(): void {
    this.store.reset();
    this.allocations = [];
  }

  seed(teacher: Teacher): Teacher {
    return this.store.set(teacher);
  }

  get count(): number {
    return this.store.size;
  }

  async findById(id: EntityId): Promise<Teacher | null> {
    return this.store.get(id);
  }

  async findByEmail(email: string): Promise<Teacher | null> {
    return this.store.find((t) => equalsIgnoreCase(t.email, email));
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (await this.findByEmail(email)) !== null;
  }

  async findMany(
    filter: TeacherFilter,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Teacher>> {
    const rows = this.store.filter((teacher) => {
      if (filter.status !== undefined && teacher.status !== filter.status) return false;

      if (
        filter.specialization !== undefined &&
        !equalsIgnoreCase(teacher.specialization, filter.specialization)
      ) {
        return false;
      }

      if (
        filter.courseId !== undefined &&
        !teacher.assignedCourseIds.includes(filter.courseId)
      ) {
        return false;
      }

      if (filter.batchId !== undefined && !teacher.assignedBatchIds.includes(filter.batchId)) {
        return false;
      }

      if (filter.search !== undefined) {
        const term = filter.search;
        const matches =
          containsIgnoreCase(teacher.name, term) ||
          containsIgnoreCase(teacher.email, term) ||
          containsIgnoreCase(teacher.specialization, term);

        if (!matches) return false;
      }

      return true;
    });

    return paginate(rows, pagination);
  }

  async create(input: CreateTeacherInput): Promise<Teacher> {
    if (await this.existsByEmail(input.email)) {
      throw new DuplicateRecordError("teacher", "email", input.email);
    }

    return this.store.set({
      ...input,
      id: this.store.nextId(),
      role: "teacher",
      status: "active",
      createdAt: new Date().toISOString(),
      assignedCourseIds: [],
      assignedBatchIds: [],
      rating: 0,
    });
  }

  async update(id: EntityId, input: UpdateTeacherInput): Promise<Teacher> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, ...input });
  }

  async setStatus(id: EntityId, status: UserStatus): Promise<Teacher> {
    const existing = this.store.getOrThrow(id);
    return this.store.set({ ...existing, status });
  }

  async addAllocation(allocation: TeacherAllocation): Promise<Teacher> {
    const teacher = this.store.getOrThrow(allocation.teacherId);

    const duplicate = this.allocations.some(
      (a) =>
        a.teacherId === allocation.teacherId &&
        a.batchId === allocation.batchId &&
        a.courseId === allocation.courseId,
    );

    if (duplicate) {
      throw new DuplicateRecordError("teacherAllocation", "batchId", allocation.batchId);
    }

    this.allocations.push({ ...allocation });

    // Keep the denormalised arrays consistent with the allocation list,
    // because that is the shape the API returns.
    const courseIds = new Set(teacher.assignedCourseIds);
    courseIds.add(allocation.courseId);

    const batchIds = new Set(teacher.assignedBatchIds);
    batchIds.add(allocation.batchId);

    return this.store.set({
      ...teacher,
      assignedCourseIds: [...courseIds],
      assignedBatchIds: [...batchIds],
    });
  }

  async removeAllocation(teacherId: EntityId, batchId: EntityId): Promise<Teacher> {
    const teacher = this.store.getOrThrow(teacherId);

    this.allocations = this.allocations.filter(
      (a) => !(a.teacherId === teacherId && a.batchId === batchId),
    );

    const remaining = this.allocations.filter((a) => a.teacherId === teacherId);

    return this.store.set({
      ...teacher,
      assignedBatchIds: [...new Set(remaining.map((a) => a.batchId))],
      assignedCourseIds: [...new Set(remaining.map((a) => a.courseId))],
    });
  }

  async findAllocations(teacherId: EntityId): Promise<TeacherAllocation[]> {
    return this.allocations
      .filter((a) => a.teacherId === teacherId)
      .map((a) => ({ ...a }));
  }

  async isAllocatedToBatch(teacherId: EntityId, batchId: EntityId): Promise<boolean> {
    return this.allocations.some((a) => a.teacherId === teacherId && a.batchId === batchId);
  }

  async findByBatch(batchId: EntityId): Promise<Teacher[]> {
    const teacherIds = new Set(
      this.allocations.filter((a) => a.batchId === batchId).map((a) => a.teacherId),
    );

    return this.store.filter((t) => teacherIds.has(t.id));
  }
}
