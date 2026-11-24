import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sql from "mssql";

import { SqlServerUserRepository } from "../src/modules/users/sqlserver-user.repository";
import { SqlServerCredentialRepository } from "../src/modules/auth/sqlserver-credential.repository";
import { SqlServerSessionRepository } from "../src/modules/auth/sqlserver-session.repository";
import { SqlServerOtpChallengeRepository } from "../src/modules/auth/sqlserver-otp.repository";
import {
  SqlServerStudentRegistrationRepository,
  SqlRepositoryError,
} from "../src/modules/auth/sqlserver-registration.repository";
import {
  RegistrationRejectedError,
  type StudentRegistrationInput,
} from "../src/modules/auth/registration.repository";
import { DuplicateRecordError, RecordNotFoundError } from "../src/repositories/repository.errors";

// Mock SQL Request and ConnectionPool
class MockSqlRequest {
  public inputs: Record<string, unknown> = {};
  public handler: (query: string, inputs: Record<string, unknown>) => unknown;

  constructor(handler: (query: string, inputs: Record<string, unknown>) => unknown) {
    this.handler = handler;
  }

  input(name: string, _typeOrValue: unknown, value?: unknown): this {
    this.inputs[name] = value !== undefined ? value : _typeOrValue;
    return this;
  }

  async query<T = unknown>(command: string): Promise<{ recordset: T[]; rowsAffected: number[] }> {
    const res = this.handler(command, this.inputs);
    if (res instanceof Error) {
      throw res;
    }
    const r = (res ?? {}) as { recordset?: T[]; rowsAffected?: number[] };
    return {
      recordset: r.recordset ?? [],
      rowsAffected: r.rowsAffected ?? [1],
    };
  }
}

const createMockPool = (handler: (query: string, inputs: Record<string, unknown>) => unknown): sql.ConnectionPool => {
  return {
    request: () => new MockSqlRequest(handler),
  } as unknown as sql.ConnectionPool;
};

describe("SqlServerUserRepository (unit with mock pool)", () => {
  it("maps database row to User entity correctly in findById", async () => {
    const mockRow = {
      UserId: 101,
      PublicUserId: "00000000-0000-0000-0000-000000000101",
      FullName: "Aarav Sharma",
      Email: "aarav@nexelvoria.in",
      NormalizedEmail: "aarav@nexelvoria.in",
      MobileNumber: "9876543210",
      NormalizedMobile: "+919876543210",
      AccountStatus: "active",
      RoleCode: "student",
      CreatedAt: new Date("2026-01-15T10:00:00Z"),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerUserRepository(pool);

    const user = await repo.findById("101");
    assert.ok(user !== null);
    assert.equal(user.id, "101");
    assert.equal(user.name, "Aarav Sharma");
    assert.equal(user.email, "aarav@nexelvoria.in");
    assert.equal(user.mobile, "9876543210");
    assert.equal(user.role, "student");
    assert.equal(user.status, "active");
  });

  it("throws RecordNotFoundError on update when user does not exist", async () => {
    const pool = createMockPool(() => ({ recordset: [] }));
    const repo = new SqlServerUserRepository(pool);

    await assert.rejects(
      () => repo.update("999", { name: "NonExistent" }),
      (err: unknown) => {
        assert.ok(err instanceof RecordNotFoundError);
        return true;
      },
    );
  });

  it("finds user by email case-insensitively", async () => {
    const mockRow = {
      UserId: 102,
      PublicUserId: "00000000-0000-0000-0000-000000000102",
      FullName: "Pooja Reddy",
      Email: "Pooja@Nexelvoria.in",
      NormalizedEmail: "pooja@nexelvoria.in",
      MobileNumber: "9876543211",
      NormalizedMobile: "+919876543211",
      AccountStatus: "active",
      RoleCode: "teacher",
      CreatedAt: new Date("2026-01-15T10:00:00Z"),
    };

    let capturedInputs: Record<string, unknown> = {};
    const pool = createMockPool((_q, inputs) => {
      capturedInputs = inputs;
      return { recordset: [mockRow] };
    });
    const repo = new SqlServerUserRepository(pool);

    const user = await repo.findByEmail("POOJA@NEXELVORIA.IN");
    assert.ok(user !== null);
    assert.equal(user.role, "teacher");
    assert.equal(capturedInputs["normalizedEmail"], "pooja@nexelvoria.in");
  });

  it("maps duplicate key violations (2627) to DuplicateRecordError", async () => {
    const duplicateErr = new Error("Violation of UNIQUE KEY constraint UX_NXA_Users_NormalizedEmail");
    (duplicateErr as { number?: number }).number = 2627;

    const pool = createMockPool(() => duplicateErr);
    const repo = new SqlServerUserRepository(pool);

    await assert.rejects(
      () =>
        repo.create({
          name: "Test",
          email: "taken@nexelvoria.in",
          mobile: "9999999999",
          role: "student",
          status: "pending",
        }),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateRecordError);
        assert.equal(err.field, "email");
        return true;
      },
    );
  });
});

