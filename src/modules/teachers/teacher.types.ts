import type { SortOrder } from "../../contracts/api.contract";
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

/**
 * Sortable teacher fields - the allow-list every `sortBy` is checked
 * against (api-contracts 3.6 / 3.8). Added with the teacher list endpoint
 * (Teacher Management T1), following the courses and students pattern.
 */
export const TEACHER_SORT_FIELDS = ["name", "createdAt", "experienceYears"] as const;
export type TeacherSortField = (typeof TEACHER_SORT_FIELDS)[number];

/** Sort instruction passed to `TeacherRepository.findMany`. */
export interface TeacherSort {
  field: TeacherSortField;
  order: SortOrder;
}

/**
 * Default order when a caller requests none: newest first, matching the
 * students list. `id ASC` is always the final tiebreaker (see the port).
 */
export const DEFAULT_TEACHER_SORT: TeacherSort = { field: "createdAt", order: "desc" };

/** Fields accepted when an admin creates a teacher. */
export type CreateTeacherInput = Omit<
  Teacher,
  "id" | "createdAt" | "role" | "status" | "assignedCourseIds" | "assignedBatchIds" | "rating"
>;

/**
 * Mutable teacher fields.
 *
 * `avatarUrl` is deliberately NOT here: it is a `User` field (see
 * `UpdateUserInput`) which the adopted identity model treats as owned by
 * the user record (open-questions Q25; student.types.ts). Writing it on the
 * teacher record would diverge from the avatar the signed-in teacher sees.
 * It returns only through the user record, once teacher-to-user linkage is
 * decided. `name` and `mobile` remain listed but are NOT accepted by the
 * PATCH endpoint (deferred on the same linkage decision).
 */
export type UpdateTeacherInput = Partial<
  Pick<
    Teacher,
    | "name"
    | "mobile"
    | "specialization"
    | "experienceYears"
    | "bio"
    | "qualifications"
  >
>;
