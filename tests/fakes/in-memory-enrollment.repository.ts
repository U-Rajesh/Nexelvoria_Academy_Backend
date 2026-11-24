import type { PaginatedResult, PaginationQuery } from "../../src/contracts/api.contract";
import type { EntityId } from "../../src/contracts/identifier.contract";
import { BatchFullError, type EnrollmentRepository } from "../../src/modules/enrollments/enrollment.repository";
import type {
  CreateEnrollmentInput,
  Enrollment,
  EnrollmentFilter,
  EnrollmentStatus,
} from "../../src/modules/enrollments/enrollment.types";
import { DuplicateRecordError } from "../../src/repositories/repository.errors";
import { InMemoryStore, paginate } from "./in-memory-store";

/** TEST-ONLY in-memory `EnrollmentRepository`. See in-memory-store.ts. */
export class InMemoryEnrollmentRepository implements EnrollmentRepository {
  private readonly store = new InMemoryStore<Enrollment>("enrollment");

  reset(): void {
    this.store.reset();
    this.statusHistory = [];
  }

  seed(enrollment: Enrollment): Enrollment {
    return this.store.set(enrollment);
  }

  get count(): number {
    return this.store.size;
  }

  async findById(id: EntityId): Promise<Enrollment | null> {
    return this.store.get(id);
  }

  async findByStudentAndCourse(
    studentId: EntityId,
    courseId: EntityId,
  ): Promise<Enrollment | null> {
    return this.store.find((e) => e.studentId === studentId && e.courseId === courseId);
  }

  async findByStudent(studentId: EntityId): Promise<Enrollment[]> {
    return this.store.filter((e) => e.studentId === studentId);
  }

  async findMany(
    filter: EnrollmentFilter,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Enrollment>> {
    const rows = this.store.filter((enrollment) => {
      if (filter.studentId !== undefined && enrollment.studentId !== filter.studentId) {
        return false;
      }

      if (filter.courseId !== undefined && enrollment.courseId !== filter.courseId) return false;
      if (filter.batchId !== undefined && enrollment.batchId !== filter.batchId) return false;
      if (filter.status !== undefined && enrollment.status !== filter.status) return false;

      if (
        filter.enrollmentType !== undefined &&
        enrollment.enrollmentType !== filter.enrollmentType
      ) {
        return false;
      }

      return true;
    });

    return paginate(rows, pagination);
  }

  /** D6: NXA_Batches.Capacity per batch (the harness reads the admin fake's batches); null = no limit. */
  batchCapacity?: (batchId: string) => number | null | undefined;

  async create(input: CreateEnrollmentInput): Promise<Enrollment> {
    const existing = await this.findByStudentAndCourse(input.studentId, input.courseId);

    if (existing !== null) {
      throw new DuplicateRecordError("enrollment", "studentId+courseId", input.studentId);
    }

    const { enforceBatchCapacity, ...fields } = input;
    if (enforceBatchCapacity && input.batchId) {
      // Mirrors the SQL adapter: every status except cancelled counts.
      const capacity = this.batchCapacity?.(String(input.batchId));
      const enrolled = this.store.all().filter((e) => e.batchId === input.batchId && e.status !== "cancelled").length;
      if (capacity !== null && capacity !== undefined && enrolled >= capacity) throw new BatchFullError(String(input.batchId), capacity);
    }

    return this.store.set({
      ...fields,
      id: this.store.nextId(),
      enrolledAt: new Date().toISOString(),
      progressPercentage: 0,
      completedLessonIds: [],
      bookmarkedLessonIds: [],
    });
  }

  /** Stands in for NXA_EnrollmentStatusHistory (written by setStatus). */
  statusHistory: Array<{ enrollmentId: string; oldStatus: string; newStatus: string; changedByUserId: string | null; reason?: string | undefined }> = [];

  async setStatus(
    id: EntityId,
    status: EnrollmentStatus,
    history?: { changedByUserId: string | null; reason?: string | undefined },
  ): Promise<Enrollment> {
    const existing = this.store.getOrThrow(id);
    // Mirrors the SQL adapter: a no-op writes nothing.
    if (existing.status === status) return existing;
    this.statusHistory.push({
      enrollmentId: id,
      oldStatus: existing.status,
      newStatus: status,
      changedByUserId: history?.changedByUserId ?? null,
      reason: history?.reason,
    });

    return this.store.set({
      ...existing,
      status,
      ...(status === "completed" ? { completedAt: new Date().toISOString() } : {}),
    });
  }

  async markLessonCompleted(
    id: EntityId,
    lessonId: EntityId,
    progressPercentage: number,
  ): Promise<Enrollment> {
    const existing = this.store.getOrThrow(id);

    // Idempotent: a retried request must not double-count the lesson.
    const completed = new Set(existing.completedLessonIds);
    completed.add(lessonId);

    return this.store.set({
      ...existing,
      completedLessonIds: [...completed],
      progressPercentage,
    });
  }

  async addBookmark(id: EntityId, lessonId: EntityId): Promise<Enrollment> {
    const existing = this.store.getOrThrow(id);

    const bookmarks = new Set(existing.bookmarkedLessonIds);
    bookmarks.add(lessonId);

    return this.store.set({ ...existing, bookmarkedLessonIds: [...bookmarks] });
  }

  async removeBookmark(id: EntityId, lessonId: EntityId): Promise<Enrollment> {
    const existing = this.store.getOrThrow(id);

    // Removing an absent bookmark is a no-op, not an error.
    return this.store.set({
      ...existing,
      bookmarkedLessonIds: existing.bookmarkedLessonIds.filter((l) => l !== lessonId),
    });
  }

  async countActiveByBatch(batchId: EntityId): Promise<number> {
    return this.store.filter((e) => e.batchId === batchId && e.status === "active").length;
  }
}
