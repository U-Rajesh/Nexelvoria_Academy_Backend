import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LOGGING_DELIVERY_REFUSAL,
  createLoggingOtpDelivery,
  maskDestination,
  type OtpDeliveryPort,
  type OtpDeliveryRequest,
  type OtpDeliveryResult,
} from "../src/modules/auth/otp.delivery";
import {
  OTP_CODE_LENGTH,
  OTP_MAX_SENDS_PER_WINDOW,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_SEND_WINDOW_SECONDS,
  OTP_TTL_SECONDS,
  createOtpService,
  generateOtpCode,
  hashOtpCode,
  isWellFormedOtpCode,
  matchesOtpHash,
  type OtpService,
} from "../src/modules/auth/otp.service";
import { InMemoryOtpChallengeRepository } from "./fakes/in-memory-otp.repository";

const PROJECT_ROOT = path.resolve(__dirname, "..");

const USER = "user-1";
const EMAIL = "aarav.sharma@example.com";
const PURPOSE = "email_verification" as const;

/**
 * A delivery adapter that records what it was asked to send.
 *
 * Recording the plaintext is the only way a test can learn the code - the
 * service never returns it, and the stored challenge holds a hash. That is
 * the property under test, so the fake adapter is how a test gets in.
 */
class RecordingDelivery implements OtpDeliveryPort {
  readonly channel = "email" as const;
  readonly sent: OtpDeliveryRequest[] = [];

  /** Set to make the next sends fail, simulating a provider outage. */
  failWith: string | null = null;
  /** Set to make `send` throw rather than return a failure. */
  throwOnSend = false;

  async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
    if (this.throwOnSend) {
      throw new Error("provider exploded");
    }

    if (this.failWith !== null) {
      return { delivered: false, reason: this.failWith };
    }

    this.sent.push(request);

    return { delivered: true };
  }

  get lastCode(): string {
    const last = this.sent[this.sent.length - 1];
    assert.ok(last !== undefined, "no OTP was delivered");

    return last.code;
  }
}

/** A controllable clock, so nothing in this file sleeps. */
class TestClock {
  constructor(private current = new Date("2026-11-18T10:00:00.000Z")) {}

  now = (): Date => new Date(this.current);

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

describe("otp code generation", () => {
  it("produces exactly six digits", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateOtpCode();
      assert.equal(code.length, OTP_CODE_LENGTH);
      assert.match(code, /^\d{6}$/);
    }
  });

  it("keeps leading zeros, so the whole 10^6 space is reachable", () => {
    // Padding is what makes "000123" a valid code. Without it the space
    // shrinks and short codes could never be issued.
    const padded = String(7).padStart(OTP_CODE_LENGTH, "0");
    assert.equal(padded, "000007");
    assert.ok(isWellFormedOtpCode(padded));
  });

  it("does not repeat itself over many draws", () => {
    // Not a randomness proof - a guard against a constant or a counter.
    const codes = new Set<string>();

    for (let i = 0; i < 500; i += 1) {
      codes.add(generateOtpCode());
    }

    assert.ok(codes.size > 400, `expected varied codes, got ${codes.size} distinct`);
  });
});

describe("otp hashing", () => {
  it("never stores the code itself", () => {
    const hash = hashOtpCode("123456");

    assert.notEqual(hash, "123456");
    assert.ok(!hash.includes("123456"));
    // HMAC-SHA256 hex.
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same code", () => {
    assert.equal(hashOtpCode("424242"), hashOtpCode("424242"));
  });

  it("differs for different codes", () => {
    assert.notEqual(hashOtpCode("111111"), hashOtpCode("111112"));
  });

  it("matches the right code and rejects the wrong one", () => {
    const hash = hashOtpCode("654321");

    assert.ok(matchesOtpHash("654321", hash));
    assert.ok(!matchesOtpHash("654322", hash));
  });

  it("rejects rather than throws on a malformed stored hash", () => {
    // timingSafeEqual throws on length mismatch; the guard must absorb it
    // so a corrupt row fails the comparison instead of the request.
    assert.doesNotThrow(() => matchesOtpHash("123456", "short"));
    assert.equal(matchesOtpHash("123456", "short"), false);
    assert.equal(matchesOtpHash("123456", ""), false);
  });

  it("recognises only six-digit strings as well formed", () => {
    assert.ok(isWellFormedOtpCode("000000"));
    assert.ok(!isWellFormedOtpCode("12345"));
    assert.ok(!isWellFormedOtpCode("1234567"));
    assert.ok(!isWellFormedOtpCode("12345a"));
    assert.ok(!isWellFormedOtpCode(" 123456"));
    assert.ok(!isWellFormedOtpCode(123456));
    assert.ok(!isWellFormedOtpCode(null));
    assert.ok(!isWellFormedOtpCode(undefined));
  });
});

