import { Router, type RequestHandler } from "express";

import type { AppContainer } from "../container/container";
import { createAuthRoutes } from "../modules/auth/auth.routes";
import { createCourseRoutes } from "../modules/courses/course.routes";
import { healthRoutes } from "../modules/health/health.routes";
import { createStudentRoutes } from "../modules/students/student.routes";
import { createTeacherRoutes } from "../modules/teachers/teacher.routes";
import { createAdminRoutes, createSuperAdminRoutes } from "../modules/admin/admin.routes";
import { createEnrollmentRoutes } from "../modules/enrollments/enrollment.routes";
import { createPublicCmsRoutes, createAdminCmsRoutes } from "../modules/cms/cms.routes";
import { createPaymentRoutes } from "../modules/payments/payment.routes";
import { createCertificateRoutes } from "../modules/certificates/certificate.routes";
import { createPlacementRoutes } from "../modules/placements/placement.routes";
import { createSupportRoutes } from "../modules/support/support.routes";
import { createAcademicsRoutes } from "../modules/academics/academics.routes";
import { createFinanceRoutes } from "../modules/finance/finance.routes";
import { createReportsRoutes } from "../modules/reports/reports.routes";
import { createMaintenanceGuard } from "../middleware/maintenance.middleware";
import { createAccountRoutes } from "../modules/auth/account.routes";
import { createAccountService } from "../modules/auth/account.service";
import { createSessionService } from "../modules/auth/session.service";
import { withLoginHistory } from "../modules/auth/login-history";
import { createLoginService, MAX_FAILED_LOGIN_ATTEMPTS } from "../modules/auth/login.service";
import { effectiveLockoutThreshold } from "../modules/auth/credential.types";
import { createVerificationService } from "../modules/auth/verification.service";
import { createOtpService } from "../modules/auth/otp.service";
import { resolveOtpDelivery } from "../modules/auth/otp.delivery";
import { createSmtpTestMailer, type TestMailer } from "../modules/admin/system-config";
import { logger } from "../utils/logger";
import { createStudentAccessResolver } from "../modules/students/student-access";

