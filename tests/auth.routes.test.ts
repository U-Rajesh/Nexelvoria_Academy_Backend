import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import express, { type RequestHandler } from "express";
import jwt from "jsonwebtoken";

import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { createContainer } from "../src/container/container";
import type { UserRole } from "../src/contracts/user.contract";
import { createAuthenticate } from "../src/middleware/authenticate.middleware";
import { errorHandler } from "../src/middleware/error.middleware";
import { notFoundHandler } from "../src/middleware/not-found.middleware";
import { createAuthRoutes } from "../src/modules/auth/auth.routes";
import type { CredentialRepository } from "../src/modules/auth/credential.repository";
import { hashPassword } from "../src/modules/auth/password.service";
import type { SessionRepository } from "../src/modules/auth/session.repository";
import { JWT_ALGORITHM, issueAccessToken } from "../src/modules/auth/token.service";
import type { UserRepository } from "../src/modules/users/user.repository";
import type { User } from "../src/modules/users/user.types";
import { RecordNotFoundError } from "../src/repositories/repository.errors";
import { createTestHarness, type TestHarness } from "./fakes";
import { json, startServer, type TestServer } from "./helpers/server";

/**
 * HTTP tests for the authentication endpoints (decisions D1-D4):
 *   POST /api/v1/auth/login, /refresh, /logout   GET /api/v1/auth/me
 *
 * Two kinds of app:
 * - TEST APP: the auth router alone over in-memory fakes, with a no-op login
 *   limiter, so mapping tests are not throttled and repositories can be
 *   overridden to simulate failures.
 * - REAL APP: `createApp` over the same fakes - real middleware stack, real
 *   login limiter, real `env.MAX_FAILED_LOGIN_ATTEMPTS`.
 *
 * No test prints or asserts on a token or secret VALUE.
 */

const PASSWORD = "Password@123";
const WRONG_PASSWORD = "WrongPass@456";
let passwordHash: string;

const BASE_USER_KEYS = ["createdAt", "email", "id", "mobile", "name", "role", "status"];

const withOverrides = <T extends object>(base: T, overrides: Partial<T>): T =>
  new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop in overrides) {
        return overrides[prop as keyof T];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  });

const userFixture = (overrides: Partial<User> = {}): User => ({
  id: "user-1",
  name: "Ananya Rao",
  email: "ananya@test.local",
  mobile: "9876543210",
  role: "admin",
  status: "active",
  createdAt: new Date().toISOString(),
  ...overrides,
});

const seedUser = async (h: TestHarness, overrides: Partial<User> = {}): Promise<User> => {
  const user = h.users.seed(userFixture(overrides));
  await h.credentials.create({ userId: user.id, passwordHash });
  return user;
};

const passThrough: RequestHandler = (_req, _res, next) => next();

interface TestAppOverrides {
  users?: UserRepository;
  credentials?: CredentialRepository;
  sessions?: SessionRepository;
  maxFailedLoginAttempts?: number;
}

