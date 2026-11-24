import type { EntityId } from "../../contracts/identifier.contract";
import { HttpStatus } from "../../utils/http-status";
import { DuplicateRecordError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import type { CourseRepository } from "../courses/course.repository";
import type { StudentRepository } from "../students/student.repository";
import { BatchFullError, type EnrollmentRepository } from "./enrollment.repository";
import type { Enrollment, EnrollmentStatus } from "./enrollment.types";

/** Reads a batch from NXA_Batches (existing structure; no schema change). */
export interface BatchLookup {
  findBatchById(id: EntityId): Promise<{ courseId: string; status: string } | null>;
}

/** Same closed statuses the Admin enrollment and teacher allocation use. */
const CLOSED_BATCH_STATUSES = new Set(["completed", "cancelled"]);

export interface EnrollmentServiceDeps {
  enrollments: EnrollmentRepository;
  courses?: CourseRepository;
  students?: StudentRepository;
  /** Required to accept a batch on self-enrollment; without it a batch is refused. */
  batches?: BatchLookup;
}

export interface EnrichedEnrollment {
  enrollment: Enrollment;
  courseTitle?: string;
  courseCode?: string;
  courseFee?: number;
}

export const createEnrollmentService = (deps: EnrollmentServiceDeps) => ({
  async getMyEnrollments(studentId: EntityId): Promise<EnrichedEnrollment[]> {
    const list = await deps.enrollments.findByStudent(studentId);

    const enriched: EnrichedEnrollment[] = [];
    for (const item of list) {
      let courseTitle: string | undefined;
      let courseCode: string | undefined;
      let courseFee: number | undefined;

      if (deps.courses) {
        try {
          const course = await deps.courses.findById(item.courseId);
          if (course) {
            courseTitle = course.title;
            courseCode = course.courseCode ?? course.slug;
            courseFee = course.feeINR;
          }
        } catch {
          // ignore enrichment failure
        }
      }

      enriched.push({
        enrollment: item,
        ...(courseTitle ? { courseTitle } : {}),
        ...(courseCode ? { courseCode } : {}),
        ...(courseFee !== undefined ? { courseFee } : {}),
      });
    }

    return enriched;
  },

  async requestEnrollment(
    studentId: EntityId,
    courseId: EntityId,
    batchId?: EntityId,
  ): Promise<Enrollment> {
    // 1. Verify course exists
    if (deps.courses) {
      const course = await deps.courses.findById(courseId);
      if (!course) {
        throw ApiError.notFound("Course not found");
      }
    }

    // 1b. A chosen batch must exist, belong to this course and still be open
    // (the rule Admin enrollment already applies).
    if (batchId) {
      if (!deps.batches) {
        throw ApiError.serviceUnavailable("Batch selection is not available right now.", "BATCH_LOOKUP_UNAVAILABLE");
      }
      const batch = await deps.batches.findBatchById(batchId);
      if (!batch) {
        throw ApiError.notFound("Batch not found");
      }
      if (batch.courseId !== courseId) {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "The selected batch does not belong to the selected course.",
          "BATCH_COURSE_MISMATCH",
        );
      }
      if (CLOSED_BATCH_STATUSES.has(batch.status.toLowerCase())) {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          `This batch is ${batch.status.toLowerCase()} and is not open for enrollment.`,
          "BATCH_CLOSED",
        );
      }
    }

    // 2. Prevent duplicate enrollment
    const existing = await deps.enrollments.findByStudentAndCourse(studentId, courseId);
    if (existing) {
      throw ApiError.conflict("You already have an enrollment for this course");
    }

    // 2b. D4: every prerequisite course must have been COMPLETED. Fails closed
    // when prerequisites cannot be read (no course store wired).
    if (!deps.courses) {
      throw ApiError.serviceUnavailable("Enrollment is not available right now.", "PREREQUISITES_UNAVAILABLE");
    }
    const prerequisites = await deps.courses.findPrerequisites(courseId);
    if (prerequisites.length > 0) {
      const mine = await deps.enrollments.findByStudent(studentId);
      const completed = new Set(mine.filter((e) => e.status === "completed").map((e) => String(e.courseId)));
      const missing = prerequisites.filter((p) => !completed.has(String(p.courseId)));
      if (missing.length > 0) {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          `Complete the prerequisite course${missing.length > 1 ? "s" : ""} first: ${missing.map((p) => p.title).join(", ")}.`,
          "PREREQUISITES_NOT_MET",
          missing.map((p) => ({ field: "prerequisites", message: `${p.title}${p.courseCode ? ` (${p.courseCode})` : ""} must be completed first` })),
        );
      }
    }

    // 3. Determine initial status based on student approval (BR-002)
    let initialStatus: EnrollmentStatus = "pending_approval";
    if (deps.students) {
      try {
        const student = await deps.students.findById(studentId);
        if (student?.adminApprovalStatus === "approved") {
          initialStatus = "approved_unpaid";
        }
      } catch {
        // default remains pending_approval
      }
    }

    try {
      return await deps.enrollments.create({
        studentId,
        courseId,
        ...(batchId ? { batchId } : {}),
        enrollmentType: "self",
        status: initialStatus,
        // D6: the batch capacity is a hard limit for self-enrollment.
        enforceBatchCapacity: true,
      });
    } catch (err) {
      if (err instanceof DuplicateRecordError) {
        throw ApiError.conflict("You already have an enrollment for this course");
      }
      if (err instanceof BatchFullError) {
        throw new ApiError(HttpStatus.CONFLICT, "This batch is full. Choose another batch or contact the institute.", "BATCH_FULL");
      }
      throw err;
    }
  },
});

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
