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
import { createLoginService } from "../modules/auth/login.service";
import { createVerificationService } from "../modules/auth/verification.service";
import { createOtpService } from "../modules/auth/otp.service";
import { resolveOtpDelivery } from "../modules/auth/otp.delivery";
import { createAuthenticate } from "../middleware/authenticate.middleware";

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

  // Authentication endpoints
  const loginService =
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
          maxFailedLoginAttempts: 5,
        })
      : undefined;

  if (
    extraRoutes === undefined &&
    (container.has("studentRegistration") || loginService !== undefined)
  ) {
    const verificationService =
      container.has("otpChallenges") && container.has("users") && container.has("students")
        ? createVerificationService({
            otp: createOtpService({
              challenges: container.repositories.otpChallenges,
              delivery: resolveOtpDelivery(),
            }),
            get users() {
              return container.repositories.users;
            },
            get students() {
              return container.repositories.students;
            },
          })
        : undefined;

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
        })
      : undefined);

  router.use(
    "/courses",
    createCourseRoutes({
      get courses() {
        return container.repositories.courses;
      },
      ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
    }),
  );

  router.use(
    "/students",
    createStudentRoutes({
      get students() {
        return container.repositories.students;
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
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );
  }

  if (container.has("admin")) {
    router.use(
      "/admin",
      createAdminRoutes({
        get admin() {
          return container.repositories.admin;
        },
        ...(effectiveAuth === undefined ? {} : { authenticate: effectiveAuth }),
      }),
    );

    router.use(
      "/super-admin",
      createSuperAdminRoutes({
        get admin() {
          return container.repositories.admin;
        },
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
      }),
    );

    router.use(
      "/admin/cms",
      createAdminCmsRoutes({
        get cms() {
          return container.repositories.cms;
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
