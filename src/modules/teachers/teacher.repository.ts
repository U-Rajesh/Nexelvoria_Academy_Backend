import type { PaginatedResult, PaginationQuery } from "../../contracts/api.contract";
import type { EntityId } from "../../contracts/identifier.contract";
import type { UserStatus } from "../../contracts/user.contract";
import type {
  CreateTeacherInput,
  Teacher,
  TeacherAllocation,
  TeacherFilter,
  UpdateTeacherInput,
} from "./teacher.types";

/**
 * The `teachers` repository PORT. Interface only - no SQL, no driver.
 *
 * Maps to docs/api-contracts.md section 6.
 */
export interface TeacherRepository {
  findById(id: EntityId): Promise<Teacher | null>;

  findByEmail(email: string): Promise<Teacher | null>;

  existsByEmail(email: string): Promise<boolean>;

  findMany(filter: TeacherFilter, pagination: PaginationQuery): Promise<PaginatedResult<Teacher>>;

  create(input: CreateTeacherInput): Promise<Teacher>;

  update(id: EntityId, input: UpdateTeacherInput): Promise<Teacher>;

  setStatus(id: EntityId, status: UserStatus): Promise<Teacher>;

  // --- Allocations -------------------------------------------------------

  /**
   * Allocates a teacher to a course + batch.
   * Throws DuplicateRecordError if the same allocation already exists.
   */
  addAllocation(allocation: TeacherAllocation): Promise<Teacher>;

  /** Removes the allocation for a batch. Throws if the teacher is absent. */
  removeAllocation(teacherId: EntityId, batchId: EntityId): Promise<Teacher>;

  /** Every allocation held by one teacher. */
  findAllocations(teacherId: EntityId): Promise<TeacherAllocation[]>;

  /**
   * THE teacher authorization primitive.
   *
   * Step 3 identified this as the most important rule on the teacher
   * surface: a teacher may only read or mutate data for batches allocated
   * to them. Every teacher-scoped endpoint - attendance, assignments,
   * assessments, materials, rosters - must consult this, and must pass
   * the teacher id from the SESSION, never from the request.
   *
   * It is a repository operation rather than a service calculation so the
   * check can be a single indexed lookup instead of loading a teacher and
   * scanning an array.
   */
  isAllocatedToBatch(teacherId: EntityId, batchId: EntityId): Promise<boolean>;

  /** Teachers allocated to a batch. Backs batch detail views. */
  findByBatch(batchId: EntityId): Promise<Teacher[]>;
}