describe("maskDestination", () => {
  it("keeps the domain and reduces the local part", () => {
    assert.equal(maskDestination("aarav.sharma@example.com"), "a***a@example.com");
  });

  it("hides a short local part entirely", () => {
    assert.equal(maskDestination("ab@example.com"), "***@example.com");
  });

  it("reveals nothing for a non-address", () => {
    assert.equal(maskDestination("not-an-address"), "***");
    assert.equal(maskDestination("@example.com"), "***");
  });
});

describe("otp issue", () => {
  let repo: InMemoryOtpChallengeRepository;
  let delivery: RecordingDelivery;
  let clock: TestClock;
  let service: OtpService;

  beforeEach(() => {
    repo = new InMemoryOtpChallengeRepository();
    delivery = new RecordingDelivery();
    clock = new TestClock();
    service = createOtpService({ challenges: repo, delivery, now: clock.now });
  });

  it("issues a code and reports expiry and resend timing", async () => {
    const result = await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.equal(result.outcome, "success");
    assert.ok(result.outcome === "success");

    assert.equal(
      result.data.expiresAt,
      new Date(clock.now().getTime() + OTP_TTL_SECONDS * 1000).toISOString(),
    );
    assert.equal(
      result.data.resendAvailableAt,
      new Date(clock.now().getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString(),
    );
    assert.equal(result.data.maskedDestination, "a***a@example.com");
  });

  it("never returns the code to the caller", async () => {
    const result = await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.ok(result.outcome === "success");
    // The whole success payload, serialised, must not contain the code.
    assert.ok(!JSON.stringify(result).includes(delivery.lastCode));
  });

  it("stores only a hash, never the plaintext", async () => {
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    const [stored] = repo.all();
    assert.ok(stored !== undefined);

    assert.notEqual(stored.codeHash, delivery.lastCode);
    assert.equal(stored.codeHash, hashOtpCode(delivery.lastCode));
    assert.ok(!JSON.stringify(stored).includes(delivery.lastCode));
  });

  it("delivers to the requested destination with the real TTL", async () => {
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.equal(delivery.sent.length, 1);
    const [sent] = delivery.sent;
    assert.ok(sent !== undefined);
    assert.equal(sent.destination, EMAIL);
    assert.equal(sent.purpose, PURPOSE);
    assert.equal(sent.expiresInSeconds, OTP_TTL_SECONDS);
  });

  it("starts a challenge unconsumed with no attempts", async () => {
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    const [stored] = repo.all();
    assert.ok(stored !== undefined);
    assert.equal(stored.attempts, 0);
    assert.equal(stored.consumedAt, undefined);
  });

  it("refuses a resend inside the cooldown and says how long to wait", async () => {
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    clock.advanceSeconds(10);

    const result = await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "cooldown_active");
    assert.equal(result.retryAfterSeconds, OTP_RESEND_COOLDOWN_SECONDS - 10);
    assert.equal(repo.all().length, 1, "no second challenge may be stored");
    assert.equal(delivery.sent.length, 1, "nothing may be delivered");
  });

  it("allows a resend once the cooldown has passed", async () => {
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    clock.advanceSeconds(OTP_RESEND_COOLDOWN_SECONDS);

    const result = await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.equal(result.outcome, "success");
    assert.equal(repo.all().length, 2);
    assert.equal(delivery.sent.length, 2);
  });

  it("issues different codes on resend", async () => {
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });
    const first = delivery.lastCode;

    clock.advanceSeconds(OTP_RESEND_COOLDOWN_SECONDS);
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    // Not strictly guaranteed by randomness, but a service that reused the
    // code would fail this every time.
    assert.notEqual(delivery.lastCode, first);
  });

  it("enforces the per-window send allowance", async () => {
    for (let i = 0; i < OTP_MAX_SENDS_PER_WINDOW; i += 1) {
      const result = await service.issue({
        userId: USER,
        purpose: PURPOSE,
        destination: EMAIL,
      });

      assert.equal(result.outcome, "success", `send ${i + 1} should be allowed`);
      clock.advanceSeconds(OTP_RESEND_COOLDOWN_SECONDS);
    }

    const blocked = await service.issue({
      userId: USER,
      purpose: PURPOSE,
      destination: EMAIL,
    });

    assert.ok(blocked.outcome === "failure");
    assert.equal(blocked.reason, "send_limit_reached");
    assert.equal(repo.all().length, OTP_MAX_SENDS_PER_WINDOW);
  });

  it("lets the allowance recover once the window has rolled past", async () => {
    for (let i = 0; i < OTP_MAX_SENDS_PER_WINDOW; i += 1) {
      await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });
      clock.advanceSeconds(OTP_RESEND_COOLDOWN_SECONDS);
    }

    clock.advanceSeconds(OTP_SEND_WINDOW_SECONDS);

    const result = await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });
    assert.equal(result.outcome, "success");
  });

  it("counts the allowance per user, not globally", async () => {
    for (let i = 0; i < OTP_MAX_SENDS_PER_WINDOW; i += 1) {
      await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });
      clock.advanceSeconds(OTP_RESEND_COOLDOWN_SECONDS);
    }

    const other = await service.issue({
      userId: "user-2",
      purpose: PURPOSE,
      destination: "priya@example.com",
    });

    assert.equal(other.outcome, "success", "one user must not exhaust another's allowance");
  });

  it("reports delivery_failed and spends the challenge when the provider refuses", async () => {
    delivery.failWith = "smtp 554 rejected";

    const result = await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "delivery_failed");

    // The row exists but must be unusable: the student never got this code,
    // and leaving it live would occupy the single active slot.
    const [stored] = repo.all();
    assert.ok(stored !== undefined);
    assert.notEqual(stored.consumedAt, undefined);

    assert.equal(await repo.findActiveByUser(USER, PURPOSE), null);
  });

  it("treats an adapter that throws as a failed delivery, not a crash", async () => {
    delivery.throwOnSend = true;

    const result = await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "delivery_failed");
  });

  it("reports otp_unavailable when the challenge cannot be stored", async () => {
    const broken = createOtpService({
      challenges: {
        ...repo,
        create: () => Promise.reject(new Error("db down")),
        findLatestByUser: () => Promise.resolve(null),
        countIssuedSince: () => Promise.resolve(0),
      } as never,
      delivery,
      now: clock.now,
    });

    const result = await broken.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "otp_unavailable");
    assert.equal(delivery.sent.length, 0, "nothing may be sent if storing failed");
  });

  it("reports otp_unavailable when the cooldown lookup fails", async () => {
    const broken = createOtpService({
      challenges: {
        ...repo,
        findLatestByUser: () => Promise.reject(new Error("db down")),
      } as never,
      delivery,
      now: clock.now,
    });

    const result = await broken.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "otp_unavailable");
  });
});

