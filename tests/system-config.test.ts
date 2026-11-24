import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAdminService } from "../src/modules/admin/admin.service";
import { buildSystemConfigStatus } from "../src/modules/admin/system-config";
import { InMemoryAdminRepository } from "./fakes/in-memory-admin.repository";

const SMTP_ENV = {
  NODE_ENV: "development",
  SMTP_HOST: "mail.internal.test",
  SMTP_PORT: "587",
  SMTP_USER: "notifier@nexelvoria.test",
  SMTP_PASS: "s3cret-value-not-to-leak",
  SMTP_FROM: "Nexelvoria <notifier@nexelvoria.test>",
} as NodeJS.ProcessEnv;

describe("system configuration report (Super Admin, read-only)", () => {
  it("reports SMTP as configured with a masked user and never the password", () => {
    const status = buildSystemConfigStatus(SMTP_ENV);
    assert.equal(status.email.delivery, "smtp");
    assert.equal(status.email.host, "mail.internal.test");
    assert.equal(status.email.port, 587);
    assert.notEqual(status.email.user, "notifier@nexelvoria.test");
    assert.doesNotMatch(JSON.stringify(status), /s3cret-value-not-to-leak/);
  });

  it("reports the development log adapter or an unconfigured server honestly", () => {
    assert.equal(buildSystemConfigStatus({ NODE_ENV: "development" } as NodeJS.ProcessEnv).email.delivery, "development_log");
    assert.equal(buildSystemConfigStatus({ NODE_ENV: "production" } as NodeJS.ProcessEnv).email.delivery, "not_configured");
  });

  it("reports the policies the server enforces and no SMS provider", () => {
    const status = buildSystemConfigStatus({ NODE_ENV: "development" } as NodeJS.ProcessEnv, new Date("2026-11-23T10:00:00Z"));
    assert.equal(status.editable, false);
    assert.equal(status.security.maxFailedLoginAttempts, 5);
    assert.equal(status.security.passwordMinLength, 8);
    assert.equal(status.otp.channel, "email");
    assert.equal(status.sms.configured, false);
    assert.equal(status.reporting.financialYear, "FY 2026-27");
  });
});

describe("SMTP test email (Super Admin)", () => {
  it("sends through the injected SMTP mailer and audits the send", async () => {
    const admin = new InMemoryAdminRepository();
    const sent: string[] = [];
    const service = createAdminService({
      admin,
      testMailer: async (to) => {
        sent.push(to);
        return { messageId: "<abc@mail>" };
      },
    });

    const result = await service.sendTestEmail("sa-1", "owner@test.local");
    assert.deepEqual(sent, ["owner@test.local"]);
    assert.equal(result.messageId, "<abc@mail>");
    assert.ok(admin.auditLogs.some((l) => l.actionType === "TEST_EMAIL_SENT" && l.actorUserId === "sa-1"));
  });

  it("reports an SMTP rejection as a failure, never as sent", async () => {
    const admin = new InMemoryAdminRepository();
    const service = createAdminService({
      admin,
      testMailer: async () => {
        throw new Error("535 authentication failed");
      },
    });
    await assert.rejects(service.sendTestEmail("sa-1", "owner@test.local"), (err: { status?: number; code?: string }) =>
      err.status === 503 && err.code === "SMTP_SEND_FAILED",
    );
    assert.ok(admin.auditLogs.some((l) => l.actionType === "TEST_EMAIL_FAILED"));
  });
});
