import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerAdminRepository } from "../src/modules/admin/sqlserver-admin.repository";
import { buildSystemConfigStatus } from "../src/modules/admin/system-config";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Batch 3 item 9: Admin / Super Admin settings (CFG).
 * - institute profile: validated, audited per changed key, no-op writes nothing, atomic with its audit;
 * - settings that are stored but never applied are refused with the decision they wait on;
 * - maintenance mode is enforced (503 for everyone but Super Admins; sign-in stays open);
 * - integration status reports presence only, never secrets, and never claims verification.
 */
describe("institute settings and maintenance mode (HTTP)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const settingsAudits = () => harness.admin.auditLogs.filter((l) => l.actionType === "UPDATE_SETTINGS");

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 20;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@cfg.test`, mobile: `98722200${seq}`, role, status: "active" });
      ids[role] = user.id;
      const session = await harness.sessions.create({ userId: user.id, refreshTokenHash: Buffer.alloc(64, 4).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("lets Admins and Super Admins read settings, and nobody else", async () => {
    assert.equal((await server.get("/api/v1/admin/settings", auth("admin"))).status, 200);
    assert.equal((await server.get("/api/v1/admin/settings", auth("super_admin"))).status, 200);
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.get("/api/v1/admin/settings", auth(role))).status, 403, role);
      assert.equal((await server.put("/api/v1/admin/settings", { tagline: "x" }, auth(role))).status, 403, role);
    }
    assert.equal((await server.get("/api/v1/admin/settings")).status, 401);
  });

  it("describes every setting, marking the stored-but-unapplied ones as blocked", async () => {
    const catalog = (await json(await server.get("/api/v1/admin/settings/catalog", auth("admin"))))["data"];
    const blocked = catalog.filter((s: any) => s.status === "blocked").map((s: any) => s.key).sort();
    // minAttendancePercentage was unblocked by approved decision D1 (75% floor).
    assert.deepEqual(blocked, ["currencySymbol", "isSmsEnabled", "timezone"]);
    assert.equal(catalog.find((s: any) => s.key === "maintenanceMode").editableBy, "super_admin");
  });

  it("saves only changed keys, audits them once, and keeps them after a reload", async () => {
    const res = await server.put("/api/v1/admin/settings", { tagline: "Learn. Build. Get hired.", instituteName: "Nexelvoria Academy" }, auth("admin"));
    assert.equal(res.status, 200);
    assert.equal(settingsAudits().length, 1);
    assert.deepEqual(JSON.parse(String(settingsAudits()[0]!.newValues)), { tagline: "Learn. Build. Get hired." }, "the unchanged name is not audited");
    assert.equal(settingsAudits()[0]!.actorUserId, ids["admin"]);

    const reloaded = (await json(await server.get("/api/v1/admin/settings", auth("super_admin"))))["data"];
    assert.equal(reloaded.tagline, "Learn. Build. Get hired.");

    assert.equal((await server.put("/api/v1/admin/settings", { tagline: "Learn. Build. Get hired." }, auth("admin"))).status, 200);
    assert.equal(settingsAudits().length, 1, "a no-op save writes no audit");
  });

  it("clears an optional value with an empty string and normalises the GSTIN", async () => {
    await server.put("/api/v1/admin/settings", { whatsappNumber: "", gstNumber: "36aabcu9603r1zm" }, auth("admin"));
    const s = (await json(await server.get("/api/v1/admin/settings", auth("admin"))))["data"];
    assert.equal(s.whatsappNumber, undefined);
    assert.equal(s.gstNumber, "36AABCU9603R1ZM");
  });

  it("rejects invalid values and unknown keys without saving anything", async () => {
    const before = JSON.stringify(harness.admin.instituteSettings);
    for (const body of [
      { supportEmail: "not-an-email" },
      { gstNumber: "12345" },
      { supportPhone: "call me" },
      { instituteName: "X" },
      { razorpayKeySecret: "rzp_secret" },
    ]) {
      assert.equal((await server.put("/api/v1/admin/settings", body, auth("super_admin"))).status, 422, JSON.stringify(body));
    }
    assert.equal(JSON.stringify(harness.admin.instituteSettings), before);
    assert.equal(settingsAudits().length, 0);
  });

  it("refuses settings that would only be stored, naming the decision each one waits on", async () => {
    for (const body of [{ timezone: "Europe/London" }, { minAttendancePercentage: 60 }, { isSmsEnabled: true }, { currencySymbol: "$" }]) {
      const res = await server.put("/api/v1/admin/settings", body, auth("super_admin"));
      assert.equal(res.status, 422, JSON.stringify(body));
      const detail = (await json(res))["details"][0];
      assert.equal(detail.field, Object.keys(body)[0]);
    }
    // D1: below the BR-011 floor is refused (no longer "waits on Q8").
    const res = await json(await server.put("/api/v1/admin/settings", { minAttendancePercentage: 60 }, auth("admin")));
    assert.match(res["details"][0].message, /75%/);
    assert.equal(harness.admin.instituteSettings.minAttendancePercentage, 75, "unchanged");
    assert.equal(settingsAudits().length, 0);
  });

  it("keeps the previous values when the audit cannot be written", async () => {
    harness.admin.failSettingsAudit = true;
    assert.equal((await server.put("/api/v1/admin/settings", { tagline: "Will not stick" }, auth("admin"))).status, 500);
    harness.admin.failSettingsAudit = false;
    const s = (await json(await server.get("/api/v1/admin/settings", auth("admin"))))["data"];
    assert.notEqual(s.tagline, "Will not stick");
  });

  it("lets only the Super Admin switch maintenance mode, and enforces it for everyone else", async () => {
    assert.equal((await server.put("/api/v1/super-admin/maintenance", { enabled: true }, auth("admin"))).status, 403);
    assert.deepEqual((await json(await server.get("/api/v1/maintenance")))["data"], { enabled: false });

    const on = await server.put("/api/v1/super-admin/maintenance", { enabled: true, message: "Upgrading the LMS until 6 pm." }, auth("super_admin"));
    assert.equal(on.status, 200);
    assert.deepEqual((await json(await server.get("/api/v1/maintenance")))["data"], { enabled: true, message: "Upgrading the LMS until 6 pm." });

    const blocked = await server.get("/api/v1/admin/settings", auth("admin"));
    assert.equal(blocked.status, 503);
    const body = await json(blocked);
    assert.equal(body["error"], "MAINTENANCE_MODE");
    assert.equal(body["message"], "Upgrading the LMS until 6 pm.");
    assert.equal((await server.get("/api/v1/public/faqs")).status, 503, "public API too");
    assert.equal((await server.get("/api/v1/health")).status, 200, "health stays up");
    assert.notEqual((await server.post("/api/v1/auth/login", { identifier: "nobody@cfg.test", password: "Wrong#123" })).status, 503, "sign-in stays open");
    assert.equal((await server.get("/api/v1/admin/settings", auth("super_admin"))).status, 200, "Super Admins keep working");

    assert.equal((await server.put("/api/v1/super-admin/maintenance", { enabled: true, message: "Upgrading the LMS until 6 pm." }, auth("super_admin"))).status, 200);
    assert.equal((await server.put("/api/v1/super-admin/maintenance", { enabled: false }, auth("super_admin"))).status, 200);
    assert.equal((await server.get("/api/v1/admin/settings", auth("admin"))).status, 200, "off again immediately");
    const changes = settingsAudits().map((l) => JSON.parse(String(l.newValues)));
    assert.deepEqual(changes, [{ maintenanceMode: true, maintenanceMessage: "Upgrading the LMS until 6 pm." }, { maintenanceMode: false }], "the repeated enable was a no-op");
    assert.equal((await server.put("/api/v1/super-admin/maintenance", { enabled: "yes" }, auth("super_admin"))).status, 422);
  });

  it("prints the institute name on report exports", async () => {
    const res = await server.get("/api/v1/admin/reports/students/export?format=pdf", auth("admin"));
    assert.equal(res.status, 200);
    assert.match(Buffer.from(await res.arrayBuffer()).toString("latin1"), /\(Institute: Nexelvoria Academy\) Tj/);
  });

  it("keeps platform configuration read-only and reports integrations without claiming they work", async () => {
    assert.equal((await server.put("/api/v1/super-admin/system-config", {}, auth("super_admin"))).status, 422);
    const cfg = (await json(await server.get("/api/v1/super-admin/system-config", auth("super_admin"))))["data"];
    assert.equal(cfg.integrations.paymentGateway.verified, false);
    assert.equal(cfg.integrations.paymentGateway.checkoutIntegrated, false);
    assert.equal(cfg.integrations.fileStorage.configured, false);
    assert.equal(cfg.integrations.whatsapp.configured, false);
    assert.equal(cfg.integrations.backups.configured, false);
    assert.equal((await server.get("/api/v1/super-admin/system-config", auth("admin"))).status, 403);
  });
});

describe("system configuration status", () => {
  it("reports that a gateway secret exists without ever returning it", () => {
    const status = buildSystemConfigStatus({ NODE_ENV: "development", RAZORPAY_WEBHOOK_SECRET: "whsec_super_secret_value" } as NodeJS.ProcessEnv);
    assert.equal(status.integrations.paymentGateway.webhookSecretConfigured, true);
    assert.doesNotMatch(JSON.stringify(status), /whsec_super_secret_value/);
    assert.equal(buildSystemConfigStatus({ NODE_ENV: "development" } as NodeJS.ProcessEnv).integrations.paymentGateway.webhookSecretConfigured, false);
  });
});

describe("institute settings (SQL Server adapter, mock pool)", () => {
  const tracked = (handler: (q: string, inputs: Record<string, unknown>) => unknown) => {
    const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
    const state = { committed: 0, rolledBack: 0 };
    const request = () => {
      const inputs: Record<string, unknown> = {};
      const r = {
        input(name: string, t: unknown, v?: unknown) {
          inputs[name] = v !== undefined ? v : t;
          return r;
        },
        async query(q: string) {
          seen.push({ q, inputs: { ...inputs } });
          const res = handler(q, inputs);
          if (res instanceof Error) throw res;
          return { recordset: (res as any)?.recordset ?? [], rowsAffected: [1] };
        },
      };
      return r;
    };
    const pool = {
      request,
      transaction: () => ({ begin: async () => {}, commit: async () => void state.committed++, rollback: async () => void state.rolledBack++, request }),
    } as unknown as sql.ConnectionPool;
    return { seen, state, repo: new SqlServerAdminRepository(async () => pool) };
  };

  it("never reads secret-flagged rows and maps maintenance settings", async () => {
    const t = tracked(() => ({ recordset: [{ SettingKey: "maintenanceMode", SettingValue: "true" }, { SettingKey: "maintenanceMessage", SettingValue: "Back soon" }] }));
    const s = await t.repo.getInstituteSettings();
    assert.match(t.seen[0]!.q, /WHERE IsSecret = 0/);
    assert.equal(s.maintenanceMode, true);
    assert.equal(s.maintenanceMessage, "Back soon");
  });

  it("rolls the setting change back when the audit insert fails", async () => {
    const t = tracked((q) => {
      if (q.includes("WITH (UPDLOCK)")) return { recordset: [{ SettingKey: "tagline", SettingValue: "Old" }] };
      if (q.includes("INSERT INTO dbo.NXA_AuditLogs")) return new Error("audit insert failed");
      return { recordset: [] };
    });
    await assert.rejects(t.repo.saveInstituteSettings({ tagline: "New" }, "5"), /audit insert failed/);
    assert.deepEqual(t.state, { committed: 0, rolledBack: 1 });
    assert.ok(t.seen.some((x) => x.q.includes("MERGE dbo.NXA_InstituteSettings")), "the write was inside the rolled-back transaction");
  });

  it("writes nothing and no audit for a no-op save", async () => {
    const t = tracked((q) => (q.includes("WITH (UPDLOCK)") ? { recordset: [{ SettingKey: "tagline", SettingValue: "Same" }] } : { recordset: [] }));
    await t.repo.saveInstituteSettings({ tagline: "Same" }, "5");
    assert.equal(t.seen.filter((x) => /MERGE|INSERT/.test(x.q)).length, 0);
    assert.equal(t.state.committed, 1);
  });
});
