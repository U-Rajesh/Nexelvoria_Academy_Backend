import type { DateRange, ReportsRepository } from "../../src/modules/reports/reports.repository";
import { MAX_EXPORT_ROWS, ReportTooLargeError, istDayStartUtc, monthsBetween } from "../../src/modules/reports/reports.rules";
import type {
  DashboardAnalytics,
  ExportRecord,
  FinancialSummary,
  ReportCode,
  ReportFilter,
  ReportPage,
  ReportResult,
  StatusLine,
} from "../../src/modules/reports/reports.types";

type Tabular = Exclude<ReportCode, "financial-summary">;

/** A stored report row: the visible columns plus what the filters work on. */
export interface FakeReportRow {
  /** ISO instant (date-time reports) or YYYY-MM-DD (expenses). */
  at: string;
  status?: string;
  search: string;
  data: Record<string, unknown>;
}

export interface FakeLedger {
  transactions: Array<{ status: string; amount: number; at: string }>;
  manual: Array<{ status: string; amount: number; at: string }>;
  refunds: Array<{ status: string; amount: number; requestedAt: string; approvedAt?: string; completedAt?: string }>;
  enrollments: Array<{ status: string; discount: number; at: string }>;
  coupons: Array<{ status: string; amount: number; at: string }>;
  awards: Array<{ status: string; amount: number; at: string }>;
  expenses: Array<{ category: string; currency: string; amount: number; date: string; approved: boolean }>;
  registrations: string[];
  attempts: Array<{ status: string; at: string }>;
  applications: Array<{ status: string; at: string }>;
  attendance: Array<{ batchCode: string; batchName: string; status: string; at: string }>;
  accounts: Array<{ role: string; status: string }>;
}

const emptyLedger = (): FakeLedger => ({
  transactions: [],
  manual: [],
  refunds: [],
  enrollments: [],
  coupons: [],
  awards: [],
  expenses: [],
  registrations: [],
  attempts: [],
  applications: [],
  attendance: [],
  accounts: [],
});

const IST_OFFSET_MS = 330 * 60 * 1000;
const istMonth = (iso: string) => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 7);

export class InMemoryReportsRepository implements ReportsRepository {
  rows: Partial<Record<Tabular, FakeReportRow[]>> = {};
  ledger: FakeLedger = emptyLedger();
  exports: ExportRecord[] = [];
  failExportAudit = false;
  /** Counts runReport calls, to prove exports and screens share one query path. */
  calls: Array<{ code: Tabular; filter: ReportFilter; page: ReportPage | null }> = [];

  reset(): void {
    this.rows = {};
    this.ledger = emptyLedger();
    this.exports = [];
    this.failExportAudit = false;
    this.calls = [];
  }

  private inRange(at: string, filter: { from?: string | undefined; to?: string | undefined }, dateOnly = false): boolean {
    if (dateOnly) return (!filter.from || at >= filter.from) && (!filter.to || at <= filter.to);
    const t = Date.parse(at);
    return (!filter.from || t >= istDayStartUtc(filter.from).getTime()) && (!filter.to || t < istDayStartUtc(filter.to, 1).getTime());
  }

  async runReport(code: Tabular, filter: ReportFilter, page: ReportPage | null): Promise<ReportResult> {
    this.calls.push({ code, filter, page });
    const all = (this.rows[code] ?? []).filter(
      (r) =>
        this.inRange(r.at, filter, code === "expenses") &&
        (!filter.status || (r.status ?? "").toLowerCase() === filter.status) &&
        (!filter.search || r.search.toLowerCase().includes(filter.search.toLowerCase())),
    );
    const sorted = [...all].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (!page && sorted.length > MAX_EXPORT_ROWS) throw new ReportTooLargeError(sorted.length);
    const slice = page ? sorted.slice((page.page - 1) * page.pageSize, page.page * page.pageSize) : sorted;
    return { rows: slice.map((r) => r.data), total: sorted.length };
  }

  async listStatuses(code: Tabular): Promise<string[]> {
    return [...new Set((this.rows[code] ?? []).map((r) => (r.status ?? "").toLowerCase()).filter(Boolean))].sort();
  }

