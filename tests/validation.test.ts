import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { z } from "zod";

import { errorHandler } from "../src/middleware/error.middleware";
import { requestContext } from "../src/middleware/request-context.middleware";
import {
  getListQuery,
  getPagination,
  listQuerySchema,
  paginationSchema,
  resolveSortField,
  validate,
} from "../src/middleware/validate.middleware";
import { sendSuccess } from "../src/utils/send";
import { startServer, json, type TestServer } from "./helpers/server";

const SORTABLE = ["createdAt", "name", "email"] as const;

const buildApp = () => {
  const app = express();
  app.use(requestContext);
  app.use(express.json());

  app.post(
    "/body",
    validate({
      body: z.object({
        email: z.string().email(),
        age: z.coerce.number().int().min(18),
        nested: z.object({ city: z.string().min(1) }).optional(),
      }),
    }),
    (req, res) => sendSuccess(res, { data: req.body }),
  );

  app.get(
    "/params/:studentId",
    validate({ params: z.object({ studentId: z.string().uuid() }) }),
    (req, res) => sendSuccess(res, { data: req.params }),
  );

  app.get("/page", validate({ query: paginationSchema }), (req, res) =>
    sendSuccess(res, { data: getPagination(req) }),
  );

  app.get("/list", validate({ query: listQuerySchema }), (req, res) => {
    const q = getListQuery(req);
    sendSuccess(res, {
      data: { ...q, resolvedSort: resolveSortField(q.sortBy, SORTABLE) ?? null },
    });
  });

  // All three sections at once, to prove issues are aggregated.
  app.post(
    "/all/:id",
    validate({
      params: z.object({ id: z.string().min(5) }),
      query: z.object({ mode: z.enum(["full", "partial"]) }),
      body: z.object({ title: z.string().min(3) }),
    }),
    (_req, res) => sendSuccess(res, { message: "ok" }),
  );

  app.use(errorHandler);
  return app;
};

/** Runs one request against a fresh server and tears it down. */
const call = async <T>(fn: (s: TestServer) => Promise<T>): Promise<T> => {
  const server = await startServer(buildApp());

  try {
    return await fn(server);
  } finally {
    await server.close();
  }
};

type Detail = { field: string; message: string };

describe("request validation", () => {
  describe("body validation", () => {
    it("accepts valid input and applies coercion", async () => {
      await call(async (s) => {
        const res = await s.post("/body", { email: "a@b.com", age: "25" });
        assert.equal(res.status, 200);

        // The string "25" is coerced to the number 25.
        assert.deepEqual((await json(res))["data"], { email: "a@b.com", age: 25 });
      });
    });

    it("returns 422 with field-level details", async () => {
      await call(async (s) => {
        const res = await s.post("/body", { email: "nope", age: 12 });
        assert.equal(res.status, 422);

        const body = await json(res);
        assert.equal(body["success"], false);
        assert.equal(body["error"], "VALIDATION_ERROR");

        const details = body["details"] as Detail[];
        assert.equal(details.length, 2);
        assert.deepEqual(details.map((d) => d.field).sort(), ["age", "email"]);
      });
    });

    it("reports nested fields with a dotted path", async () => {
      await call(async (s) => {
        const res = await s.post("/body", {
          email: "a@b.com",
          age: 20,
          nested: { city: "" },
        });

        const details = (await json(res))["details"] as Detail[];
        assert.equal(details[0]?.field, "nested.city");
      });
    });

    it("includes a requestId on validation failures", async () => {
      await call(async (s) => {
        const res = await s.post("/body", {});
        assert.equal((await json(res))["requestId"], res.headers.get("x-request-id"));
      });
    });
  });

  describe("route param validation", () => {
    it("rejects a non-uuid param with 422", async () => {
      await call(async (s) => {
        const res = await s.get("/params/not-a-uuid");
        assert.equal(res.status, 422);

        const details = (await json(res))["details"] as Detail[];
        assert.equal(details[0]?.field, "studentId");
      });
    });

    it("accepts a valid uuid param", async () => {
      await call(async (s) => {
        const res = await s.get("/params/3f1b8c2e-5d4a-4b1e-9c3d-7a2e6f8b1c04");
        assert.equal(res.status, 200);
      });
    });
  });

  describe("query validation", () => {
    it("applies pagination defaults matching the frontend page size", async () => {
      await call(async (s) => {
        const res = await s.get("/page");
        assert.deepEqual((await json(res))["data"], { page: 1, pageSize: 10 });
      });
    });

    it("coerces numeric query strings", async () => {
      await call(async (s) => {
        const res = await s.get("/page?page=3&pageSize=25");
        assert.deepEqual((await json(res))["data"], { page: 3, pageSize: 25 });
      });
    });

    it("rejects pageSize over the maximum rather than clamping", async () => {
      await call(async (s) => {
        const res = await s.get("/page?pageSize=9999");
        assert.equal(res.status, 422);

        const details = (await json(res))["details"] as Detail[];
        assert.equal(details[0]?.field, "pageSize");
      });
    });

    it("rejects an invalid sortOrder", async () => {
      await call(async (s) => {
        const res = await s.get("/list?sortOrder=sideways");
        assert.equal(res.status, 422);
      });
    });

    it("defaults sortOrder to asc", async () => {
      await call(async (s) => {
        const res = await s.get("/list");
        const data = (await json(res))["data"] as Record<string, unknown>;
        assert.equal(data["sortOrder"], "asc");
      });
    });
  });

  describe("sort field allow-list", () => {
    it("resolves a permitted sort field", async () => {
      await call(async (s) => {
        const res = await s.get("/list?sortBy=name");
        const data = (await json(res))["data"] as Record<string, unknown>;
        assert.equal(data["resolvedSort"], "name");
      });
    });

    it("drops an injection attempt instead of passing it through", async () => {
      await call(async (s) => {
        const res = await s.get("/list?sortBy=name%3B%20DROP%20TABLE%20Students--");
        const data = (await json(res))["data"] as Record<string, unknown>;

        // Falls back to the module default; the raw string never resolves.
        assert.equal(data["resolvedSort"], null);
      });
    });

    it("resolveSortField is a pure allow-list check", () => {
      assert.equal(resolveSortField("name", SORTABLE), "name");
      assert.equal(resolveSortField("password", SORTABLE), undefined);
      assert.equal(resolveSortField(undefined, SORTABLE), undefined);
      // Case-sensitive on purpose: column names are exact.
      assert.equal(resolveSortField("NAME", SORTABLE), undefined);
    });
  });

  describe("multi-section validation", () => {
    it("aggregates issues from params, query and body in one response", async () => {
      await call(async (s) => {
        const res = await fetch(`${s.url}/all/ab?mode=weird`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "x" }),
        });

        assert.equal(res.status, 422);

        const details = (await json(res))["details"] as Detail[];
        assert.deepEqual(details.map((d) => d.field).sort(), ["id", "mode", "title"]);
      });
    });
  });
});