/** The auth router alone, over (optionally overridden) fakes. */
const startTestApp = async (h: TestHarness, overrides: TestAppOverrides = {}): Promise<TestServer> => {
  const sessions = (): SessionRepository => overrides.sessions ?? h.sessions;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/auth",
    createAuthRoutes({
      get users() {
        return overrides.users ?? h.users;
      },
      get credentials() {
        return overrides.credentials ?? h.credentials;
      },
      get sessions() {
        return sessions();
      },
      authenticate: createAuthenticate({ sessions }),
      maxFailedLoginAttempts: overrides.maxFailedLoginAttempts ?? 5,
      loginRateLimiter: passThrough,
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return startServer(app);
};

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

/**
 * JSON request with an optional bearer token. (The shared `server.post`
 * helper replaces its Content-Type header when `init.headers` is passed, so
 * calls that need BOTH a JSON body and a token go through here.)
 */
const send = (server: TestServer, method: string, path: string, body?: unknown, token?: string) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const loginOk = async (server: TestServer, identifier: string): Promise<TokenPair> => {
  const res = await server.post("/api/v1/auth/login", { identifier, password: PASSWORD });
  assert.equal(res.status, 200, "login should succeed");
  return (await json(res))["data"] as unknown as TokenPair;
};

const refresh = (server: TestServer, refreshToken: unknown, accessToken?: string) =>
  send(server, "POST", "/api/v1/auth/refresh", { refreshToken }, accessToken);

const logout = (server: TestServer, accessToken: string) => send(server, "POST", "/api/v1/auth/logout", undefined, accessToken);

const me = (server: TestServer, accessToken?: string) =>
  server.get("/api/v1/auth/me", accessToken === undefined ? undefined : bearer(accessToken));

const expectError = async (res: Response, status: number, code: string): Promise<Record<string, unknown>> => {
  const body = await json(res);
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status} ${JSON.stringify(body)}`);
  assert.equal(body["success"], false);
  assert.equal(body["error"], code);
  return body;
};

before(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

// ===========================================================================
// POST /auth/login
// ===========================================================================

describe("POST /auth/login", () => {
  const h = createTestHarness();
  let server: TestServer;

  before(async () => {
    server = await startTestApp(h);
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => h.reset());

  it("returns the user and a token pair on success", async () => {
    const user = await seedUser(h);
    const res = await server.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD });
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.equal(body["success"], true);
    assert.equal(body["message"], "Login successful");

    const data = body["data"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), [
      "accessToken",
      "expiresIn",
      "refreshToken",
      "refreshTokenExpiresAt",
      "sessionId",
      "user",
    ]);
    assert.equal(typeof data["accessToken"], "string");
    assert.equal(data["expiresIn"], 900);
    assert.match(String(data["refreshToken"]), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!Number.isNaN(Date.parse(String(data["refreshTokenExpiresAt"]))));
    assert.equal(typeof data["sessionId"], "string");
    assert.deepEqual(Object.keys(data["user"] as object).sort(), BASE_USER_KEYS);
    assert.equal((data["user"] as Record<string, unknown>)["id"], user.id);
    assert.equal(h.sessions.count, 1);
  });

  it("logs in by mobile number too", async () => {
    const user = await seedUser(h);
    const res = await server.post("/api/v1/auth/login", { identifier: user.mobile, password: PASSWORD });
    assert.equal(res.status, 200);
  });

  it("never returns fields beyond the base User, even if a repository adds them", async () => {
    const user = await seedUser(h);
    const leaky = withOverrides<UserRepository>(h.users, {
      findByEmail: async () =>
        ({ ...user, passwordHash: "$argon2id$leak", failedLoginAttempts: 3, refreshTokenHash: "x" }) as unknown as User,
      findById: async () => ({ ...user, passwordHash: "$argon2id$leak" }) as unknown as User,
    });
    const leakyServer = await startTestApp(h, { users: leaky });
    try {
      const res = await leakyServer.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.doesNotMatch(text, /passwordHash|failedLoginAttempts|refreshTokenHash|argon2/);
    } finally {
      await leakyServer.close();
    }
  });

  it("401 INVALID_CREDENTIALS for a wrong password, an unknown account and a malformed body - identically", async () => {
    const user = await seedUser(h);
    const wrong = await expectError(
      await server.post("/api/v1/auth/login", { identifier: user.email, password: WRONG_PASSWORD }),
      401,
      "INVALID_CREDENTIALS",
    );
    const unknown = await expectError(
      await server.post("/api/v1/auth/login", { identifier: "nobody@test.local", password: PASSWORD }),
      401,
      "INVALID_CREDENTIALS",
    );
    const malformed = await expectError(
      await server.post("/api/v1/auth/login", { identifier: user.email }),
      401,
      "INVALID_CREDENTIALS",
    );
    assert.equal(wrong["message"], unknown["message"]);
    assert.equal(wrong["message"], malformed["message"]);
    assert.equal(malformed["details"], undefined, "no field-level validation detail is disclosed");
  });

  it("never discloses failed-attempt counts", async () => {
    const user = await seedUser(h);
    const res = await server.post("/api/v1/auth/login", { identifier: user.email, password: WRONG_PASSWORD });
    const body = await expectError(res, 401, "INVALID_CREDENTIALS");
    assert.deepEqual(Object.keys(body).sort(), ["error", "message", "success"]);
    assert.doesNotMatch(String(body["message"]), /\d/);
  });

  it("403 ACCOUNT_LOCKED when the credential is at the threshold, even with the right password", async () => {
    const user = h.users.seed(userFixture());
    const now = new Date().toISOString();
    h.credentials.seed({
      userId: user.id,
      passwordHash,
      passwordUpdatedAt: now,
      failedLoginAttempts: 5,
      createdAt: now,
      updatedAt: now,
    });
    await expectError(
      await server.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD }),
      403,
      "ACCOUNT_LOCKED",
    );
    assert.equal(h.sessions.count, 0);
  });

  for (const [status, code] of [
    ["pending", "ACCOUNT_PENDING"],
    ["suspended", "ACCOUNT_SUSPENDED"],
    ["deactivated", "ACCOUNT_DEACTIVATED"],
  ] as const) {
    it(`403 ${code} for a ${status} account (correct password)`, async () => {
      const user = await seedUser(h, { status });
      await expectError(
        await server.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD }),
        403,
        code,
      );
      assert.equal(h.sessions.count, 0);
    });

    it(`does not disclose "${status}" to a caller with the wrong password`, async () => {
      const user = await seedUser(h, { status });
      await expectError(
        await server.post("/api/v1/auth/login", { identifier: user.email, password: WRONG_PASSWORD }),
        401,
        "INVALID_CREDENTIALS",
      );
    });
  }

  it("409 CONFLICT when the password changes during the login", async () => {
    const user = await seedUser(h);
    const racing = withOverrides<CredentialRepository>(h.credentials, {
      resetFailedAttemptsIfAuthorized: async () => ({ status: "password_changed" }),
    });
    const racingServer = await startTestApp(h, { credentials: racing });
    try {
      await expectError(
        await racingServer.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD }),
        409,
        "CONFLICT",
      );
      assert.equal(h.sessions.count, 0);
    } finally {
      await racingServer.close();
    }
  });

  it("503 SERVICE_UNAVAILABLE when storage fails, without leaking the internal error", async () => {
    const user = await seedUser(h);
    const broken = withOverrides<UserRepository>(h.users, {
      findByEmail: () => {
        throw new Error("connection reset by sql-server-01: password=hunter2");
      },
    });
    const brokenServer = await startTestApp(h, { users: broken });
    try {
      const res = await brokenServer.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD });
      const body = await expectError(res, 503, "SERVICE_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(body), /connection reset|sql-server|hunter2/);
    } finally {
      await brokenServer.close();
    }
  });

  it("503 when no user/credential adapters are registered", async () => {
    const empty = createTestHarness();
    const app = createApp({ container: createContainer({ sessions: () => empty.sessions }) });
    const bare = await startServer(app);
    try {
      await expectError(
        await bare.post("/api/v1/auth/login", { identifier: "a@test.local", password: PASSWORD }),
        503,
        "SERVICE_UNAVAILABLE",
      );
    } finally {
      await bare.close();
    }
  });

  it("locks at a configured threshold", async () => {
    const user = await seedUser(h);
    const strict = await startTestApp(h, { maxFailedLoginAttempts: 2 });
    try {
      for (let i = 0; i < 2; i += 1) {
        await expectError(
          await strict.post("/api/v1/auth/login", { identifier: user.email, password: WRONG_PASSWORD }),
          401,
          "INVALID_CREDENTIALS",
        );
      }
      await expectError(
        await strict.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD }),
        403,
        "ACCOUNT_LOCKED",
      );
    } finally {
      await strict.close();
    }
  });
});

describe("POST /auth/login - real application (limiter and env threshold)", () => {
  it("uses MAX_FAILED_LOGIN_ATTEMPTS, defaulting to 5", () => {
    assert.equal(env.MAX_FAILED_LOGIN_ATTEMPTS, 5);
  });

  it("locks the account permanently after 5 failures (Q4a: no automatic unlock)", async () => {
    const h = createTestHarness();
    const server = await startServer(createApp({ container: h.container }));
    try {
      const user = await seedUser(h);
      for (let i = 0; i < 5; i += 1) {
        await expectError(
          await server.post("/api/v1/auth/login", { identifier: user.email, password: WRONG_PASSWORD }),
          401,
          "INVALID_CREDENTIALS",
        );
      }
      await expectError(
        await server.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD }),
        403,
        "ACCOUNT_LOCKED",
      );
      const credential = await h.credentials.findByUserId(user.id);
      assert.equal(credential?.failedLoginAttempts, 5);

      // Recovery today is a controlled database intervention.
      await h.credentials.clearLockout(user.id);
      assert.equal((await server.post("/api/v1/auth/login", { identifier: user.email, password: PASSWORD })).status, 200);
    } finally {
      await server.close();
    }
  });

  it("rate-limits login to 10 attempts per window (429 on the 11th)", async () => {
    const h = createTestHarness();
    const server = await startServer(createApp({ container: h.container }));
    try {
      for (let i = 0; i < 10; i += 1) {
        const res = await server.post("/api/v1/auth/login", { identifier: `nobody${i}@test.local`, password: PASSWORD });
        assert.equal(res.status, 401, `attempt ${i + 1}`);
      }
      await expectError(
        await server.post("/api/v1/auth/login", { identifier: "nobody@test.local", password: PASSWORD }),
        429,
        "TOO_MANY_REQUESTS",
      );
      // The limiter is login-only: refresh is not throttled by it.
      assert.equal((await refresh(server, "x")).status, 401);
    } finally {
      await server.close();
    }
  });
});

// ===========================================================================
// POST /auth/refresh
// ===========================================================================

describe("POST /auth/refresh", () => {
  const h = createTestHarness();
  let server: TestServer;
  let user: User;

  before(async () => {
    server = await startTestApp(h);
  });
  after(async () => {
    await server.close();
  });
  beforeEach(async () => {
    h.reset();
    user = await seedUser(h);
  });

  it("rotates the token pair and keeps the session", async () => {
    const first = await loginOk(server, user.email);
    const res = await refresh(server, first.refreshToken);
    const body = await json(res);
    assert.equal(res.status, 200);
    assert.equal(body["message"], "Session refreshed");

    const second = body["data"] as unknown as TokenPair & { user: Record<string, unknown> };
    // The REFRESH token rotates. (The access token is a JWT over sub/role/
    // sid/iat/exp with no unique id, so within the same second it can be
    // byte-identical for the same session - that is expected.)
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.equal(typeof second.accessToken, "string");
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(Object.keys(second.user).sort(), BASE_USER_KEYS);
    assert.equal((await me(server, second.accessToken)).status, 200);
  });

  it("does not need (or read) an access token, even an expired one", async () => {
    const pair = await loginOk(server, user.email);
    const expired = jwt.sign({ role: "admin", sid: pair.sessionId }, env.JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      subject: user.id,
      expiresIn: -120,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    assert.equal((await refresh(server, pair.refreshToken, expired)).status, 200);
  });

  it("401 UNAUTHENTICATED for invalid, missing or non-string tokens - one uniform response", async () => {
    const random = randomBytes(32).toString("base64url");
    const bodies = [
      await expectError(await refresh(server, random), 401, "UNAUTHENTICATED"),
      await expectError(await server.post("/api/v1/auth/refresh", {}), 401, "UNAUTHENTICATED"),
      await expectError(await refresh(server, 12345), 401, "UNAUTHENTICATED"),
      await expectError(await server.post("/api/v1/auth/refresh", ["not", "an", "object"]), 401, "UNAUTHENTICATED"),
    ];
    for (const body of bodies) assert.equal(body["message"], bodies[0]!["message"]);
  });

  it("never answers TOKEN_EXPIRED, so a client cannot be told to refresh again", async () => {
    const res = await refresh(server, "x");
    const body = await json(res);
    assert.notEqual(body["error"], "TOKEN_EXPIRED");
  });

  it("reuse of a rotated token revokes the whole family, without disclosing reuse", async () => {
    const first = await loginOk(server, user.email);
    const secondRes = await refresh(server, first.refreshToken);
    const second = (await json(secondRes))["data"] as unknown as TokenPair;

    const reuse = await expectError(await refresh(server, first.refreshToken), 401, "UNAUTHENTICATED");
    const invalid = await expectError(await refresh(server, randomBytes(32).toString("base64url")), 401, "UNAUTHENTICATED");
    assert.equal(reuse["message"], invalid["message"], "reuse looks exactly like an invalid token");
    assert.doesNotMatch(JSON.stringify(reuse), /reuse|family|revok/i);

    // Family revoked: the legitimate newer token and its access token are dead too.
    await expectError(await refresh(server, second.refreshToken), 401, "UNAUTHENTICATED");
    await expectError(await me(server, second.accessToken), 401, "UNAUTHENTICATED");
    assert.deepEqual(await h.sessions.listSessionsForUser(user.id), []);
  });

  it("401 UNAUTHENTICATED when the user is no longer active", async () => {
    const pair = await loginOk(server, user.email);
    await h.users.setStatus(user.id, "suspended");
    await expectError(await refresh(server, pair.refreshToken), 401, "UNAUTHENTICATED");
  });

  it("503 SERVICE_UNAVAILABLE when session storage fails", async () => {
    const pair = await loginOk(server, user.email);
    const broken = withOverrides<SessionRepository>(h.sessions, {
      resolveRefreshToken: () => {
        throw new Error("connection reset");
      },
    });
    const brokenServer = await startTestApp(h, { sessions: broken });
    try {
      const body = await expectError(await refresh(brokenServer, pair.refreshToken), 503, "SERVICE_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(body), /connection reset/);
    } finally {
      await brokenServer.close();
    }
  });

  it("concurrent refreshes: exactly one succeeds, then the family is revoked (documented)", async () => {
    const pair = await loginOk(server, user.email);
    const results = await Promise.all([refresh(server, pair.refreshToken), refresh(server, pair.refreshToken)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 401]);

    const winner = results.find((r) => r.status === 200)!;
    const won = (await json(winner))["data"] as unknown as TokenPair;
    // A double-submit logs the user out: clients must refresh single-flight.
    await expectError(await refresh(server, won.refreshToken), 401, "UNAUTHENTICATED");
  });
});

// ===========================================================================
// POST /auth/logout
// ===========================================================================

describe("POST /auth/logout", () => {
  const h = createTestHarness();
  let server: TestServer;
  let user: User;

  before(async () => {
    server = await startTestApp(h);
  });
  after(async () => {
    await server.close();
  });
  beforeEach(async () => {
    h.reset();
    user = await seedUser(h);
  });

  it("revokes the current session; its access and refresh tokens die immediately", async () => {
    const pair = await loginOk(server, user.email);
    const res = await logout(server, pair.accessToken);
    const body = await json(res);
    assert.equal(res.status, 200);
    assert.deepEqual(body, { success: true, message: "Logged out" });

    await expectError(await me(server, pair.accessToken), 401, "UNAUTHENTICATED");
    await expectError(await refresh(server, pair.refreshToken), 401, "UNAUTHENTICATED");
  });

  it("revokes only the current session", async () => {
    const a = await loginOk(server, user.email);
    const b = await loginOk(server, user.email);
    assert.equal((await logout(server, a.accessToken)).status, 200);
    assert.equal((await me(server, b.accessToken)).status, 200);
  });

  it("repeating logout with the revoked token is safe: 401, no side effects", async () => {
    const pair = await loginOk(server, user.email);
    const other = await loginOk(server, user.email);
    assert.equal((await logout(server, pair.accessToken)).status, 200);
    await expectError(await logout(server, pair.accessToken), 401, "UNAUTHENTICATED");
    assert.equal((await me(server, other.accessToken)).status, 200, "other sessions untouched");
  });

  it("succeeds when the session is already gone by the time it is revoked (race)", async () => {
    const pair = await loginOk(server, user.email);
    const racing = withOverrides<SessionRepository>(h.sessions, {
      revokeSession: () => {
        throw new RecordNotFoundError("session", pair.sessionId);
      },
    });
    const racingServer = await startTestApp(h, { sessions: racing });
    try {
      const res = await logout(racingServer, pair.accessToken);
      assert.equal(res.status, 200);
      assert.equal((await json(res))["message"], "Logged out");
    } finally {
      await racingServer.close();
    }
  });

  it("503 SERVICE_UNAVAILABLE when the session cannot be revoked", async () => {
    const pair = await loginOk(server, user.email);
    const broken = withOverrides<SessionRepository>(h.sessions, {
      revokeSession: () => {
        throw new Error("deadlock victim");
      },
    });
    const brokenServer = await startTestApp(h, { sessions: broken });
    try {
      const body = await expectError(await logout(brokenServer, pair.accessToken), 503, "SERVICE_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(body), /deadlock/);
    } finally {
      await brokenServer.close();
    }
  });

  it("503 when no session adapter is registered (authenticate cannot run)", async () => {
    const { token } = issueAccessToken({ userId: user.id, role: "admin", sessionId: "s-1" });
    const bare = await startServer(createApp({ container: createContainer({ users: () => h.users }) }));
    try {
      await expectError(await logout(bare, token), 503, "SERVICE_UNAVAILABLE");
    } finally {
      await bare.close();
    }
  });

  it("401 without a token", async () => {
    await expectError(await server.post("/api/v1/auth/logout"), 401, "UNAUTHENTICATED");
  });
});

// ===========================================================================
// GET /auth/me
// ===========================================================================

describe("GET /auth/me", () => {
  const h = createTestHarness();
  let server: TestServer;
  let user: User;

  before(async () => {
    server = await startTestApp(h);
  });
  after(async () => {
    await server.close();
  });
  beforeEach(async () => {
    h.reset();
    user = await seedUser(h, { avatarUrl: "https://cdn.test.local/a.png" });
  });

  it("returns exactly the base User", async () => {
    const pair = await loginOk(server, user.email);
    const res = await me(server, pair.accessToken);
    const body = await json(res);
    assert.equal(res.status, 200);
    const data = body["data"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), [...BASE_USER_KEYS, "avatarUrl"].sort());
    assert.equal(data["id"], user.id);
    assert.equal(data["role"], "admin");
  });

  it("never exposes credential, lockout or token fields", async () => {
    const pair = await loginOk(server, user.email);
    const leaky = withOverrides<UserRepository>(h.users, {
      findById: async () =>
        ({ ...user, passwordHash: "$argon2id$x", failedLoginAttempts: 2, lockedUntil: "x", refreshTokenHash: "y" }) as unknown as User,
    });
    const leakyServer = await startTestApp(h, { users: leaky });
    try {
      const text = await (await me(leakyServer, pair.accessToken)).text();
      assert.doesNotMatch(text, /passwordHash|failedLoginAttempts|lockedUntil|refreshTokenHash|argon2/);
    } finally {
      await leakyServer.close();
    }
  });

  it("401 UNAUTHENTICATED when the user no longer exists", async () => {
    const session = await h.sessions.create({
      userId: "ghost",
      refreshTokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { token } = issueAccessToken({ userId: "ghost", role: "admin", sessionId: session.sessionId });
    await expectError(await me(server, token), 401, "UNAUTHENTICATED");
  });

  for (const [status, code] of [
    ["pending", "ACCOUNT_PENDING"],
    ["suspended", "ACCOUNT_SUSPENDED"],
    ["deactivated", "ACCOUNT_DEACTIVATED"],
  ] as const) {
    it(`403 ${code} when the account became ${status} after login`, async () => {
      const pair = await loginOk(server, user.email);
      await h.users.setStatus(user.id, status);
      await expectError(await me(server, pair.accessToken), 403, code);
    });
  }

  it("401 UNAUTHENTICATED without a token, TOKEN_EXPIRED for an expired one", async () => {
    await expectError(await me(server), 401, "UNAUTHENTICATED");

    const pair = await loginOk(server, user.email);
    const expired = jwt.sign({ role: "admin", sid: pair.sessionId }, env.JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      subject: user.id,
      expiresIn: -120,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    await expectError(await me(server, expired), 401, "TOKEN_EXPIRED");
    await expectError(await me(server, `${pair.accessToken}tampered`), 401, "UNAUTHENTICATED");
  });

  it("503 with a safe message when the user lookup fails", async () => {
    const pair = await loginOk(server, user.email);
    const broken = withOverrides<UserRepository>(h.users, {
      findById: () => {
        throw new Error("timeout contacting sql-server-01");
      },
    });
    const brokenServer = await startTestApp(h, { users: broken });
    try {
      const body = await expectError(await me(brokenServer, pair.accessToken), 503, "SERVICE_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(body), /sql-server|timeout/);
    } finally {
      await brokenServer.close();
    }
  });
});

// ===========================================================================
// Shared authenticate across protected modules (real application)
// ===========================================================================

describe("protected modules share the same authenticate", () => {
  const h = createTestHarness();
  let server: TestServer;

  before(async () => {
    server = await startServer(createApp({ container: h.container }));
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => h.reset());

  /** A real session + access token for a role, as the other route tests do. */
  const tokenFor = async (role: UserRole): Promise<string> => {
    const session = await h.sessions.create({
      userId: `user-${role}`,
      refreshTokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return issueAccessToken({ userId: `user-${role}`, role, sessionId: session.sessionId }).token;
  };

  it("/students: 401 without a token, 403 for non-admins, 200 for admin and super_admin", async () => {
    await expectError(await server.get("/api/v1/students"), 401, "UNAUTHENTICATED");
    for (const role of ["student", "teacher"] as const) {
      await expectError(await server.get("/api/v1/students", bearer(await tokenFor(role))), 403, "INSUFFICIENT_ROLE");
    }
    for (const role of ["admin", "super_admin"] as const) {
      assert.equal((await server.get("/api/v1/students", bearer(await tokenFor(role)))).status, 200, role);
    }
  });

  it("/students: a revoked session is rejected", async () => {
    const session = await h.sessions.create({
      userId: "user-admin",
      refreshTokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { token } = issueAccessToken({ userId: "user-admin", role: "admin", sessionId: session.sessionId });
    await h.sessions.revokeSession({ sessionId: session.sessionId, userId: "user-admin", reason: "logout" });
    await expectError(await server.get("/api/v1/students", bearer(token)), 401, "UNAUTHENTICATED");
  });

  it("/courses management keeps admin-only access; the public catalogue stays anonymous", async () => {
    assert.equal((await server.get("/api/v1/courses")).status, 200);
    await expectError(await server.get("/api/v1/courses/manage"), 401, "UNAUTHENTICATED");
    await expectError(await server.get("/api/v1/courses/manage", bearer(await tokenFor("teacher"))), 403, "INSUFFICIENT_ROLE");
    assert.equal((await server.get("/api/v1/courses/manage", bearer(await tokenFor("admin")))).status, 200);
  });

  it("/teachers keeps admin-only access", async () => {
    await expectError(await server.get("/api/v1/teachers"), 401, "UNAUTHENTICATED");
    await expectError(await server.get("/api/v1/teachers", bearer(await tokenFor("student"))), 403, "INSUFFICIENT_ROLE");
    assert.equal((await server.get("/api/v1/teachers", bearer(await tokenFor("super_admin")))).status, 200);
  });
});

// ===========================================================================
// End-to-end over the real application and in-memory fakes
// ===========================================================================

describe("end-to-end: login -> protected course routes -> refresh -> logout", () => {
  it("runs the whole session lifecycle", async () => {
    const h = createTestHarness();
    const server = await startServer(createApp({ container: h.container }));
    try {
      const admin = await seedUser(h, { id: "user-admin", email: "admin@test.local", mobile: "9123456780", role: "admin" });

      // 1. login
      const first = await loginOk(server, admin.email);

      // 2. protected course management with the issued token
      assert.equal((await server.get("/api/v1/courses/manage", bearer(first.accessToken))).status, 200);
      const created = await send(
        server,
        "POST",
        "/api/v1/courses",
        {
          slug: "e2e-course",
          title: "E2E Course",
          shortDescription: "Short",
          longDescription: "Long",
          thumbnailUrl: "https://cdn.test.local/c.png",
          durationWeeks: 4,
          totalHours: 40,
          feeINR: 1000,
          level: "Beginner",
          category: "Testing",
          technologies: ["TS"],
          hasPlacementGuarantee: false,
          prerequisites: ["None"],
          learningOutcomes: ["Ship"],
        },
        first.accessToken,
      );
      assert.equal(created.status, 201);
      const courseId = ((await json(created))["data"] as Record<string, unknown>)["id"] as string;

      // 3. refresh, then use the new access token
      const refreshed = await refresh(server, first.refreshToken);
      assert.equal(refreshed.status, 200);
      const second = (await json(refreshed))["data"] as unknown as TokenPair;
      const published = await send(
        server,
        "PATCH",
        `/api/v1/courses/${encodeURIComponent(courseId)}/status`,
        { status: "Published" },
        second.accessToken,
      );
      assert.equal(published.status, 200);
      assert.equal((await me(server, second.accessToken)).status, 200);

      // 4. logout
      assert.equal((await logout(server, second.accessToken)).status, 200);

      // 5. revoked access and refresh are rejected everywhere
      await expectError(await server.get("/api/v1/courses/manage", bearer(second.accessToken)), 401, "UNAUTHENTICATED");
      await expectError(await me(server, second.accessToken), 401, "UNAUTHENTICATED");
      await expectError(await refresh(server, second.refreshToken), 401, "UNAUTHENTICATED");
      // The public catalogue still works and now lists the published course.
      const catalogue = await json(await server.get("/api/v1/courses"));
      const items = (catalogue["data"] as { items: { slug: string }[] }).items;
      assert.deepEqual(items.map((c) => c.slug), ["e2e-course"]);
    } finally {
      await server.close();
    }
  });
});