describe("SqlServerCredentialRepository (unit with mock pool)", () => {
  it("findByUserId maps password hash and attempt counts", async () => {
    const mockRow = {
      UserId: 201,
      PasswordHash: "$argon2id$v=19$m=47104,t=2,p=1$mockHash",
      FailedLoginAttempts: 2,
      IsLocked: false,
      LockoutUntil: null,
      UpdatedAt: new Date("2026-02-01T10:00:00Z"),
      CreatedAt: new Date("2026-01-01T10:00:00Z"),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerCredentialRepository(pool);

    const cred = await repo.findByUserId("201");
    assert.ok(cred !== null);
    assert.equal(cred.userId, "201");
    assert.equal(cred.failedLoginAttempts, 2);
    assert.equal(cred.passwordHash, "$argon2id$v=19$m=47104,t=2,p=1$mockHash");
  });

  it("recordFailedAttempt atomically returns updated lockout state", async () => {
    const pool = createMockPool(() => ({
      recordset: [
        {
          FailedLoginAttempts: 5,
          IsLocked: true,
          LockoutUntil: null,
        },
      ],
    }));
    const repo = new SqlServerCredentialRepository(pool);

    const state = await repo.recordFailedAttempt({ userId: "201", threshold: 5 });
    assert.equal(state.failedLoginAttempts, 5);
    assert.equal(state.isLocked, true);
    assert.equal(state.remainingAttempts, 0);
  });

  it("resetFailedAttemptsIfAuthorized returns reset when guard succeeds", async () => {
    const mockRow = {
      UserId: 201,
      PasswordHash: "$argon2id$v=19$m=47104,t=2,p=1$currentHash",
      FailedLoginAttempts: 0,
      IsLocked: false,
      LockoutUntil: null,
      UpdatedAt: new Date(),
      CreatedAt: new Date(),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerCredentialRepository(pool);

    const result = await repo.resetFailedAttemptsIfAuthorized({
      userId: "201",
      threshold: 5,
      acceptableHashes: ["$argon2id$v=19$m=47104,t=2,p=1$currentHash"],
    });

    assert.equal(result.status, "reset");
  });

  it("clearLockout resets counter and lockout status", async () => {
    const mockRow = {
      UserId: 201,
      PasswordHash: "hash",
      FailedLoginAttempts: 0,
      IsLocked: false,
      LockoutUntil: null,
      UpdatedAt: new Date(),
      CreatedAt: new Date(),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerCredentialRepository(pool);

    const cred = await repo.clearLockout("201");
    assert.equal(cred.failedLoginAttempts, 0);
  });
});

describe("SqlServerSessionRepository (unit with mock pool)", () => {
  it("create inserts session and returns mapped entity", async () => {
    const mockRow = {
      UserSessionId: 501,
      UserId: 101,
      RefreshTokenHash: Buffer.from("abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234", "hex"),
      ExpiresAt: new Date(Date.now() + 86400000),
      RevokedAt: null,
      IpAddress: "127.0.0.1",
      UserAgent: "Mozilla/5.0",
      DeviceInfo: "Windows",
      CreatedAt: new Date(),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerSessionRepository(pool);

    const session = await repo.create({
      userId: "101",
      refreshTokenHash: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    assert.equal(session.sessionId, "501");
    assert.equal(session.userId, "101");
    assert.equal(session.refreshTokenHash, "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234");
  });

  it("findBySessionId returns null when session does not exist", async () => {
    const pool = createMockPool(() => ({ recordset: [] }));
    const repo = new SqlServerSessionRepository(pool);

    const session = await repo.findBySessionId("9999");
    assert.equal(session, null);
  });

  it("revokeSession revokes matching session", async () => {
    const mockRow = {
      UserSessionId: 501,
      UserId: 101,
      RefreshTokenHash: Buffer.from("abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234", "hex"),
      ExpiresAt: new Date(Date.now() + 86400000),
      RevokedAt: new Date(),
      IpAddress: "127.0.0.1",
      UserAgent: "Mozilla/5.0",
      DeviceInfo: "Windows",
      CreatedAt: new Date(),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerSessionRepository(pool);

    const revoked = await repo.revokeSession({
      sessionId: "501",
      userId: "101",
      reason: "logout",
    });

    assert.equal(revoked.sessionId, "501");
    assert.ok(revoked.revokedAt !== undefined);
  });
});

describe("SqlServerOtpChallengeRepository (unit with mock pool)", () => {
  it("create inserts OTP challenge and returns mapped entity", async () => {
    const mockRow = {
      OtpRecordId: 301,
      UserId: 101,
      OtpPurpose: "email_verification",
      OtpHash: Buffer.from("11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff", "hex"),
      Destination: "student@nexelvoria.in",
      AttemptCount: 0,
      ExpiresAt: new Date(Date.now() + 600000),
      VerifiedAt: null,
      CreatedAt: new Date(),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const challenge = await repo.create({
      userId: "101",
      purpose: "email_verification",
      codeHash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      destination: "student@nexelvoria.in",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    assert.equal(challenge.id, "301");
    assert.equal(challenge.userId, "101");
    assert.equal(challenge.purpose, "email_verification");
    assert.equal(challenge.destination, "student@nexelvoria.in");
    assert.equal(challenge.attempts, 0);
  });

  it("findActiveByUser returns latest unverified challenge", async () => {
    const mockRow = {
      OtpRecordId: 302,
      UserId: 101,
      OtpPurpose: "email_verification",
      OtpHash: Buffer.from("deadbeef", "hex"),
      Destination: "student@nexelvoria.in",
      AttemptCount: 1,
      ExpiresAt: new Date(Date.now() + 300000),
      VerifiedAt: null,
      CreatedAt: new Date(),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const active = await repo.findActiveByUser("101", "email_verification");
    assert.ok(active !== null);
    assert.equal(active.id, "302");
    assert.equal(active.attempts, 1);
  });

  it("findActiveByUser returns null when no unverified challenge exists", async () => {
    const pool = createMockPool(() => ({ recordset: [] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const active = await repo.findActiveByUser("101", "email_verification");
    assert.equal(active, null);
  });

  it("incrementAttempts updates AttemptCount and returns updated challenge", async () => {
    const mockRow = {
      OtpRecordId: 302,
      UserId: 101,
      OtpPurpose: "email_verification",
      OtpHash: Buffer.from("deadbeef", "hex"),
      Destination: "student@nexelvoria.in",
      AttemptCount: 2,
      ExpiresAt: new Date(Date.now() + 300000),
      VerifiedAt: null,
      CreatedAt: new Date(),
    };

    const pool = createMockPool(() => ({ recordset: [mockRow] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const updated = await repo.incrementAttempts("302");
    assert.equal(updated.attempts, 2);
  });

  it("incrementAttempts throws RecordNotFoundError when record does not exist", async () => {
    const pool = createMockPool(() => ({ recordset: [] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    await assert.rejects(
      () => repo.incrementAttempts("999"),
      (err: unknown) => {
        assert.ok(err instanceof RecordNotFoundError);
        return true;
      },
    );
  });

  it("consume marks challenge verified and returns true if row updated", async () => {
    const pool = createMockPool(() => ({ rowsAffected: [1] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const consumed = await repo.consume("302", new Date().toISOString());
    assert.equal(consumed, true);
  });

  it("consume returns false if record was already verified or not found", async () => {
    const pool = createMockPool(() => ({ rowsAffected: [0] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const consumed = await repo.consume("302", new Date().toISOString());
    assert.equal(consumed, false);
  });

  it("countIssuedSince returns count of challenges in time window", async () => {
    const pool = createMockPool(() => ({ recordset: [{ total: 3 }] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const count = await repo.countIssuedSince("101", "email_verification", new Date(Date.now() - 3600000).toISOString());
    assert.equal(count, 3);
  });

  it("purgeExpiredBefore deletes expired records and returns count deleted", async () => {
    const pool = createMockPool(() => ({ rowsAffected: [5] }));
    const repo = new SqlServerOtpChallengeRepository(pool);

    const deleted = await repo.purgeExpiredBefore(new Date().toISOString());
    assert.equal(deleted, 5);
  });
});

class MockSqlTransaction {
  public began = false;
  public committed = false;
  public rolledBack = false;
  public queries: Array<{ sql: string; inputs: Record<string, unknown> }> = [];
  public handler: (query: string, inputs: Record<string, unknown>) => unknown;

  constructor(handler: (query: string, inputs: Record<string, unknown>) => unknown) {
    this.handler = handler;
  }

  async begin(): Promise<void> {
    this.began = true;
  }

  async commit(): Promise<void> {
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }

  request(): MockSqlRequest {
    return new MockSqlRequest((query, inputs) => {
      this.queries.push({ sql: query, inputs });
      return this.handler(query, inputs);
    });
  }
}

describe("SqlServerStudentRegistrationRepository (unit with mock transaction)", () => {
  const baseInput: StudentRegistrationInput = {
    name: "Rohan Kumar",
    email: "rohan@example.com",
    mobile: "9876543210",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$somehash",
    profile: {
      courseInterestedIn: "Full Stack Web Development",
      collegeName: "IIT Delhi",
      degreeBranch: "BTech Computer Science",
      passingYear: "2026",
      dateOfBirth: "2004-05-15",
      gender: "male",
      fullAddress: "Hostel 4, IIT Delhi, Hauz Khas",
      guardianContact: "9876500000",
      resumeFileName: "resume.pdf",
      linkedInUrl: "https://linkedin.com/in/rohan",
      githubUrl: "https://github.com/rohan",
    },
  };

  it("fails fast with plain Error if mandatory field is missing", async () => {
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool);

    await assert.rejects(
      () => repo.register({ ...baseInput, name: "   " }),
      /mandatory/,
    );
  });

  it("throws RegistrationRejectedError if email format is invalid", async () => {
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool);

    await assert.rejects(
      () => repo.register({ ...baseInput, email: "invalid-email" }),
      (err: unknown) => {
        assert.ok(err instanceof RegistrationRejectedError);
        assert.equal((err as RegistrationRejectedError).reasonCode, "INVALID_EMAIL");
        return true;
      },
    );
  });

  it("throws RegistrationRejectedError if mobile is invalid", async () => {
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool);

    await assert.rejects(
      () => repo.register({ ...baseInput, mobile: "abc" }),
      (err: unknown) => {
        assert.ok(err instanceof RegistrationRejectedError);
        assert.equal((err as RegistrationRejectedError).reasonCode, "INVALID_MOBILE");
        return true;
      },
    );
  });

  it("detects existing email during lock check and rolls back", async () => {
    let mockTx: MockSqlTransaction | undefined;
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool, {
      transactionFactory: () => {
        mockTx = new MockSqlTransaction((q) => {
          if (q.includes("dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")) {
            return {
              recordset: [{
                NormalizedEmail: "rohan@example.com",
                NormalizedMobile: "+911111111111",
              }],
            };
          }
          return {};
        });
        return mockTx as unknown as sql.Transaction;
      },
    });

    await assert.rejects(
      () => repo.register(baseInput),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateRecordError);
        assert.equal((err as DuplicateRecordError).field, "email");
        return true;
      },
    );

    assert.ok(mockTx?.began);
    assert.ok(mockTx?.rolledBack);
    assert.equal(mockTx?.committed, false);
  });

  it("detects existing mobile during lock check and rolls back", async () => {
    let mockTx: MockSqlTransaction | undefined;
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool, {
      transactionFactory: () => {
        mockTx = new MockSqlTransaction((q) => {
          if (q.includes("dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")) {
            return {
              recordset: [{
                NormalizedEmail: "other@example.com",
                NormalizedMobile: "+919876543210",
              }],
            };
          }
          return {};
        });
        return mockTx as unknown as sql.Transaction;
      },
    });

    await assert.rejects(
      () => repo.register(baseInput),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateRecordError);
        assert.equal((err as DuplicateRecordError).field, "mobile");
        return true;
      },
    );

    assert.ok(mockTx?.began);
    assert.ok(mockTx?.rolledBack);
    assert.equal(mockTx?.committed, false);
  });

  it("rolls back and throws SqlRepositoryError if student role is not found in dbo.NXA_Roles", async () => {
    let mockTx: MockSqlTransaction | undefined;
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool, {
      transactionFactory: () => {
        mockTx = new MockSqlTransaction((q) => {
          if (q.includes("dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")) {
            return { recordset: [] };
          }
          if (q.includes("INSERT INTO dbo.NXA_Users")) {
            return { recordset: [{ UserId: 501, PublicUserId: "uuid-501" }] };
          }
          if (q.includes("INSERT INTO dbo.NXA_StudentProfiles")) {
            return { recordset: [{ StudentProfileId: 601 }] };
          }
          if (q.includes("FROM dbo.NXA_Roles WHERE RoleCode = @roleCode")) {
            return { recordset: [] }; // Missing role!
          }
          return {};
        });
        return mockTx as unknown as sql.Transaction;
      },
    });

    await assert.rejects(
      () => repo.register(baseInput),
      (err: unknown) => {
        assert.ok(err instanceof SqlRepositoryError);
        assert.equal((err as SqlRepositoryError).entity, "role");
        assert.equal((err as SqlRepositoryError).operation, "lookup");
        return true;
      },
    );

    assert.ok(mockTx?.began);
    assert.ok(mockTx?.rolledBack);
    assert.equal(mockTx?.committed, false);
  });

  it("successfully completes registration transaction and commits", async () => {
    let mockTx: MockSqlTransaction | undefined;
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool, {
      transactionFactory: () => {
        mockTx = new MockSqlTransaction((q) => {
          if (q.includes("dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")) {
            return { recordset: [] };
          }
          if (q.includes("INSERT INTO dbo.NXA_Users")) {
            return { recordset: [{ UserId: 501, PublicUserId: "public-uuid-501" }] };
          }
          if (q.includes("INSERT INTO dbo.NXA_StudentProfiles")) {
            return { recordset: [{ StudentProfileId: 601 }] };
          }
          if (q.includes("FROM dbo.NXA_Roles WHERE RoleCode = @roleCode")) {
            return { recordset: [{ RoleId: 2 }] };
          }
          if (q.includes("INSERT INTO dbo.NXA_UserRoles")) {
            return { rowsAffected: [1] };
          }
          return {};
        });
        return mockTx as unknown as sql.Transaction;
      },
    });

    const result = await repo.register(baseInput);

    assert.ok(mockTx?.began);
    assert.ok(mockTx?.committed);
    assert.equal(mockTx?.rolledBack, false);

    assert.equal(result.userId, "501");
    assert.equal(result.studentProfileId, "601");
    assert.equal(result.email, "rohan@example.com");
    assert.equal(result.mobileNumber, "9876543210");
    assert.equal(result.status, "pending");
    assert.equal(result.adminApprovalStatus, "pending");
    assert.equal(result.isEmailVerified, false);
    assert.equal(result.isMobileVerified, false);
    assert.equal(result.referenceId, "public-uuid-501");
  });

  it("maps SQL 2627 constraint error on email to DuplicateRecordError and rolls back", async () => {
    let mockTx: MockSqlTransaction | undefined;
    const pool = createMockPool(() => ({}));
    const repo = new SqlServerStudentRegistrationRepository(pool, {
      transactionFactory: () => {
        mockTx = new MockSqlTransaction((q) => {
          if (q.includes("dbo.NXA_Users WITH (UPDLOCK, HOLDLOCK)")) {
            return { recordset: [] };
          }
          if (q.includes("INSERT INTO dbo.NXA_Users")) {
            const err = new Error("Violation of UNIQUE KEY constraint 'UQ_NXA_Users_NormalizedEmail'.");
            (err as unknown as { number: number }).number = 2627;
            return err;
          }
          return {};
        });
        return mockTx as unknown as sql.Transaction;
      },
    });

    await assert.rejects(
      () => repo.register(baseInput),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateRecordError);
        assert.equal((err as DuplicateRecordError).field, "email");
        return true;
      },
    );

    assert.ok(mockTx?.began);
    assert.ok(mockTx?.rolledBack);
    assert.equal(mockTx?.committed, false);
  });
});
