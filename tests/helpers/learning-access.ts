import type { EntityId } from "../../src/contracts/identifier.contract";
import type { EnrollmentStatus } from "../../src/modules/enrollments/enrollment.types";
import type { TestHarness } from "../fakes";

/**
 * Test fixtures for CRS-010 / BR-013: learning content and the placement
 * portal are reachable only through an ACTIVE enrollment, and a lesson is
 * reachable only inside a course the student is enrolled in.
 */

/** Gives `courseId` a one-module curriculum containing exactly these lessons. */
export const seedLessons = async (h: TestHarness, courseId: EntityId, lessonIds: EntityId[]): Promise<void> => {
  await h.courses.replaceCurriculum(courseId, [
    {
      id: `${courseId}-mod-1`,
      courseId,
      title: "Module 1",
      description: "",
      order: 1,
      chapters: [
        {
          id: `${courseId}-ch-1`,
          moduleId: `${courseId}-mod-1`,
          title: "Chapter 1",
          order: 1,
          lessons: lessonIds.map((id, i) => ({
            id,
            chapterId: `${courseId}-ch-1`,
            title: `Lesson ${i + 1}`,
            durationMinutes: 30,
            isFreePreview: false,
            order: i + 1,
          })),
        },
      ],
    },
  ]);
};

/** Creates an enrollment for the student (ACTIVE unless stated). */
export const seedEnrollment = async (
  h: TestHarness,
  studentId: EntityId,
  courseId: EntityId,
  options: { batchId?: EntityId; status?: EnrollmentStatus } = {},
) =>
  h.enrollments.create({
    studentId,
    courseId,
    ...(options.batchId ? { batchId: options.batchId } : {}),
    enrollmentType: "admin",
    status: options.status ?? "active",
  });