describe("otp verification", () => {
  let repo: InMemoryOtpChallengeRepository;
  let delivery: RecordingDelivery;
  let clock: TestClock;
  let service: OtpService;

  beforeEach(async () => {
    repo = new InMemoryOtpChallengeRepository();
    delivery = new RecordingDelivery();
    clock = new TestClock();
    service = createOtpService({ challenges: repo, delivery, now: clock.now });

    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });
  });

  it("accepts the correct code", async () => {
    const result = await service.verify({
      userId: USER,
      purpose: PURPOSE,
      code: delivery.lastCode,
    });

    assert.equal(result.outcome, "success");
  });

  it("consumes the challenge on success", async () => {
    await service.verify({ userId: USER, purpose: PURPOSE, code: delivery.lastCode });

    const [stored] = repo.all();
    assert.ok(stored !== undefined);
    assert.notEqual(stored.consumedAt, undefined);
    assert.equal(await repo.findActiveByUser(USER, PURPOSE), null);
  });

  it("refuses the same code a second time (one-time use)", async () => {
    const code = delivery.lastCode;

    assert.equal((await service.verify({ userId: USER, purpose: PURPOSE, code })).outcome, "success");

    const replay = await service.verify({ userId: USER, purpose: PURPOSE, code });

    assert.ok(replay.outcome === "failure");
    assert.equal(replay.reason, "no_active_challenge");
  });

  it("rejects a wrong code and reports the attempts left", async () => {
    const wrong = delivery.lastCode === "000000" ? "111111" : "000000";

    const result = await service.verify({ userId: USER, purpose: PURPOSE, code: wrong });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "invalid_code");
    assert.equal(result.attemptsRemaining, OTP_MAX_VERIFY_ATTEMPTS - 1);
  });

  it("does not consume the challenge on a wrong code", async () => {
    await service.verify({ userId: USER, purpose: PURPOSE, code: "000000" });

    const active = await repo.findActiveByUser(USER, PURPOSE);
    assert.ok(active !== null, "a wrong guess must not spend the challenge");
  });

  it("still accepts the right code after a wrong one", async () => {
    const code = delivery.lastCode;
    const wrong = code === "000000" ? "111111" : "000000";

    await service.verify({ userId: USER, purpose: PURPOSE, code: wrong });

    const result = await service.verify({ userId: USER, purpose: PURPOSE, code });
    assert.equal(result.outcome, "success");
  });

  it("counts a malformed code as an attempt", async () => {
    // Deliberate: a free rejection would let an attacker probe without
    // spending the allowance that makes a six-digit code safe.
    const result = await service.verify({ userId: USER, purpose: PURPOSE, code: "abc" });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "invalid_code");
    assert.equal(result.attemptsRemaining, OTP_MAX_VERIFY_ATTEMPTS - 1);
  });

  it("rejects non-string codes without throwing", async () => {
    for (const code of [null, undefined, 123456, {}, []]) {
      const result = await service.verify({ userId: USER, purpose: PURPOSE, code });
      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "invalid_code");
    }
  });

  it("stops accepting guesses at the attempt ceiling", async () => {
    for (let i = 0; i < OTP_MAX_VERIFY_ATTEMPTS; i += 1) {
      const result = await service.verify({
        userId: USER,
        purpose: PURPOSE,
        code: "000000",
      });

      assert.ok(result.outcome === "failure");
      assert.equal(result.reason, "invalid_code");
      assert.equal(result.attemptsRemaining, OTP_MAX_VERIFY_ATTEMPTS - (i + 1));
    }

    const blocked = await service.verify({
      userId: USER,
      purpose: PURPOSE,
      code: "000000",
    });

    assert.ok(blocked.outcome === "failure");
    assert.equal(blocked.reason, "attempt_limit_reached");
  });

  it("refuses even the CORRECT code once the ceiling is reached", async () => {
    const code = delivery.lastCode;
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < OTP_MAX_VERIFY_ATTEMPTS; i += 1) {
      await service.verify({ userId: USER, purpose: PURPOSE, code: wrong });
    }

    const result = await service.verify({ userId: USER, purpose: PURPOSE, code });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "attempt_limit_reached");
  });

  it("rejects an expired code", async () => {
    clock.advanceSeconds(OTP_TTL_SECONDS + 1);

    const result = await service.verify({
      userId: USER,
      purpose: PURPOSE,
      code: delivery.lastCode,
    });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "expired");
  });

  it("rejects a code exactly at the expiry instant", async () => {
    clock.advanceSeconds(OTP_TTL_SECONDS);

    const result = await service.verify({
      userId: USER,
      purpose: PURPOSE,
      code: delivery.lastCode,
    });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "expired");
  });

  it("accepts a code just before expiry", async () => {
    clock.advanceSeconds(OTP_TTL_SECONDS - 1);

    const result = await service.verify({
      userId: USER,
      purpose: PURPOSE,
      code: delivery.lastCode,
    });

    assert.equal(result.outcome, "success");
  });

  it("distinguishes expired from absent", async () => {
    clock.advanceSeconds(OTP_TTL_SECONDS + 1);

    const expired = await service.verify({
      userId: USER,
      purpose: PURPOSE,
      code: delivery.lastCode,
    });
    assert.ok(expired.outcome === "failure");
    assert.equal(expired.reason, "expired");

    const absent = await service.verify({
      userId: "user-nobody",
      purpose: PURPOSE,
      code: "123456",
    });
    assert.ok(absent.outcome === "failure");
    assert.equal(absent.reason, "no_active_challenge");
  });

  it("will not verify another user's code", async () => {
    const result = await service.verify({
      userId: "user-2",
      purpose: PURPOSE,
      code: delivery.lastCode,
    });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "no_active_challenge");

    // And the victim's challenge is untouched.
    const active = await repo.findActiveByUser(USER, PURPOSE);
    assert.ok(active !== null);
    assert.equal(active.attempts, 0);
  });

  it("verifies against the newest challenge after a resend", async () => {
    const stale = delivery.lastCode;

    clock.advanceSeconds(OTP_RESEND_COOLDOWN_SECONDS);
    await service.issue({ userId: USER, purpose: PURPOSE, destination: EMAIL });
    const fresh = delivery.lastCode;

    const old = await service.verify({ userId: USER, purpose: PURPOSE, code: stale });
    assert.ok(old.outcome === "failure", "the superseded code must not work");

    const current = await service.verify({ userId: USER, purpose: PURPOSE, code: fresh });
    assert.equal(current.outcome, "success");
  });

  it("reports otp_unavailable when the challenge lookup fails", async () => {
    const broken = createOtpService({
      challenges: {
        ...repo,
        findActiveByUser: () => Promise.reject(new Error("db down")),
      } as never,
      delivery,
      now: clock.now,
    });

    const result = await broken.verify({ userId: USER, purpose: PURPOSE, code: "123456" });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "otp_unavailable");
  });

  it("does not report success when the conditional consume loses a race", async () => {
    // Simulates a concurrent request having consumed the challenge between
    // this one's read and its write. Reporting success here would make the
    // caller apply its side effect twice.
    const active = await repo.findActiveByUser(USER, PURPOSE);
    assert.ok(active !== null);

    const racing = createOtpService({
      challenges: {
        ...repo,
        findActiveByUser: () => Promise.resolve(active),
        consume: () => Promise.resolve(false),
      } as never,
      delivery,
      now: clock.now,
    });

    const result = await racing.verify({
      userId: USER,
      purpose: PURPOSE,
      code: delivery.lastCode,
    });

    assert.ok(result.outcome === "failure");
    assert.equal(result.reason, "invalid_code");
  });
});

