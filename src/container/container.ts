import type { CredentialRepository } from "../modules/auth/credential.repository";
import type { OtpChallengeRepository } from "../modules/auth/otp.repository";
import type { StudentRegistrationRepository } from "../modules/auth/registration.repository";
import type { SessionRepository } from "../modules/auth/session.repository";
import { SqlServerStudentRegistrationRepository } from "../modules/auth/sqlserver-registration.repository";
import { SqlServerCredentialRepository } from "../modules/auth/sqlserver-credential.repository";
import { SqlServerSessionRepository } from "../modules/auth/sqlserver-session.repository";
import { SqlServerOtpChallengeRepository } from "../modules/auth/sqlserver-otp.repository";
import { getSqlServerPool } from "../db/sqlserver.pool";
import type { CourseRepository } from "../modules/courses/course.repository";
import { SqlServerCourseRepository } from "../modules/courses/sqlserver-course.repository";
import type { EnrollmentRepository } from "../modules/enrollments/enrollment.repository";
import { SqlServerEnrollmentRepository } from "../modules/enrollments/sqlserver-enrollment.repository";
import type { StudentRepository } from "../modules/students/student.repository";
import { SqlServerStudentRepository } from "../modules/students/sqlserver-student.repository";
import type { TeacherRepository } from "../modules/teachers/teacher.repository";
import { SqlServerTeacherRepository } from "../modules/teachers/sqlserver-teacher.repository";
import type { AdminRepository } from "../modules/admin/admin.repository";
import { SqlServerAdminRepository } from "../modules/admin/sqlserver-admin.repository";
import type { CmsRepository } from "../modules/cms/cms.repository";
import { SqlServerCmsRepository } from "../modules/cms/sqlserver-cms.repository";
import type { UserRepository } from "../modules/users/user.repository";
import { SqlServerUserRepository } from "../modules/users/sqlserver-user.repository";
import type { PaymentRepository } from "../modules/payments/payment.repository";
import { SqlServerPaymentRepository } from "../modules/payments/sqlserver-payment.repository";
import type { CertificateRepository } from "../modules/certificates/certificate.repository";
import { SqlServerCertificateRepository } from "../modules/certificates/sqlserver-certificate.repository";
import type { PlacementRepository } from "../modules/placements/placement.repository";
import { SqlServerPlacementRepository } from "../modules/placements/sqlserver-placement.repository";
import type { SupportRepository } from "../modules/support/support.repository";
import { SqlServerSupportRepository } from "../modules/support/sqlserver-support.repository";
import type { AcademicsRepository } from "../modules/academics/academics.repository";
import { SqlServerAcademicsRepository } from "../modules/academics/sqlserver-academics.repository";
import type { FinanceRepository } from "../modules/finance/finance.repository";
import { SqlServerFinanceRepository } from "../modules/finance/sqlserver-finance.repository";
import type { ReportsRepository } from "../modules/reports/reports.repository";
import { SqlServerReportsRepository } from "../modules/reports/sqlserver-reports.repository";
import type { AccountSecurityRepository } from "../modules/auth/account-security.repository";
import { SqlServerAccountSecurityRepository } from "../modules/auth/sqlserver-account-security.repository";

/**
 * Dependency injection - deliberately hand-rolled, about 100 lines.
 */
export interface RepositoryRegistry {
  /** Password hashes and lockout state. The only path to a password hash. */
  credentials: CredentialRepository;
  /** Server-side sessions: the seam that makes revocation possible. */
  sessions: SessionRepository;
  /**
   * One-time passcode challenges. Email verification today; the purpose is
   * stored as data so another channel is an additive change (Q3, BR-014).
   */
  otpChallenges: OtpChallengeRepository;
  /**
   * Student self-registration as ONE atomic operation.
   */
  studentRegistration: StudentRegistrationRepository;
  users: UserRepository;
  students: StudentRepository;
  teachers: TeacherRepository;
  courses: CourseRepository;
  enrollments: EnrollmentRepository;
  admin: AdminRepository;
  cms: CmsRepository;
  payments: PaymentRepository;
  certificates: CertificateRepository;
  placements: PlacementRepository;
  support: SupportRepository;
  academics: AcademicsRepository;
  finance: FinanceRepository;
  reports: ReportsRepository;
  accountSecurity: AccountSecurityRepository;
}

export type RepositoryName = keyof RepositoryRegistry;

export type RepositoryFactories = {
  [K in RepositoryName]?: () => RepositoryRegistry[K];
};

