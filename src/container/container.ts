import type { CredentialRepository } from "../modules/auth/credential.repository";
import type { OtpChallengeRepository } from "../modules/auth/otp.repository";
import type { SessionRepository } from "../modules/auth/session.repository";
import type { CourseRepository } from "../modules/courses/course.repository";
import type { EnrollmentRepository } from "../modules/enrollments/enrollment.repository";
import type { StudentRepository } from "../modules/students/student.repository";
import type { TeacherRepository } from "../modules/teachers/teacher.repository";
import type { UserRepository } from "../modules/users/user.repository";

/**
 * Dependency injection - deliberately hand-rolled, about 100 lines.
 *
 * Why no library (tsyringe, InversifyJS, NestJS DI): those buy runtime
 * decorators, reflection metadata and a module system we do not need. We
 * have one kind of dependency - a repository - and a handful of them. A
 * typed record of factory functions gives us everything a container is
 * for (one place to wire, swappable in tests, no service knowing a
 * concrete class) at a fraction of the cost and with no `experimental
 * Decorators` compiler flag.
 *
 * How services use it: a service takes the PORTS it needs as a
 * constructor/factory argument and never imports the container itself.
 *
 *   export const createStudentService = (deps: {
 *     students: StudentRepository;
 *     enrollments: EnrollmentRepository;
 *   }) => ({ ... });
 *
 * The route layer resolves from the container and passes them down:
 *
 *   const service = createStudentService({
 *     students: container.repositories.students,
 *     enrollments: container.repositories.enrollments,
 *   });
 *
 * That keeps the container at the edge. A service that imports the
 * container becomes untestable without it, which is the exact coupling
 * this file exists to prevent.
 */

/**
 * Every repository the application can resolve.
 *
 * Adding a repository is a two-line change: add it here and add a getter
 * below. Keeping the list explicit rather than generic means a typo is a
 * compile error, and the editor can autocomplete what is available.
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
  users: UserRepository;
  students: StudentRepository;
  teachers: TeacherRepository;
  courses: CourseRepository;
  enrollments: EnrollmentRepository;
}

export type RepositoryName = keyof RepositoryRegistry;

/**
 * Factories, not instances.
 *
 * Lazy construction matters: in production no adapter exists yet, and
 * eagerly building every repository would mean the app could not start.
 * A factory is only called when something actually resolves it.
 */
export type RepositoryFactories = {
  [K in RepositoryName]?: () => RepositoryRegistry[K];
};

/**
 * Thrown when code resolves a repository that has no registered adapter.
 *
 * This is the expected state for the whole of Step 5: there is no
 * database, so nothing is registered in production. Failing loudly with a
 * precise message is the point - the alternative, returning a stub that
 * quietly does nothing, would hide a missing implementation until it
 * corrupted data.
 */
export class RepositoryNotConfiguredError extends Error {
  /** Named `repositoryName`, not `name`, because Error.name is taken. */
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

/** The resolved application dependencies. */
export interface AppContainer {
  /**
   * Repositories, resolved on first access and memoised thereafter, so
   * one container yields one instance per repository.
   */
  readonly repositories: RepositoryRegistry;

  /** True when an adapter is registered, without constructing it. */
  has(name: RepositoryName): boolean;

  /** Names with a registered adapter. Used by diagnostics and tests. */
  registered(): RepositoryName[];
}

/**
 * Creates a container from the given factories.
 *
 * Omitted repositories are simply unavailable: resolving one throws
 * `RepositoryNotConfiguredError`. Tests pass in-memory fakes; a future
 * `createSqlServerContainer()` will pass real adapters.
 */
export const createContainer = (factories: RepositoryFactories = {}): AppContainer => {
  // One cache per container instance - this is what gives tests isolation:
  // a fresh container has a fresh cache and therefore fresh state.
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

  // Explicit getters rather than a Proxy: five lines of repetition buys
  // full type inference, a readable stack trace and no casting games.
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
  };

  return {
    repositories,
    has: (name) => factories[name] !== undefined,
    registered: () => Object.keys(factories) as RepositoryName[],
  };
};

/**
 * The production container.
 *
 * Intentionally empty. There are no MS SQL Server adapters yet, so the
 * application starts and serves /api/v1/health, and any attempt to reach
 * a repository fails with a precise error rather than silently misbehaving.
 *
 * When the database team delivers adapters, they are registered here -
 * and that is the only file that changes.
 */
export const createProductionContainer = (): AppContainer => createContainer({});