describe("otp challenge repository contract", () => {
  let repo: InMemoryOtpChallengeRepository;

  beforeEach(() => {
    repo = new InMemoryOtpChallengeRepository();
  });

  it("increments attempts on the stored row", async () => {
    const created = await repo.create({
      userId: USER,
      purpose: PURPOSE,
      codeHash: hashOtpCode("123456"),
      destination: EMAIL,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    assert.equal((await repo.incrementAttempts(created.id)).attempts, 1);
    assert.equal((await repo.incrementAttempts(created.id)).attempts, 2);
  });

  it("consumes once and reports false on the second call", async () => {
    const created = await repo.create({
      userId: USER,
      purpose: PURPOSE,
      codeHash: hashOtpCode("123456"),
      destination: EMAIL,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    const when = new Date().toISOString();

    assert.equal(await repo.consume(created.id, when), true);
    assert.equal(await repo.consume(created.id, when), false);
  });

  it("isolates challenges by purpose", async () => {
    await repo.create({
      userId: USER,
      purpose: PURPOSE,
      codeHash: hashOtpCode("123456"),
      destination: EMAIL,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    // A second purpose is not in the union yet, so this asserts the KEYING
    // rather than a real alternative channel.
    assert.notEqual(await repo.findActiveByUser(USER, PURPOSE), null);
    assert.equal(await repo.findActiveByUser("user-other", PURPOSE), null);
  });

  it("purges only challenges that expired before the instant", async () => {
    const base = new Date("2026-11-18T10:00:00.000Z").getTime();

    repo.seed({
      userId: USER,
      purpose: PURPOSE,
      codeHash: "a",
      destination: EMAIL,
      expiresAt: new Date(base - 1000).toISOString(),
      attempts: 0,
      createdAt: new Date(base - 2000).toISOString(),
    });
    repo.seed({
      userId: USER,
      purpose: PURPOSE,
      codeHash: "b",
      destination: EMAIL,
      expiresAt: new Date(base + 60_000).toISOString(),
      attempts: 0,
      createdAt: new Date(base).toISOString(),
    });

    assert.equal(await repo.purgeExpiredBefore(new Date(base).toISOString()), 1);
    assert.equal(repo.all().length, 1);
  });
});

describe("otp delivery adapter", () => {
  it("reports delivery in development", async () => {
    const adapter = createLoggingOtpDelivery();

    assert.equal(adapter.channel, "email");
    assert.deepEqual(
      await adapter.send({
        destination: EMAIL,
        code: "123456",
        purpose: PURPOSE,
        expiresInSeconds: OTP_TTL_SECONDS,
      }),
      { delivered: true },
    );
  });

  it("refuses to be constructed in a production process", () => {
    // `isProduction` is evaluated when env.ts loads, so this must be a
    // separate process - the same approach the dev-harness isolation test
    // uses.
    const result = spawnSync(
      process.execPath,
      [
        path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        "--eval",
        'require("./src/modules/auth/otp.delivery").createLoggingOtpDelivery();',
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          NODE_ENV: "production",
          // Valid so env.ts does not reject the config first - the refusal
          // under test must be the adapter's, not a missing variable.
          JWT_SECRET: "throwaway-value-for-this-assertion-only-not-a-secret",
          CORS_ORIGINS: "http://localhost:5173",
        },
      },
    );

    assert.notEqual(result.status, 0, "constructing it in production must fail");

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.ok(
      output.includes(LOGGING_DELIVERY_REFUSAL.slice(0, 60)),
      `expected the refusal, got: ${output.slice(0, 400)}`,
    );
  });
});
