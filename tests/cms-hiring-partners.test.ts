import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type sql from "mssql";

import { createApp } from "../src/app";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { issueAccessToken } from "../src/modules/auth/token.service";
import { SqlServerCmsRepository } from "../src/modules/cms/sqlserver-cms.repository";
import { createTestHarness, type TestHarness } from "./fakes";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Batch 2 item 6: hiring partners are NXA_Companies rows. The live table has
 * no LogoUrl (or featured / display-order) column, so no logo is read or
 * written and none is invented; placementsCount is the real count of
 * NXA_PlacementRecords.
 */

type Handler = (q: string, inputs: Record<string, unknown>) => unknown;

class MockSqlRequest {
  inputs: Record<string, unknown> = {};
  constructor(private readonly handler: Handler) {}
  input(name: string, typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : typeOrValue;
    return this;
  }
  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) throw res;
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
  }
}

const tracked = (handler: Handler) => {
  const seen: Array<{ q: string; inputs: Record<string, unknown> }> = [];
  const request = () =>
    new MockSqlRequest((q, inputs) => {
      seen.push({ q, inputs: { ...inputs } });
      return handler(q, inputs);
    });
  // Writes run in a transaction together with their audit row.
  const pool = {
    request,
    transaction: () => ({ begin: async () => {}, commit: async () => {}, rollback: async () => {}, request }),
  } as unknown as sql.ConnectionPool;
  return { seen, repo: new SqlServerCmsRepository(async () => pool) };
};

const companyRow = (over: Record<string, unknown> = {}) => ({
  CompanyId: 11, CompanyName: "TCS", Industry: "IT Services", WebsiteUrl: "https://tcs.com", IsActive: true, PlacementsCount: 4, ...over,
});

describe("hiring partners against NXA_Companies (SQL Server adapter)", () => {
  it("lists partners from live columns only, with no logo and a real placement count", async () => {
    const t = tracked(() => ({ recordset: [companyRow(), companyRow({ CompanyId: 12, CompanyName: "Infosys", Industry: null, WebsiteUrl: null, PlacementsCount: 0 })] }));
    const [a, b] = await t.repo.getHiringPartners(false);
    const q = t.seen[0]!.q;
    assert.doesNotMatch(q, /LogoUrl/i, "NXA_Companies has no LogoUrl column");
    assert.match(q, /c\.CompanyId, c\.CompanyName, c\.Industry, c\.WebsiteUrl, c\.IsActive/);
    assert.match(q, /SELECT COUNT\(1\) FROM dbo\.NXA_PlacementRecords p WHERE p\.CompanyId = c\.CompanyId/);
    assert.doesNotMatch(q, /IsActive = 1/);
    assert.deepEqual(a, { id: "11", name: "TCS", industry: "IT Services", websiteUrl: "https://tcs.com", placementsCount: 4, isActive: true });
    assert.equal("logoUrl" in b!, false, "missing logo is absent, not an empty or placeholder value");
    assert.equal("isFeatured" in b!, false, "no featured flag is invented");
    assert.equal("industry" in b!, false, "no default industry is invented");
    assert.equal(b!.placementsCount, 0);
  });

  it("returns only active partners for the public site", async () => {
    const t = tracked(() => ({ recordset: [companyRow()] }));
    await t.repo.getHiringPartners(true);
    assert.match(t.seen[0]!.q, /WHERE c\.IsActive = 1 ORDER BY c\.CompanyName ASC/);
  });

  it("creates a partner without a logo column, even when a logo is supplied, and returns the stored record", async () => {
    const t = tracked((q) => {
      if (q.includes("INSERT INTO dbo.NXA_Companies")) return { recordset: [{ CompanyId: 13 }] };
      return { recordset: [companyRow({ CompanyId: 13, CompanyName: "Wipro", PlacementsCount: 0 })] };
    });
    const saved = await t.repo.saveHiringPartner(
      { id: "", name: "Wipro", industry: "IT Services", logoUrl: "https://x.test/wipro.png", isFeatured: true, placementsCount: 99, isActive: true },
      "7",
    );
    const ins = t.seen.find((s) => s.q.includes("INSERT INTO dbo.NXA_Companies"))!;
    assert.match(ins.q, /\(CompanyName, Industry, WebsiteUrl, IsActive, CreatedAt\)/);
    assert.doesNotMatch(ins.q, /LogoUrl/i);
    assert.equal("logoUrl" in ins.inputs, false);
    assert.equal(saved.id, "13");
    assert.equal("logoUrl" in saved, false, "the response reflects what was stored");
    assert.equal(saved.placementsCount, 0, "a client-supplied count is not stored or echoed");
  });

  it("updates an existing partner without LogoUrl and reports an unknown id", async () => {
    const t = tracked((q) => (q.includes("UPDATE dbo.NXA_Companies") ? { recordset: [], rowsAffected: [1] } : { recordset: [companyRow({ IsActive: false })] }));
    const saved = await t.repo.saveHiringPartner({ id: "11", name: "TCS", isActive: false }, "7");
    const upd = t.seen.find((s) => s.q.includes("UPDATE dbo.NXA_Companies"))!;
    assert.match(upd.q, /SET CompanyName = @name, Industry = @industry, WebsiteUrl = @websiteUrl, IsActive = @isActive/);
    assert.doesNotMatch(upd.q, /LogoUrl/i);
    assert.equal(upd.inputs["isActive"], 0);
    assert.equal(saved.isActive, false);

    const missing = tracked(() => ({ recordset: [], rowsAffected: [0] }));
    await assert.rejects(missing.repo.saveHiringPartner({ id: "99", name: "Ghost", isActive: true }, "7"), (err: Error) => err.name === "RecordNotFoundError");
  });

  it("never inserts a company for a non-numeric id such as a sample id", async () => {
    const t = tracked(() => ({ recordset: [{ CompanyId: 14 }] }));
    for (const id of ["hp-1", "prt-123", "12abc", " 12"]) {
      await assert.rejects(t.repo.saveHiringPartner({ id, name: "TCS", isActive: true }, "7"), (err: Error) => err.name === "RecordNotFoundError", id);
    }
    assert.equal(t.seen.length, 0, "no INSERT or UPDATE was sent");
  });

  it("reports a company still referenced by jobs or placements instead of failing", async () => {
    const t = tracked(() => Object.assign(new Error("The DELETE statement conflicted with the REFERENCE constraint"), { number: 547 }));
    await assert.rejects(t.repo.deleteHiringPartner("11", "7"), (err: Error) => err.name === "CompanyInUseError");
  });
});