  async financialSummary(range: DateRange): Promise<FinancialSummary> {
    const l = this.ledger;
    const r = (at?: string) => !!at && this.inRange(at, range);
    const group = (items: Array<{ status: string; amount: number }>): StatusLine[] => {
      const m = new Map<string, StatusLine>();
      for (const i of items) {
        const s = i.status.toLowerCase();
        const x = m.get(s) ?? { status: s, count: 0, amount: 0 };
        x.count++;
        x.amount += i.amount;
        m.set(s, x);
      }
      return [...m.values()];
    };
    const sum = (items: Array<{ amount: number }>) => ({ count: items.length, amount: items.reduce((a, b) => a + b.amount, 0) });
    const tx = group(l.transactions.filter((t) => r(t.at)));
    const man = group(l.manual.filter((t) => r(t.at)));
    const pick = (lines: StatusLine[], s: string) => {
      const x = lines.find((y) => y.status === s);
      return { count: x?.count ?? 0, amount: x?.amount ?? 0 };
    };
    const gs = pick(tx, "successful");
    const mv = pick(man, "verified");
    const requested = l.refunds.filter((x) => r(x.requestedAt));
    const expenses = l.expenses.filter((e) => this.inRange(e.date, range, true));
    const byCur = new Map<string, { currency: string; count: number; amount: number }>();
    const byCat = new Map<string, { category: string; currency: string; count: number; amount: number }>();
    for (const e of expenses) {
      const c = byCur.get(e.currency) ?? { currency: e.currency, count: 0, amount: 0 };
      c.count++;
      c.amount += e.amount;
      byCur.set(e.currency, c);
      const k = `${e.category}|${e.currency}`;
      const g = byCat.get(k) ?? { category: e.category, currency: e.currency, count: 0, amount: 0 };
      g.count++;
      g.amount += e.amount;
      byCat.set(k, g);
    }
    return {
      from: range.from,
      to: range.to,
      revenue: {
        gatewaySuccessful: gs,
        manualVerified: mv,
        totalCollected: gs.amount + mv.amount,
        gatewayNotCounted: tx.filter((x) => x.status !== "successful"),
        manualNotCounted: man.filter((x) => x.status !== "verified"),
      },
      refunds: {
        requested: sum(requested),
        pending: sum(requested.filter((x) => x.status.toUpperCase() === "PENDING")),
        approved: sum(l.refunds.filter((x) => r(x.approvedAt))),
        completed: sum(l.refunds.filter((x) => r(x.completedAt))),
      },
      discounts: {
        enrollmentDiscounts: {
          count: l.enrollments.filter((e) => e.discount > 0 && e.status.toUpperCase() !== "CANCELLED" && r(e.at)).length,
          amount: l.enrollments.filter((e) => e.discount > 0 && e.status.toUpperCase() !== "CANCELLED" && r(e.at)).reduce((a, b) => a + b.discount, 0),
        },
        couponRedemptions: group(l.coupons.filter((c) => r(c.at))),
      },
      scholarships: { awards: group(l.awards.filter((a) => r(a.at))) },
      expenses: {
        byCurrency: [...byCur.values()],
        byCategory: [...byCat.values()],
        withApprover: sum(expenses.filter((e) => e.approved)),
      },
    };
  }

  async analytics(range: DateRange): Promise<DashboardAnalytics> {
    const l = this.ledger;
    const r = (at: string) => this.inRange(at, range);
    const counts = (items: Array<{ status: string }>) => {
      const m = new Map<string, number>();
      for (const i of items) m.set(i.status.toLowerCase(), (m.get(i.status.toLowerCase()) ?? 0) + 1);
      return [...m.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
    };
    const batches = new Map<string, { batchCode: string; batchName: string; byStatus: Record<string, number>; marked: number }>();
    for (const a of l.attendance.filter((x) => r(x.at))) {
      const b = batches.get(a.batchCode) ?? { batchCode: a.batchCode, batchName: a.batchName, byStatus: {}, marked: 0 };
      b.byStatus[a.status.toLowerCase()] = (b.byStatus[a.status.toLowerCase()] ?? 0) + 1;
      b.marked++;
      batches.set(a.batchCode, b);
    }
    const accounts = new Map<string, { role: string; status: string; count: number }>();
    for (const a of l.accounts) {
      const k = `${a.role}|${a.status}`;
      const x = accounts.get(k) ?? { role: a.role, status: a.status, count: 0 };
      x.count++;
      accounts.set(k, x);
    }
    return {
      from: range.from,
      to: range.to,
      months: monthsBetween(range.from, range.to).map((m) => ({
        month: m,
        registrations: l.registrations.filter((at) => r(at) && istMonth(at) === m).length,
        enrollments: l.enrollments.filter((e) => r(e.at) && istMonth(e.at) === m).length,
        revenueCollected:
          l.transactions.filter((t) => t.status === "successful" && r(t.at) && istMonth(t.at) === m).reduce((a, b) => a + b.amount, 0) +
          l.manual.filter((t) => t.status === "verified" && r(t.at) && istMonth(t.at) === m).reduce((a, b) => a + b.amount, 0),
      })),
      enrollmentsByStatus: counts(l.enrollments.filter((e) => r(e.at))),
      attendanceByBatch: [...batches.values()],
      assessmentsByStatus: counts(l.attempts.filter((a) => r(a.at))),
      placementApplicationsByStatus: counts(l.applications.filter((a) => r(a.at))),
      accountsByRole: [...accounts.values()],
    };
  }

  async recordExport(entry: ExportRecord): Promise<void> {
    if (this.failExportAudit) throw new Error("audit write failed");
    this.exports.push(entry);
  }
}
