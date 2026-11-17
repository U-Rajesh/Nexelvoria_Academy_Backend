import type { EntityId, IsoDateTime } from "../../contracts/identifier.contract";

/**
 * The `enrollments` domain.
 *
 * CONFIRMED - fields copied from the frontend's
 * `src/types/enrollment.types.ts`.
 *
 * This entity is the access-control backbone of the LMS: `status`
 * decides whether a student gets preview-only access (BR-003) or the full
 * course, so it is read on the content path, not just displayed.
 */

/** Lifecycle, exactly as the frontend declares it. */
export type EnrollmentStatus =
  /** Waiting for an admin to approve the application (BR-002). */
  | "pending_approval"
  /** Approved, awaiting payment. Grants preview-only access (BR-003). */
  | "approved_unpaid"
  /** Payment verified; full access. */
  | "active"
  | "completed"
  | "cancelled"
  | "suspended";

/** Who initiated the enrolment. */
export type EnrollmentType = "self" | "admin";

export interface Enrollment {
  id: EntityId;
  studentId: EntityId;
  courseId: EntityId;
  batchId?: EntityId;
  enrollmentType?: EnrollmentType;
  status: EnrollmentStatus;
  enrolledAt: IsoDateTime;
  completedAt?: IsoDateTime;

  /** Percentage, derived from completedLessonIds against the curriculum. */
  progressPercentage: number;
  completedLessonIds: EntityId[];
  bookmarkedLessonIds: EntityId[];

  /**
   * Full access without payment, granted by an approved financial
   * override (super-admin). This is the field that lets a student bypass
   * the payment gate, so any content check must honour it.
   */
  isAuthorizedFreeAccess?: boolean;
  overrideReason?: string;
  overrideApprovedBy?: EntityId;
}

/** Filters for the admin enrolment list. */
export interface EnrollmentFilter {
  studentId?: EntityId;
  courseId?: EntityId;
  batchId?: EntityId;
  status?: EnrollmentStatus;
  enrollmentType?: EnrollmentType;
}

/** Fields accepted when creating an enrolment. */
export interface CreateEnrollmentInput {
  studentId: EntityId;
  courseId: EntityId;
  batchId?: EntityId;
  enrollmentType: EnrollmentType;
  status: EnrollmentStatus;
}
