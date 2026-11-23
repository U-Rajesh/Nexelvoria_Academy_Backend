import { createContainer, type AppContainer } from "../../src/container/container";
import { InMemoryCourseRepository } from "./in-memory-course.repository";
import { InMemoryCredentialRepository } from "./in-memory-credential.repository";
import { InMemoryOtpChallengeRepository } from "./in-memory-otp.repository";
import { InMemoryStudentRegistrationRepository } from "./in-memory-registration.repository";
import { InMemorySessionRepository } from "./in-memory-session.repository";
import { InMemoryEnrollmentRepository } from "./in-memory-enrollment.repository";
import { InMemoryStudentRepository } from "./in-memory-student.repository";
import { InMemoryTeacherRepository } from "./in-memory-teacher.repository";
import { InMemoryUserRepository } from "./in-memory-user.repository";
import { InMemoryAdminRepository } from "./in-memory-admin.repository";
import { InMemoryCmsRepository } from "./in-memory-cms.repository";
import { InMemoryPaymentRepository } from "./in-memory-payment.repository";
import { InMemoryCertificateRepository } from "./in-memory-certificate.repository";
import { InMemoryPlacementRepository } from "./in-memory-placement.repository";
import { InMemorySupportRepository } from "./in-memory-support.repository";

/**
 * TEST-ONLY wiring: a container backed entirely by in-memory fakes.
 */
export interface TestHarness {
  container: AppContainer;
  credentials: InMemoryCredentialRepository;
  sessions: InMemorySessionRepository;
  otpChallenges: InMemoryOtpChallengeRepository;
  studentRegistration: InMemoryStudentRegistrationRepository;
  users: InMemoryUserRepository;
  students: InMemoryStudentRepository;
  teachers: InMemoryTeacherRepository;
  courses: InMemoryCourseRepository;
  enrollments: InMemoryEnrollmentRepository;
  admin: InMemoryAdminRepository;
  cms: InMemoryCmsRepository;
  payments: InMemoryPaymentRepository;
  certificates: InMemoryCertificateRepository;
  placements: InMemoryPlacementRepository;
  support: InMemorySupportRepository;
  /** Clears every fake. Isolation between tests in one file. */
  reset: () => void;
}

export const createTestHarness = (): TestHarness => {
  const credentials = new InMemoryCredentialRepository();
  const sessions = new InMemorySessionRepository();
  const otpChallenges = new InMemoryOtpChallengeRepository();
  const studentRegistration = new InMemoryStudentRegistrationRepository();
  const users = new InMemoryUserRepository();
  const enrollments = new InMemoryEnrollmentRepository();
  const students = new InMemoryStudentRepository(enrollments, users);
  const teachers = new InMemoryTeacherRepository();
  const courses = new InMemoryCourseRepository();
  const admin = new InMemoryAdminRepository();
  const cms = new InMemoryCmsRepository();
  const payments = new InMemoryPaymentRepository();
  const certificates = new InMemoryCertificateRepository();
  const placements = new InMemoryPlacementRepository();
  const support = new InMemorySupportRepository();

  const container = createContainer({
    credentials: () => credentials,
    sessions: () => sessions,
    otpChallenges: () => otpChallenges,
    studentRegistration: () => studentRegistration,
    users: () => users,
    students: () => students,
    teachers: () => teachers,
    courses: () => courses,
    enrollments: () => enrollments,
    admin: () => admin,
    cms: () => cms,
    payments: () => payments,
    certificates: () => certificates,
    placements: () => placements,
    support: () => support,
  });

  return {
    container,
    credentials,
    sessions,
    otpChallenges,
    studentRegistration,
    users,
    students,
    teachers,
    courses,
    enrollments,
    admin,
    cms,
    payments,
    certificates,
    placements,
    support,
    reset: () => {
      credentials.reset();
      sessions.reset();
      otpChallenges.reset();
      studentRegistration.reset();
      users.reset();
      students.reset();
      teachers.reset();
      courses.reset();
      enrollments.reset();
      admin.admins = [];
      admin.batches = [];
      admin.enrollments = [];
      admin.auditLogs = [];
      admin.refunds = [];
      admin.financialOverrides = [];
      admin.batchStudentsMap.clear();
      admin.teacherAllocationsMap.clear();
      cms.banners = [];
      cms.articles = [];
      cms.faqs = [];
      cms.testimonials = [];
      cms.trainers = [];
      cms.achievements = [];
      cms.careers = [];
      cms.partners = [];
      cms.collegePartners = [];
      cms.corporateServices = [];
      cms.pageContent.clear();
      cms.enquiries = [];
      cms.subscribers = [];
      payments.reset();
      certificates.reset();
      placements.reset();
      support.reset();
    },
  };
};

export { InMemoryCourseRepository } from "./in-memory-course.repository";
export { InMemoryCredentialRepository } from "./in-memory-credential.repository";
export { InMemoryOtpChallengeRepository } from "./in-memory-otp.repository";
export { InMemoryStudentRegistrationRepository } from "./in-memory-registration.repository";
export { InMemorySessionRepository } from "./in-memory-session.repository";
export { InMemoryEnrollmentRepository } from "./in-memory-enrollment.repository";
export { InMemoryStudentRepository } from "./in-memory-student.repository";
export { InMemoryTeacherRepository } from "./in-memory-teacher.repository";
export { InMemoryUserRepository } from "./in-memory-user.repository";
export { InMemoryAdminRepository } from "./in-memory-admin.repository";
export { InMemoryCmsRepository } from "./in-memory-cms.repository";
export { InMemoryPaymentRepository } from "./in-memory-payment.repository";
export { InMemoryCertificateRepository } from "./in-memory-certificate.repository";
export { InMemoryPlacementRepository } from "./in-memory-placement.repository";
export { InMemorySupportRepository } from "./in-memory-support.repository";
