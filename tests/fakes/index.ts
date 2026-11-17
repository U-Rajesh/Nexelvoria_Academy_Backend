import { createContainer, type AppContainer } from "../../src/container/container";
import { InMemoryCourseRepository } from "./in-memory-course.repository";
import { InMemoryCredentialRepository } from "./in-memory-credential.repository";
import { InMemorySessionRepository } from "./in-memory-session.repository";
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
  credentials: InMemoryCredentialRepository;
  sessions: InMemorySessionRepository;
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
  const credentials = new InMemoryCredentialRepository();
  const sessions = new InMemorySessionRepository();
  const users = new InMemoryUserRepository();
  const enrollments = new InMemoryEnrollmentRepository();
  // Connected to the enrolment fake so `filter.batchId` resolves through
  // enrolment data, as a real adapter's join would (Task 3.1, Option A).
  const students = new InMemoryStudentRepository(enrollments);
  const teachers = new InMemoryTeacherRepository();
  const courses = new InMemoryCourseRepository();

  const container = createContainer({
    credentials: () => credentials,
    sessions: () => sessions,
    users: () => users,
    students: () => students,
    teachers: () => teachers,
    courses: () => courses,
    enrollments: () => enrollments,
  });

  return {
    container,
    credentials,
    sessions,
    users,
    students,
    teachers,
    courses,
    enrollments,
    reset: () => {
      credentials.reset();
      sessions.reset();
      users.reset();
      students.reset();
      teachers.reset();
      courses.reset();
      enrollments.reset();
    },
  };
};

export { InMemoryCourseRepository } from "./in-memory-course.repository";
export { InMemoryCredentialRepository } from "./in-memory-credential.repository";
export { InMemorySessionRepository } from "./in-memory-session.repository";
export { InMemoryEnrollmentRepository } from "./in-memory-enrollment.repository";
export { InMemoryStudentRepository } from "./in-memory-student.repository";
export { InMemoryTeacherRepository } from "./in-memory-teacher.repository";
export { InMemoryUserRepository } from "./in-memory-user.repository";
