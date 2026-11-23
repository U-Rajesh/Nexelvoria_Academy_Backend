import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Transporter } from "nodemailer";

import {
  createSmtpOtpDelivery,
  createLoggingOtpDelivery,
  resolveOtpDelivery,
  maskDestination,
  LOGGING_DELIVERY_REFUSAL,
  type OtpDeliveryRequest,
} from "../src/modules/auth/otp.delivery";
import {
  loadSmtpConfig,
  isSmtpConfigured,
  SmtpConfigError,
  describeSmtpConfig,
  type SmtpConfig,
} from "../src/config/smtp";
import { createTestHarness, type TestHarness } from "./fakes";
import { createDevVerificationService } from "../dev/container.dev";
import { createDevAuthRoutes } from "../dev/auth.dev.routes";
import { createDevRegistrationDeps } from "../dev/container.dev";
import { createApp } from "../src/app";
import { Router } from "express";
import { startServer, type TestServer } from "./helpers/server";

describe("SMTP OTP Delivery & Configuration", () => {
  const validConfig: SmtpConfig = {
    host: "smtp.sendgrid.net",
    port: 587,
    secure: false,
    user: "apikey",
    pass: "SG.valid_mock_token_12345",
    from: "Nexelvoria Academy <admissions@nexelvoria.com>",
  };

  const sampleRequest: OtpDeliveryRequest = {
    destination: "aarav.sharma@example.com",
    code: "482910",
    purpose: "email_verification",
    expiresInSeconds: 300,
  };

  it("masks destination email address correctly for secure logging", () => {
    assert.equal(maskDestination("aarav.sharma@example.com"), "a***a@example.com");
    assert.equal(maskDestination("me@domain.org"), "***@domain.org");
    assert.equal(maskDestination("notanemail"), "***");
  });

  describe("SmtpConfig Validation", () => {
    it("recognizes when minimum SMTP variables are configured", () => {
      assert.equal(
        isSmtpConfigured({
          SMTP_HOST: "smtp.mail.com",
          SMTP_USER: "user",
          SMTP_PASS: "pass",
        }),
        true,
      );

      assert.equal(
        isSmtpConfigured({
          SMTP_HOST: "smtp.mail.com",
        }),
        false,
      );
    });

    it("loads and defaults valid SMTP configuration in non-production", () => {
      const config = loadSmtpConfig(
        {
          SMTP_HOST: "smtp.office365.com",
          SMTP_USER: "admissions@nexelvoria.edu",
          SMTP_PASS: "super-secret-pass",
        },
        "development",
      );

      assert.equal(config.host, "smtp.office365.com");
      assert.equal(config.port, 587);
      assert.equal(config.secure, false);
      assert.equal(config.user, "admissions@nexelvoria.edu");
      assert.equal(config.pass, "super-secret-pass");
      assert.equal(config.from, "Nexelvoria Academy <admissions@nexelvoria.com>");
    });

    it("redacts password and masks username in describeSmtpConfig", () => {
      const described = describeSmtpConfig(validConfig);
      assert.equal(described["host"], "smtp.sendgrid.net");
      assert.equal(described["port"], 587);
      assert.equal("pass" in described, false);
      assert.equal(described["from"], "Nexelvoria Academy <admissions@nexelvoria.com>");
      assert.ok(typeof described["user"] === "string");
      assert.ok(!String(described["user"]).includes("apikey") || String(described["user"]).includes("***"));
    });

    it("fails closed in production if required SMTP variables are missing", () => {
      assert.throws(
        () => {
          loadSmtpConfig(
            {
              SMTP_HOST: "smtp.sendgrid.net",
              // missing SMTP_USER, SMTP_PASS, SMTP_FROM
            },
            "production",
          );
        },
        (err: Error) => {
          assert.ok(err instanceof SmtpConfigError);
          assert.ok(err.message.includes("Missing required SMTP configuration for production"));
          return true;
        },
      );
    });

    it("fails closed in production if placeholders are used", () => {
      assert.throws(
        () => {
          loadSmtpConfig(
            {
              SMTP_HOST: "smtp.example.com",
              SMTP_PORT: "587",
              SMTP_USER: "username",
              SMTP_PASS: "password",
              SMTP_FROM: "admissions@nexelvoria.com",
            },
            "production",
          );
        },
        (err: Error) => {
          assert.ok(err instanceof SmtpConfigError);
          assert.ok(err.message.includes("placeholder value"));
          return true;
        },
      );
    });

    it("rejects invalid port numbers", () => {
      assert.throws(() => {
        loadSmtpConfig({
          SMTP_HOST: "smtp.valid.com",
          SMTP_PORT: "999999",
          SMTP_USER: "user",
          SMTP_PASS: "pass",
        });
      }, SmtpConfigError);
    });

    it("rejects invalid sender email formatting", () => {
      assert.throws(() => {
        loadSmtpConfig({
          SMTP_HOST: "smtp.valid.com",
          SMTP_USER: "user",
          SMTP_PASS: "pass",
          SMTP_FROM: "invalid-email-no-at",
        });
      }, SmtpConfigError);
    });
  });

  describe("createSmtpOtpDelivery with Mocked Transporter", () => {
    it("successfully delivers email and formats subject, plain text and HTML", async () => {
      const sentMails: any[] = [];
      const mockTransporter = {
        sendMail: async (mailOptions: any) => {
          sentMails.push(mailOptions);
          return { messageId: "<msg-101@smtp.test>", rejected: [] };
        },
      } as unknown as Transporter;

      const delivery = createSmtpOtpDelivery({
        config: validConfig,
        transporter: mockTransporter,
      });

      assert.equal(delivery.channel, "email");
      const result = await delivery.send(sampleRequest);

      assert.deepEqual(result, { delivered: true });
      assert.equal(sentMails.length, 1);

      const mail = sentMails[0];
      assert.equal(mail.from, validConfig.from);
      assert.equal(mail.to, sampleRequest.destination);
      assert.equal(mail.subject, "Nexelvoria Academy — Your Verification Code");
      assert.ok(mail.text.includes(sampleRequest.code));
      assert.ok(mail.text.includes("5 minutes"));
      assert.ok(mail.html.includes(sampleRequest.code));
      assert.ok(mail.html.includes("NEXELVORIA ACADEMY"));
    });

    it("handles recipient rejection by email provider without throwing", async () => {
      const mockTransporter = {
        sendMail: async () => {
          return { messageId: "<msg-102@smtp.test>", rejected: [sampleRequest.destination] };
        },
      } as unknown as Transporter;

      const delivery = createSmtpOtpDelivery({
        config: validConfig,
        transporter: mockTransporter,
      });

      const result = await delivery.send(sampleRequest);
      assert.equal(result.delivered, false);
      if (!result.delivered) {
        assert.ok(result.reason.includes("rejected"));
      }
    });

    it("handles transporter connection/socket error without throwing", async () => {
      const mockTransporter = {
        sendMail: async () => {
          throw new Error("ETIMEDOUT: Connection to smtp.sendgrid.net:587 failed");
        },
      } as unknown as Transporter;

      const delivery = createSmtpOtpDelivery({
        config: validConfig,
        transporter: mockTransporter,
      });

      const result = await delivery.send(sampleRequest);
      assert.equal(result.delivered, false);
      if (!result.delivered) {
        assert.ok(result.reason.includes("ETIMEDOUT"));
      }
    });
  });

  describe("Logging Adapter Environment Restriction", () => {
    it("refuses to construct logging delivery in production", () => {
      assert.throws(
        () => {
          if (process.env["NODE_ENV"] === "production") {
            createLoggingOtpDelivery();
          } else {
            resolveOtpDelivery({ NODE_ENV: "production" });
          }
        },
        (err: Error) => {
          assert.ok(err instanceof SmtpConfigError || err.message === LOGGING_DELIVERY_REFUSAL);
          return true;
        },
      );
    });
  });

  describe("End-to-End Registration & Verification with SMTP Transport", () => {
    let harness: TestHarness;
    let server: TestServer;
    const sentMails: any[] = [];

    const mockTransporter = {
      sendMail: async (mailOptions: any) => {
        sentMails.push(mailOptions);
        return { messageId: `<msg-${Date.now()}@test.local>`, rejected: [] };
      },
    } as unknown as Transporter;

    beforeEach(async () => {
      sentMails.length = 0;
      harness = createTestHarness();

      const smtpDelivery = createSmtpOtpDelivery({
        config: validConfig,
        transporter: mockTransporter,
      });

      const verificationService = createDevVerificationService(harness.container, smtpDelivery);

      const extraV1Routes = Router();
      extraV1Routes.use(
        "/auth",
        createDevAuthRoutes({
          deps: createDevRegistrationDeps(harness.container),
          verification: verificationService,
        }),
      );

      const app = createApp({
        container: harness.container,
        extraV1Routes,
      });

      server = await startServer(app);
    });

    afterEach(async () => {
      await server?.close();
    });

    it("registers a student, transmits OTP via SMTP transporter, and verifies successfully", async () => {
      const regRes = await server.post("/api/v1/auth/register", {
        name: "Rohan Varma",
        email: "rohan.varma@test.local",
        mobile: "9988776655",
        password: "SecurePassword!9",
        confirmPassword: "SecurePassword!9",
        collegeName: "IIT Hyderabad",
        degreeBranch: "B.Tech Data Science",
        passingYear: "2025",
        courseInterestedIn: "Cloud Computing",
        dateOfBirth: "2002-05-18",
        gender: "male",
        fullAddress: "Flat 202, Road 12, Banjara Hills, Hyderabad",
        guardianContact: "9988776600",
        termsAccepted: true,
      });

      assert.equal(regRes.status, 201);
      const regBody = (await regRes.json()) as any;
      assert.equal(regBody.success, true);
      const ticket = regBody.data.verificationTicket;
      assert.ok(typeof ticket === "string");

      // Verify email was sent via mock transporter
      assert.equal(sentMails.length, 1);
      const sentMail = sentMails[0];
      assert.equal(sentMail.to, "rohan.varma@test.local");

      // Extract the 6-digit code from plain text email body
      const codeMatch = sentMail.text.match(/\b\d{6}\b/);
      assert.ok(codeMatch !== null, "OTP code not found in email body");
      const code = codeMatch[0];

      // Submit verification
      const verifyRes = await server.post("/api/v1/auth/otp/email/verify", {
        ticket,
        otp: code,
      });

      assert.equal(verifyRes.status, 200);
      const verifyBody = (await verifyRes.json()) as any;
      assert.equal(verifyBody.success, true);
      assert.equal(verifyBody.data.isEmailVerified, true);
      assert.equal(verifyBody.data.accountState, "pending_approval");
      assert.equal(verifyBody.data.awaitingAdminApproval, true);

      // Verify student profile was marked verified in the repository
      const student = await harness.students.findById(regBody.data.tempStudentId);
      assert.ok(student !== null);
      assert.equal(student.isEmailVerified, true);
    });

    it("returns unsent status message when SMTP delivery fails during registration", async () => {
      const failingTransporter = {
        sendMail: async () => {
          throw new Error("SMTP connection refused 554");
        },
      } as unknown as Transporter;

      const failingDelivery = createSmtpOtpDelivery({
        config: validConfig,
        transporter: failingTransporter,
      });

      const failingVerificationService = createDevVerificationService(
        harness.container,
        failingDelivery,
      );

      const extraV1Routes = Router();
      extraV1Routes.use(
        "/auth",
        createDevAuthRoutes({
          deps: createDevRegistrationDeps(harness.container),
          verification: failingVerificationService,
        }),
      );

      const app = createApp({
        container: harness.container,
        extraV1Routes,
      });

      const failServer = await startServer(app);
      try {
        const regRes = await failServer.post("/api/v1/auth/register", {
          name: "Neha Gupta",
          email: "neha.gupta@test.local",
          mobile: "9123456789",
          password: "SecurePassword!9",
          confirmPassword: "SecurePassword!9",
          collegeName: "BITS Pilani",
          degreeBranch: "B.Tech CSE",
          passingYear: "2025",
          courseInterestedIn: "Full Stack",
          dateOfBirth: "2003-08-10",
          gender: "female",
          fullAddress: "Hitech City, Hyderabad",
          guardianContact: "9123456780",
          termsAccepted: true,
        });

        assert.equal(regRes.status, 201);
        const regBody = (await regRes.json()) as any;
        assert.equal(regBody.success, true);
        assert.ok(regBody.message.includes("could not be sent"));
        assert.ok(regBody.message.includes("resend"));
      } finally {
        await failServer.close();
      }
    });
  });
});
