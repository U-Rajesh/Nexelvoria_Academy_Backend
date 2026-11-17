import { createContainer, type AppContainer } from "../../src/container/container";
import { InMemoryCourseRepository } from "./in-memory-course.repository";
import { InMemoryEnrollmentRepository } from "./in-memory-enrollment.repository";
import { InMemoryStudentRepository } from "./in-memory-student.repository";
import { InMemoryTeacherRepository } from "./in-memory-teacher.repository";
import { InMemoryUserRepository } from "./in-memory-user.repository";

/**
 * TEST-ONLY wiring: a container backed entirely by in-memory fakes.
 *
 * The fakes are handed back alongside the container so a test can seed
 * and assert against them directly while the application resolves the
 * same instances through dependency injection.
 */
export interface TestHarness {
  container: AppContainer;
  users: InMemoryUserRepository;
  students: InMemoryStudentRepository;
  teachers: InMemoryTeacherRepository;
  courses: InMemoryCourseRepository;
  enrollments: InMemoryEnrollmentRepository;
  /** Clears every fake. Isolation between tests in one file. */
  reset: () => void;
}

/**
 * Builds a fresh harness.
 *
 * Call it per test (or per suite with `reset()` in a `beforeEach`) - each
 * call creates new fakes AND a new container cache, so no state leaks
 * between tests.
 */
export const createTestHarness = (): TestHarness => {
  const users = new InMemoryUserRepository();
  const students = new InMemoryStudentRepository();
  const teachers = new InMemoryTeacherRepository();
  const courses = new InMemoryCourseRepository();
  const enrollments = new InMemoryEnrollmentRepository();

  const container = createContainer({
    users: () => users,
    students: () => students,
    teachers: () => teachers,
    courses: () => courses,
    enrollments: () => enrollments,
  });

  return {
    container,
    users,
    students,
    teachers,
    courses,
    enrollments,
    reset: () => {
      users.reset();
      students.reset();
      teachers.reset();
      courses.reset();
      enrollments.reset();
    },
  };
};

export { InMemoryCourseRepository } from "./in-memory-course.repository";
export { InMemoryEnrollmentRepository } from "./in-memory-enrollment.repository";
export { InMemoryStudentRepository } from "./in-memory-student.repository";
export { InMemoryTeacherRepository } from "./in-memory-teacher.repository";
export { InMemoryUserRepository } from "./in-memory-user.repository";