export class RepositoryNotConfiguredError extends Error {
  readonly repositoryName: RepositoryName;

  constructor(repositoryName: RepositoryName) {
    super(
      `No adapter registered for the "${repositoryName}" repository. ` +
        "The MS SQL Server adapters are not implemented yet (Step 5 defines " +
        "the interfaces only). Register one in createContainer(), or use the " +
        "in-memory fake in tests/fakes.",
    );
    this.name = "RepositoryNotConfiguredError";
    this.repositoryName = repositoryName;
    Error.captureStackTrace(this, RepositoryNotConfiguredError);
  }
}

export interface AppContainer {
  readonly repositories: RepositoryRegistry;
  has(name: RepositoryName): boolean;
  registered(): RepositoryName[];
}

export const createContainer = (factories: RepositoryFactories = {}): AppContainer => {
  const cache = new Map<RepositoryName, RepositoryRegistry[RepositoryName]>();

  const resolve = <K extends RepositoryName>(name: K): RepositoryRegistry[K] => {
    const cached = cache.get(name);

    if (cached !== undefined) {
      return cached as RepositoryRegistry[K];
    }

    const factory = factories[name];

    if (factory === undefined) {
      throw new RepositoryNotConfiguredError(name);
    }

    const instance = factory();
    cache.set(name, instance);

    return instance as RepositoryRegistry[K];
  };

  const repositories: RepositoryRegistry = {
    get credentials() {
      return resolve("credentials");
    },
    get sessions() {
      return resolve("sessions");
    },
    get otpChallenges() {
      return resolve("otpChallenges");
    },
    get studentRegistration() {
      return resolve("studentRegistration");
    },
    get users() {
      return resolve("users");
    },
    get students() {
      return resolve("students");
    },
    get teachers() {
      return resolve("teachers");
    },
    get courses() {
      return resolve("courses");
    },
    get enrollments() {
      return resolve("enrollments");
    },
    get admin() {
      return resolve("admin");
    },
    get cms() {
      return resolve("cms");
    },
    get payments() {
      return resolve("payments");
    },
    get certificates() {
      return resolve("certificates");
    },
    get placements() {
      return resolve("placements");
    },
    get support() {
      return resolve("support");
    },
    get academics() {
      return resolve("academics");
    },
    get finance() {
      return resolve("finance");
    },
    get reports() {
      return resolve("reports");
    },
    get accountSecurity() {
      return resolve("accountSecurity");
    },
  };

  return {
    repositories,
    has: (name) => factories[name] !== undefined,
    registered: () => Object.keys(factories) as RepositoryName[],
  };
};

/**
 * The production container.
 */
export const createProductionContainer = (): AppContainer => {
  if (process.env.NODE_ENV === "test" && !process.env.TEST_FULL_PRODUCTION_CONTAINER) {
    return createContainer({
      studentRegistration: () => new SqlServerStudentRegistrationRepository(getSqlServerPool),
    });
  }

  return createContainer({
    studentRegistration: () => new SqlServerStudentRegistrationRepository(getSqlServerPool),
    users: () => new SqlServerUserRepository(getSqlServerPool),
    credentials: () => new SqlServerCredentialRepository(getSqlServerPool),
    students: () => new SqlServerStudentRepository(getSqlServerPool),
    sessions: () => new SqlServerSessionRepository(getSqlServerPool),
    otpChallenges: () => new SqlServerOtpChallengeRepository(getSqlServerPool),
    courses: () => new SqlServerCourseRepository(getSqlServerPool),
    enrollments: () => new SqlServerEnrollmentRepository(getSqlServerPool),
    teachers: () => new SqlServerTeacherRepository(getSqlServerPool),
    admin: () => new SqlServerAdminRepository(getSqlServerPool),
    cms: () => new SqlServerCmsRepository(),
    payments: () => new SqlServerPaymentRepository(getSqlServerPool),
    certificates: () => new SqlServerCertificateRepository(getSqlServerPool),
    placements: () => new SqlServerPlacementRepository(getSqlServerPool),
    support: () => new SqlServerSupportRepository(getSqlServerPool),
    academics: () => new SqlServerAcademicsRepository(getSqlServerPool),
    finance: () => new SqlServerFinanceRepository(getSqlServerPool),
    reports: () => new SqlServerReportsRepository(getSqlServerPool),
    accountSecurity: () => new SqlServerAccountSecurityRepository(getSqlServerPool),
  });
};
