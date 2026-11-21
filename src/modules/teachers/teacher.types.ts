import type { EntityId } from "../../contracts/identifier.contract";
import type { User } from "../users/user.types";

/**
 * The `teachers` domain.
 *
 * CONFIRMED - fields copied from the frontend's `TeacherProfile` in
 * `src/types/user.types.ts`.
 */
export interface Teacher extends User {
  role: "teacher";

  specialization: string;
  experienceYears: number;
  bio: string;
  qualifications: string;

  /**
   * Courses and batches allocated to this teacher.
   *
   * The frontend models these as arrays on the teacher. An allocation is
   * really a relationship between teacher, course and batch, so the
   * database team may well normalise it - these arrays describe the API
   * response shape, not the storage. See `TeacherAllocation` below and
   * the handoff document.
   */
  assignedCourseIds: EntityId[];
  assignedBatchIds: EntityId[];

  /** Aggregate rating shown in the UI. Derivation rule is unconfirmed. */
  rating: number;
}

/**
 * One teacher-to-batch allocation.
 *
 * Modelled explicitly because `allocateTeacher(teacherId, courseId,
 * batchId)` carries all three ids, which the two arrays on `Teacher`
 * cannot express together. This is a PROPOSED shape for the relationship;
 * the database team decides how it is stored.
 */
export interface TeacherAllocation {
  teacherId: EntityId;
  courseId: EntityId;
  batchId: EntityId;
}

/** Filters for the teacher list endpoint. */
export interface TeacherFilter {
  status?: Teacher["status"];
  specialization?: string;
  courseId?: EntityId;
  batchId?: EntityId;
  /** Free-text across name, email and specialization. */
  search?: string;
}

/** Fields accepted when an admin creates a teacher. */
export type CreateTeacherInput = Omit<
  Teacher,
  "id" | "createdAt" | "role" | "status" | "assignedCourseIds" | "assignedBatchIds" | "rating"
>;

/** Mutable teacher fields. */
export type UpdateTeacherInput = Partial<
  Pick<
    Teacher,
    | "name"
    | "mobile"
    | "avatarUrl"
    | "specialization"
    | "experienceYears"
    | "bio"
    | "qualifications"
  >
>;