describe("hiring partner endpoints (public website and Admin CMS)", () => {
  let harness: TestHarness;
  let server: TestServer;
  const tokens: Record<string, string> = {};
  const auth = (role: string) => ({ headers: { Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    harness = createTestHarness();
    let seq = 80;
    for (const role of ["admin", "super_admin", "teacher", "student"] as const) {
      seq++;
      const user = await harness.users.create({ name: `${role} User`, email: `${role}-${seq}@test.local`, mobile: `98765432${seq}`, role, status: "active" });
      const session = await harness.sessions.create({
        userId: user.id,
        refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      tokens[role] = issueAccessToken({ userId: user.id, role, sessionId: session.sessionId }).token;
    }
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("saves a partner for Admin, says the logo was not stored, and returns no logo", async () => {
    const res = await server.post(
      "/api/v1/admin/cms/partners",
      { name: "Accenture", industry: "Consulting", logoUrl: "https://x.test/acn.png", isFeatured: true, isActive: true },
      auth("admin"),
    );
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.match(body["message"], /Not stored \(the database has no column for them\): logoUrl, isFeatured/);
    assert.equal(body["data"].logoUrl, undefined);
    assert.equal(body["data"].isFeatured, undefined);
    assert.equal(body["data"].name, "Accenture");

    const plain = await json(await server.post("/api/v1/admin/cms/partners", { name: "Capgemini", isActive: false }, auth("super_admin")));
    assert.equal(plain["message"], "Hiring partner saved successfully");
  });

  it("serves the public list without authentication, active partners only, with no logo", async () => {
    await server.post("/api/v1/admin/cms/partners", { name: "Accenture", logoUrl: "https://x.test/acn.png", isActive: true }, auth("admin"));
    await server.post("/api/v1/admin/cms/partners", { name: "Hidden Co", isActive: false }, auth("admin"));
    const res = await server.get("/api/v1/public/partners");
    assert.equal(res.status, 200);
    const list = (await json(res))["data"] as Array<Record<string, unknown>>;
    assert.deepEqual(list.map((p) => p["name"]), ["Accenture"]);
    assert.equal(list[0]!["logoUrl"], undefined);

    const all = (await json(await server.get("/api/v1/admin/cms/partners", auth("admin"))))["data"] as unknown[];
    assert.equal(all.length, 2);
  });

  it("keeps partner management Admin / Super Admin only", async () => {
    for (const role of ["teacher", "student"]) {
      assert.equal((await server.get("/api/v1/admin/cms/partners", auth(role))).status, 403, role);
      assert.equal((await server.post("/api/v1/admin/cms/partners", { name: "X Corp", isActive: true }, auth(role))).status, 403, role);
    }
    assert.equal((await server.get("/api/v1/admin/cms/partners")).status, 401);
    assert.equal(harness.cms.partners.length, 0);
  });

  it("validates partner fields against the column sizes", async () => {
    assert.equal((await server.post("/api/v1/admin/cms/partners", { name: "X".repeat(201), isActive: true }, auth("admin"))).status, 422);
    assert.equal((await server.post("/api/v1/admin/cms/partners", { name: "Valid Co", websiteUrl: "not a url", isActive: true }, auth("admin"))).status, 422);
  });

  it("refuses to delete a company still in use with 409, and deletes an unused one", async () => {
    const created = (await json(await server.post("/api/v1/admin/cms/partners", { name: "Used Co", isActive: true }, auth("admin"))))["data"];
    harness.cms.referencedCompanyIds.add(created.id);
    const refused = await server.delete(`/api/v1/admin/cms/partners/${created.id}`, auth("admin"));
    assert.equal(refused.status, 409);
    assert.equal((await json(refused))["error"], "COMPANY_IN_USE");
    harness.cms.referencedCompanyIds.clear();
    assert.equal((await server.delete(`/api/v1/admin/cms/partners/${created.id}`, auth("admin"))).status, 200);
  });
});

describe("hiring partner ids: updates never create duplicate companies", () => {
  let harness: TestHarness;
  let server: TestServer;
  let token: string;
  const auth = () => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  beforeEach(async () => {
    harness = createTestHarness();
    const user = await harness.users.create({ name: "Admin User", email: "admin-90@test.local", mobile: "9876543290", role: "admin", status: "active" });
    const session = await harness.sessions.create({
      userId: user.id,
      refreshTokenHash: Buffer.alloc(64, 1).toString("hex"),
      ipAddress: "127.0.0.1",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    token = issueAccessToken({ userId: user.id, role: "admin", sessionId: session.sessionId }).token;
    const authenticate = createAuthenticate({ studentAccess: null, sessions: () => harness.sessions });
    server = await startServer(createApp({ container: harness.container, authenticate }));
  });

  afterEach(async () => {
    await server.close();
  });

  it("refuses an update with a sample id (as the admin screen sends) with 422, however often it is repeated", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await server.put("/api/v1/admin/cms/partners/hp-1", { id: "hp-1", name: "Accenture", logoUrl: "https://x.test/a.png", isActive: true }, auth());
      assert.equal(res.status, 422);
      const body = await json(res);
      assert.equal(body["error"], "VALIDATION_ERROR");
      assert.match(JSON.stringify(body["details"]), /A valid database company ID \(numeric\) is required/);
    }
    assert.equal(harness.cms.partners.length, 0, "no company was created");
  });

  it("refuses other invalid ids and a body id that differs from the URL", async () => {
    for (const id of ["abc", "12abc", "-5", "1.5", "99999999999999999999"]) {
      const res = await server.put(`/api/v1/admin/cms/partners/${encodeURIComponent(id)}`, { name: "Accenture", isActive: true }, auth());
      assert.equal(res.status, 422, id);
    }
    const created = (await json(await server.post("/api/v1/admin/cms/partners", { name: "Accenture", isActive: true }, auth())))["data"];
    const mismatch = await server.put(`/api/v1/admin/cms/partners/${created.id}`, { id: "hp-1", name: "Renamed", isActive: true }, auth());
    assert.equal(mismatch.status, 422);
    assert.equal(harness.cms.partners.length, 1);
    assert.equal(harness.cms.partners[0]!.name, "Accenture", "nothing was changed");
  });

  it("returns 404 for a well-formed id that does not exist, without creating it", async () => {
    const res = await server.put("/api/v1/admin/cms/partners/424242", { name: "Ghost Co", isActive: true }, auth());
    assert.equal(res.status, 404);
    assert.equal(harness.cms.partners.length, 0);
  });

  it("creates through POST (ignoring any body id) and updates through the numeric id", async () => {
    const created = await json(await server.post("/api/v1/admin/cms/partners", { id: "hp-1", name: "Accenture", isActive: true }, auth()));
    const id = created["data"].id as string;
    assert.match(id, /^\d+$/, "the database id is used, not the client's sample id");

    const updated = await server.put(`/api/v1/admin/cms/partners/${id}`, { id, name: "Accenture India", isActive: false }, auth());
    assert.equal(updated.status, 200);
    assert.equal((await json(updated))["data"].name, "Accenture India");
    const withoutBodyId = await server.put(`/api/v1/admin/cms/partners/${id}`, { name: "Accenture Ltd", isActive: true }, auth());
    assert.equal(withoutBodyId.status, 200);

    assert.equal(harness.cms.partners.length, 1, "updates did not add companies");
    assert.equal(harness.cms.partners[0]!.name, "Accenture Ltd");

    const second = await json(await server.post("/api/v1/admin/cms/partners", { id, name: "Another Co", isActive: true }, auth()));
    assert.notEqual(second["data"].id, id, "POST never overwrites an existing company");
    assert.equal(harness.cms.partners.length, 2);
    assert.equal(harness.cms.partners.find((p) => p.id === id)!.name, "Accenture Ltd");
  });
});
