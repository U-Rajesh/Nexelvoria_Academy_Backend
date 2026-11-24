import type {
  AccountSecurityRepository,
  CreateResetGrantInput,
  LoginHistoryEntry,
  RecordLoginInput,
} from "../../src/modules/auth/account-security.repository";

/** Mirrors SqlServerAccountSecurityRepository (NXA_LoginHistory, NXA_PasswordResetTokens). */
export class InMemoryAccountSecurityRepository implements AccountSecurityRepository {
  logins: LoginHistoryEntry[] = [];
  grants: Array<{ id: string; userId: string; tokenHash: Buffer; expiresAt: Date; requestIp?: string | undefined; usedAt?: Date; createdAt: Date }> = [];
  /** Injected clock for expiry tests. */
  now: () => Date = () => new Date();
  private seq = 0;

  reset(): void {
    this.logins = [];
    this.grants = [];
    this.now = () => new Date();
  }

  async recordLogin(input: RecordLoginInput): Promise<void> {
    this.logins.push({
      id: String(++this.seq),
      userId: input.userId,
      loginIdentifier: input.loginIdentifier,
      isSuccessful: input.isSuccessful,
      failureReason: input.failureReason,
      ipAddress: input.ipAddress,
      deviceInfo: input.deviceInfo,
      loggedAt: this.now().toISOString(),
    });
  }

  async listLoginHistory(userId: string, limit: number): Promise<LoginHistoryEntry[]> {
    return this.logins.filter((l) => l.userId === userId).reverse().slice(0, limit);
  }

  async createResetGrant(input: CreateResetGrantInput): Promise<void> {
    this.grants.push({ id: String(++this.seq), ...input, createdAt: this.now() });
  }

  async consumeResetGrant(userId: string): Promise<boolean> {
    const live = this.grants
      .filter((g) => g.userId === userId && !g.usedAt && g.expiresAt > this.now())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || Number(b.id) - Number(a.id))[0];
    if (!live) return false;
    live.usedAt = this.now();
    return true;
  }
}
