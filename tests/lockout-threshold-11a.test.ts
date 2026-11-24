import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { effectiveLockoutThreshold, isCredentialLocked } from "../src/modules/auth/credential.types";
import { hashPassword } from "../src/modules/auth/password.service";
import { SqlServerCredentialRepository } from "../src/modules/auth/sqlserver-credential.repository";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Item 11A-3: approved decision D7. A lockout lasts until a password reset or
 * an Admin unlock; the Super Admin sets the threshold (3-10, default 5,
 * audited); a threshold change never locks or unlocks anyone retroactively.
 * Mock pools and in-memory fakes only.
 */

describe("D7 lock rule (unit)", () => {
  it("uses the stored lock flag when it is known, so threshold changes are not retroactive", () => {
    assert.equal(isCredentialLocked({ failedLoginAttempts: 4, isLocked: false }, 3), false, "lowered threshold does not lock");
    assert.equal(isCredentialLocked({ failedLoginAttempts: 5, isLocked: true }, 10), true, "raised threshold does not unlock");
    assert.equal(isCredentialLocked({ failedLoginAttempts: 5 }, 5), true, "no stored flag: the counter rule");
    assert.equal(isCredentialLocked({ failedLoginAttempts: 4 }, 5), false);
  });

  it("accepts only whole numbers 3-10 and otherwise keeps the current 5", () => {
    for (const v of [3, 5, 10]) assert.equal(effectiveLockoutThreshold(v, 5), v);
    for (const v of [undefined, null, 2, 11, 3.5, Number.NaN]) assert.equal(effectiveLockoutThreshold(v as any, 5), 5, String(v));
  });
});

describe("D7 SQL credential statements (mock pool)", () => {
  const capture = () => {
    const log: Array<{ q: string; inputs: Record<string, unknown> }> = [];
    const request = () => {
      const inputs: Record<string, unknown> = {};
      const r: any = {
        input: (n: string, t: unknown, v?: unknown) => ((inputs[n] = v !== undefined ? v : t), r),
        query: async (q: string) => (log.push({ q, inputs }), { recordset: [{ FailedLoginAttempts: 3, IsLocked: true, LockoutUntil: null }], rowsAffected: [1] }),
      };
      return r;
    };
    return { pool: { request } as unknown as sql.ConnectionPool, log };
  };

  it("decides the lock with the threshold in force when the failure is recorded, and reports the stored flag", async () => {
    const { pool, log } = capture();
    const state = await new SqlServerCredentialRepository(pool).recordFailedAttempt({ userId: "42", threshold: 3 });
    assert.equal(log[0]!.inputs["threshold"], 3);
    assert.match(log[0]!.q, /IsLocked = CASE WHEN FailedLoginAttempts \+ 1 >= @threshold THEN 1 ELSE IsLocked END/);
    assert.equal(state.isLocked, true);
  });

  it("guards the counter reset on the stored flag only (no retroactive lock from a lowered threshold)", async () => {
    const { pool, log } = capture();
    await new SqlServerCredentialRepository(pool).resetFailedAttemptsIfAuthorized({ userId: "42", threshold: 3, acceptableHashes: ["h"] }).catch(() => undefined);
    assert.match(log[0]!.q, /AND IsLocked = 0/);
    assert.doesNotMatch(log[0]!.q, /FailedLoginAttempts < @threshold/);
  });
});

describe("D7 threshold setting and sign-in (HTTP, in-memory fakes)", () => {
  const PASSWORD = "Correct!Pass1";
  let harness: TestHarness;
  let server: TestServer;
  let user: { id: string; email: string };
  const tokens: Record<string, string> = {};
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const auth = (who: string) => ({ headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" } });
  const login = (password: string) => server.post("/api/v1/auth/login", { identifier: user.email, password });
  const setThreshold = (value: unknown, who = "super") => server.put("/api/v1/admin/settings", { maxFailedLoginAttempts: value }, auth(who));

  beforeEach(async () => {
    harness = createTestHarness();
    const u = await harness.users.create({ name: "Teacher T", email: "teacher-lock@test.local", mobile: "9876543499", role: "teacher", status: "active" });
    await harness.credentials.create({ userId: u.id, passwordHash: await hashPassword(PASSWORD) });
    user = { id: u.id, email: "teacher-lock@test.local" };
    for (const [key, id, role] of [["super", "202", "super_admin"], ["admin", "201", "admin"]] as const) {
      const session = await harness.sessions.create({ userId: id, refreshTokenHash: Buffer.alloc(64, 7).toString("hex"), ipAddress: "127.0.0.1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      tokens[key] = issueAccessToken({ userId: id, role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("lets only the Super Admin set the threshold, 3 to 10, audited", async () => {
    for (const v of [2, 11, 3.5, "abc"]) assert.equal((await setThreshold(v)).status, 422, String(v));
    const admin = await setThreshold(4, "admin");
    assert.equal(admin.status, 403);
    assert.equal((await json(admin))["error"], "SUPER_ADMIN_SETTING");
    assert.equal(harness.admin.auditLogs.length, 0);

    assert.equal((await setThreshold(4)).status, 200);
    const audit = harness.admin.auditLogs.filter((l) => l.actionType === "UPDATE_SETTINGS");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actorUserId, "202");
    assert.deepEqual(JSON.parse(String(audit[0]!.newValues)), { maxFailedLoginAttempts: 4 });

    const cfg = (await json(await server.get("/api/v1/super-admin/system-config", auth("super"))))["data"];
    assert.equal(cfg.security.maxFailedLoginAttempts, 4, "System Config shows the threshold in force");
  });

  it("keeps the default of 5 until the setting is saved", async () => {
    for (let i = 0; i < 4; i++) assert.equal((await login("Wrong!Pass1")).status, 401);
    assert.equal((await harness.credentials.findByUserId(user.id))!.isLocked, false, "4 failures do not lock under the default 5");
    await login("Wrong!Pass1");
    // (Few requests per test: the sign-in rate limiter is not what is under test.)
    const locked = await login(PASSWORD);
    assert.equal((await json(locked))["error"], "ACCOUNT_LOCKED");
  });

  it("applies a saved threshold at the next failure, and locks until reset or Admin unlock", async () => {
    await setThreshold(3);
    for (let i = 0; i < 3; i++) await login("Wrong!Pass1");
    assert.equal((await json(await login(PASSWORD)))["error"], "ACCOUNT_LOCKED", "a correct password does not unlock");

    await setThreshold(10);
    assert.equal((await json(await login(PASSWORD)))["error"], "ACCOUNT_LOCKED", "raising the threshold does not unlock either");

    await harness.credentials.clearLockout(user.id);
    assert.equal((await login(PASSWORD)).status, 200, "an Admin unlock clears it");
  });

  it("does not lock anyone retroactively when the threshold is lowered", async () => {
    for (let i = 0; i < 4; i++) await login("Wrong!Pass1");
    await setThreshold(3);
    assert.equal((await login(PASSWORD)).status, 200, "4 earlier failures under 5 stay unlocked after lowering to 3");

    // The next failures are counted against the new threshold.
    for (let i = 0; i < 3; i++) await login("Wrong!Pass1");
    assert.equal((await json(await login(PASSWORD)))["error"], "ACCOUNT_LOCKED");
  });
});
