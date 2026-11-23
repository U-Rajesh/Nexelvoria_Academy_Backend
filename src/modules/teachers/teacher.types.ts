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
export type UpdateTeacherInput = {
  [K in "name" | "mobile" | "avatarUrl" | "specialization" | "experienceYears" | "bio" | "qualifications"]?:
    | Teacher[K]
    | undefined;
};

export interface BatchStudentInfo {
  studentId: string;
  studentName: string;
  email: string;
  mobile: string;
  batchId: string;
  batchName: string;
  courseTitle: string;
}

export interface ClassSessionRecord {
  id: string;
  batchId: string;
  courseId: string;
  teacherUserId: string;
  sessionTitle: string;
  startsAt: string;
  endsAt: string;
  meetingUrl?: string | undefined;
  status: string;
  createdAt: string;
}

export interface AttendanceItem {
  id: string;
  classSessionId: string;
  studentUserId: string;
  status: "present" | "absent" | "late" | "excused";
  remarks?: string | undefined;
  markedAt: string;
  markedByUserId: string;
}

export interface AssignmentRecord {
  id: string;
  courseId: string;
  batchId?: string | undefined;
  lessonId?: string | undefined;
  title: string;
  instructions?: string | undefined;
  maximumMarks: number;
  dueAt?: string | undefined;
  allowLateSubmission: boolean;
  status: string;
  createdByTeacherUserId: string;
  createdAt: string;
}

export interface AssignmentSubmissionRecord {
  id: string;
  assignmentId: string;
  studentUserId: string;
  submissionType: string;
  githubUrl?: string | undefined;
  textContent?: string | undefined;
  objectKey?: string | undefined;
  status: string;
  submittedAt: string;
  marksAwarded?: number | undefined;
  feedback?: string | undefined;
  evaluatedAt?: string | undefined;
}

export interface LearningMaterialRecord {
  id: string;
  lessonId: string;
  materialName: string;
  materialType: string;
  externalUrl?: string | undefined;
  fileSizeBytes?: number | undefined;
  mimeType?: string | undefined;
  uploadedByUserId?: string | undefined;
  createdAt: string;
}

export interface LessonDoubtRecord {
  id: string;
  lessonId: string;
  studentUserId: string;
  doubtText: string;
  status: string;
  createdAt: string;
  resolvedAt?: string | undefined;
  replyText?: string | undefined;
}

export interface OnlineTestRecord {
  id: string;
  courseId: string;
  batchId?: string | undefined;
  title: string;
  instructions?: string | undefined;
  durationMinutes: number;
  maximumMarks: number;
  passingMarks?: number | undefined;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  maxAttempts: number;
  status: string;
  createdByTeacherUserId: string;
  createdAt: string;
}

export interface TestAttemptRecord {
  id: string;
  testId: string;
  studentUserId: string;
  attemptNumber: number;
  totalMarks?: number | undefined;
  status: string;
  startedAt: string;
  submittedAt?: string | undefined;
  evaluatedAt?: string | undefined;
}