/** Real SMTP sender for the Super Admin test email, or undefined when SMTP is unusable. */
const resolveTestMailer = (): TestMailer | undefined => {
  // Never send real email from an automated test run.
  if (process.env["NODE_ENV"] === "test") return undefined;
  try {
    return createSmtpTestMailer();
  } catch (err) {
    logger.warn("SMTP test mailer unavailable", { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
};
import { createAuthenticate } from "../middleware/authenticate.middleware";
import type { AuditSink } from "../contracts/audit.contract";

/**
 * The API v1 route registry - the ONLY place module routers are mounted.
 */
export const createApiV1Router = (
  container: AppContainer,
  /**
   * Additional routes, mounted last but still before the 404 handler.
   */
  extraRoutes?: Router,
  /**
   * Authentication middleware, handed to the modules whose routes need an
   * identity.
   */
  authenticate?: RequestHandler,
): Router => {
  const router = Router();

  // `health` takes no dependencies by design.
  router.use(healthRoutes);

  // CFG-20: maintenance mode, read from institute settings (only when they are available).
  const maintenance = container.has("admin")
    ? createMaintenanceGuard({
        read: async () => {
          const s = await container.repositories.admin.getInstituteSettings();
          return { enabled: s.maintenanceMode === true, message: s.maintenanceMessage };
        },
      })
    : undefined;
  if (maintenance) {
    router.use(maintenance.statusRouter);
    router.use(maintenance.middleware);
  }

  // Authentication endpoints
  const baseLoginService =
    container.has("users") && container.has("credentials") && container.has("sessions")
      ? createLoginService({
          get users() {
            return container.repositories.users;
          },
          get credentials() {
            return container.repositories.credentials;
          },
          get sessions() {
            return container.repositories.sessions;
          },
          ...(container.has("students")
            ? {
                get students() {
                  return container.repositories.students;
                },
              }
            : {}),
          // D7: Super Admin setting (3-10), read per sign-in; never saved -> 5.
          maxFailedLoginAttempts: container.has("admin")
            ? async () =>
                effectiveLockoutThreshold(
                  (await container.repositories.admin.getInstituteSettings()).maxFailedLoginAttempts,
                  MAX_FAILED_LOGIN_ATTEMPTS,
                )
            : MAX_FAILED_LOGIN_ATTEMPTS,
        })
      : undefined;

  // AUTH-008: every sign-in attempt is recorded in NXA_LoginHistory.
  const loginService =
    baseLoginService !== undefined && container.has("accountSecurity")
      ? withLoginHistory(baseLoginService, {
          users: () => container.repositories.users,
          accountSecurity: () => container.repositories.accountSecurity,
        })
      : baseLoginService;

  // Email OTP service, shared by registration verification and password reset.
  const otpService = container.has("otpChallenges")
    ? createOtpService({
        challenges: container.repositories.otpChallenges,
        delivery: resolveOtpDelivery(),
      })
    : undefined;

  // Email OTP (BR-001). Shared by /auth and by admin-created students.
  const verificationService =
    container.has("otpChallenges") && container.has("users") && container.has("students")
      ? createVerificationService({
          otp: otpService!,
          get users() {
            return container.repositories.users;
          },
          get students() {
            return container.repositories.students;
          },
        })
      : undefined;

  if (
    extraRoutes === undefined &&
    (container.has("studentRegistration") || loginService !== undefined)
  ) {

    router.use(
      "/auth",
      createAuthRoutes({
        ...(container.has("studentRegistration")
          ? {
              get studentRegistration() {
                return container.repositories.studentRegistration;
              },
            }
          : {}),
        ...(loginService !== undefined ? { login: loginService } : {}),
        ...(verificationService !== undefined ? { verification: verificationService } : {}),
      }),
    );
  }

  // Resolve authentication middleware
  const effectiveAuth =
    authenticate ??
    (container.has("sessions")
      ? createAuthenticate({
          sessions: () => container.repositories.sessions,
          // CL-001 student access tiers, read per request. Without a student
          // store no student can be authorized, so this fails closed.
          studentAccess: container.has("students")
            ? createStudentAccessResolver(() => container.repositories.students)
            : async () => ({ allowed: false, reason: "no_profile" }),
        })
      : undefined);

  // Audit sink for self-service account security events (AUTH-014), bound to
  // NXA_AuditLogs. Course and student management audits are written by their
  // repositories in the change's own transaction instead.
  const adminAudit: AuditSink | undefined = container.has("admin")
    ? async (e) => {
        await container.repositories.admin.createAuditLog(e);
      }
    : undefined;

  // Account security (AUTH-006/007/008/009/010/014): password change and
  // reset, logout, own sessions and login history.
  if (
    extraRoutes === undefined &&
    container.has("users") &&
    container.has("credentials") &&
    container.has("sessions") &&
    container.has("accountSecurity")
  ) {
    router.use(
      "/auth",
      createAccountRoutes({
        account: createAccountService({
          get users() {
            return container.repositories.users;
          },
          get credentials() {
            return container.repositories.credentials;
          },
          get sessions() {
            return container.repositories.sessions;
          },
          get accountSecurity() {
            return container.repositories.accountSecurity;
          },
          otp: otpService,
          audit: adminAudit,
        }),
        sessions: createSessionService({
          get sessions() {
            return container.repositories.sessions;
          },
        }),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  router.use(
    "/courses",
    createCourseRoutes({
      get courses() {
        return container.repositories.courses;
      },
      // D9 course settings: starting values for newly created lessons.
      ...(container.has("admin")
        ? {
            newLessonDefaults: async () => {
              const s = await container.repositories.admin.getInstituteSettings();
              return { sequentialUnlock: s.defaultLessonSequentialUnlock, downloadAllowed: s.defaultLessonDownloadAllowed };
            },
          }
        : {}),
      // Course management actions are audited by the course repository in the
      // same transaction as the change (SEC audit logs), not through a sink.
      ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
    }),
  );

  router.use(
    "/students",
    createStudentRoutes({
      get students() {
        return container.repositories.students;
      },
      // Approval / status decisions are audited by the student repository in
      // the same transaction as the change (SEC audit logs).
      adminEffects: {
        ...(container.has("sessions")
          ? {
              revokeSessions: async (userId: string) => {
                await container.repositories.sessions.revokeAllForUser({ userId, reason: "account_suspended" });
              },
            }
          : {}),
      },
      ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
    }),
  );

  if (container.has("enrollments")) {
    router.use(
      "/enrollments",
      createEnrollmentRoutes({
        get enrollments() {
          return container.repositories.enrollments;
        },
        ...(container.has("courses")
          ? {
              get courses() {
                return container.repositories.courses;
              },
            }
          : {}),
        ...(container.has("students")
          ? {
              get students() {
                return container.repositories.students;
              },
            }
          : {}),
        // Batch/course relationship and open status for self-enrollment,
        // read from NXA_Batches through the existing admin repository.
        ...(container.has("admin")
          ? {
              batches: {
                findBatchById: (id: string) => container.repositories.admin.findBatchById(id),
              },
            }
          : {}),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("teachers")) {
    router.use(
      "/teachers",
      createTeacherRoutes({
        get teachers() {
          return container.repositories.teachers;
        },
        // CRS-010: student access to learning content needs ACTIVE enrollments
        // and the lesson-to-course mapping.
        ...(container.has("enrollments")
          ? {
              get enrollments() {
                return container.repositories.enrollments;
              },
            }
          : {}),
        ...(container.has("courses")
          ? {
              get courses() {
                return container.repositories.courses;
              },
            }
          : {}),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("admin")) {
    // Lazily resolved: suspension and password reset revoke live sessions.
    const adminSessions = container.has("sessions")
      ? { sessions: () => container.repositories.sessions }
      : {};

    router.use(
      "/admin",
      createAdminRoutes({
        get admin() {
          return container.repositories.admin;
        },
        ...adminSessions,
        ...(maintenance ? { onSettingsChanged: maintenance.invalidate } : {}),
        ...(verificationService === undefined ? {} : { verification: verificationService }),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );

    router.use(
      "/super-admin",
      createSuperAdminRoutes({
        get admin() {
          return container.repositories.admin;
        },
        ...adminSessions,
        ...(maintenance ? { onSettingsChanged: maintenance.invalidate } : {}),
        testMailer: resolveTestMailer(),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("cms")) {
    router.use(
      "/public",
      createPublicCmsRoutes({
        get cms() {
          return container.repositories.cms;
        },
        ...(container.has("courses")
          ? {
              courses: {
                findById: async (id: string) => {
                  const c = await container.repositories.courses.findById(id);
                  return c ? { id: c.id, title: c.title, slug: c.slug, status: c.status, isPublished: c.isPublished } : null;
                },
              },
            }
          : {}),
      }),
    );

    router.use(
      "/admin/cms",
      createAdminCmsRoutes({
        get cms() {
          return container.repositories.cms;
        },
        ...(container.has("courses")
          ? {
              courses: {
                findById: async (id: string) => {
                  const c = await container.repositories.courses.findById(id);
                  return c ? { id: c.id, title: c.title, slug: c.slug, status: c.status, isPublished: c.isPublished } : null;
                },
              },
            }
          : {}),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("academics")) {
    router.use(
      "/admin/academics",
      createAcademicsRoutes({
        get academics() {
          return container.repositories.academics;
        },
        // D1 / D2: the minimum attendance in force (floor applied by the routes).
        ...(container.has("admin") ? { minimumAttendance: async () => (await container.repositories.admin.getInstituteSettings()).minAttendancePercentage } : {}),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("reports")) {
    router.use(
      "/admin/reports",
      createReportsRoutes({
        get reports() {
          return container.repositories.reports;
        },
        // CFG-01: the institute name is printed on every export.
        ...(container.has("admin") ? { instituteName: async () => (await container.repositories.admin.getInstituteSettings()).instituteName } : {}),
        ...(container.has("admin") ? { minimumAttendance: async () => (await container.repositories.admin.getInstituteSettings()).minAttendancePercentage } : {}),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("finance")) {
    router.use(
      "/admin/finance",
      createFinanceRoutes({
        get finance() {
          return container.repositories.finance;
        },
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("payments")) {
    router.use(
      "/payments",
      createPaymentRoutes({
        get payments() {
          return container.repositories.payments;
        },
        // Needed to price orders from the enrollment and to activate the
        // enrollment after verified payment (BR-004). Previously omitted, so
        // verified payments never activated anything.
        ...(container.has("courses")
          ? {
              get courses() {
                return container.repositories.courses;
              },
            }
          : {}),
        ...(container.has("enrollments")
          ? {
              get enrollments() {
                return container.repositories.enrollments;
              },
            }
          : {}),
        // Receipt names are read from the user record.
        ...(container.has("users")
          ? {
              get users() {
                return container.repositories.users;
              },
            }
          : {}),
        // No `gateway`: the Razorpay integration and credentials have not been
        // provided, so online payment reports 503 PAYMENT_GATEWAY_UNAVAILABLE.
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("certificates")) {
    router.use(
      "/certificates",
      createCertificateRoutes({
        get certificates() {
          return container.repositories.certificates;
        },
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("placements")) {
    router.use(
      "/placements",
      createPlacementRoutes({
        get placements() {
          return container.repositories.placements;
        },
        // BR-013: placement eligibility is read from ACTIVE enrollments.
        ...(container.has("enrollments")
          ? {
              get enrollments() {
                return container.repositories.enrollments;
              },
            }
          : {}),
        // PLC-009: mock interview participants must hold the teacher / student role.
        ...(container.has("users")
          ? {
              get users() {
                return container.repositories.users;
              },
            }
          : {}),
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("support")) {
    router.use(
      "/support",
      createSupportRoutes({
        get support() {
          return container.repositories.support;
        },
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (extraRoutes !== undefined) {
    router.use(extraRoutes);
  }

  return router;
};
