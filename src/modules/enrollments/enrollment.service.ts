import type { EntityId } from "../../contracts/identifier.contract";
import { DuplicateRecordError } from "../../repositories/repository.errors";
import { ApiError } from "../../utils/api-error";
import type { CourseRepository } from "../courses/course.repository";
import type { StudentRepository } from "../students/student.repository";
import type { EnrollmentRepository } from "./enrollment.repository";
import type { Enrollment, EnrollmentStatus } from "./enrollment.types";

export interface EnrollmentServiceDeps {
  enrollments: EnrollmentRepository;
  courses?: CourseRepository;
  students?: StudentRepository;
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

    // 2. Prevent duplicate enrollment
    const existing = await deps.enrollments.findByStudentAndCourse(studentId, courseId);
    if (existing) {
      throw ApiError.conflict("You already have an enrollment for this course");
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
      });
    } catch (err) {
      if (err instanceof DuplicateRecordError) {
        throw ApiError.conflict("You already have an enrollment for this course");
      }
      throw err;
    }
  },
});

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
