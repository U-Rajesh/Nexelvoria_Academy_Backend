import type { DashboardAnalytics, ExportRecord, FinancialSummary, ReportCode, ReportFilter, ReportPage, ReportResult } from "./reports.types";

export interface DateRange {
  /** Inclusive IST calendar dates (YYYY-MM-DD). */
  from: string;
  to: string;
}

export interface ReportsRepository {
  /** One page of a tabular report, or every row when `page` is null (exports). */
  runReport(code: Exclude<ReportCode, "financial-summary">, filter: ReportFilter, page: ReportPage | null): Promise<ReportResult>;
  /** Distinct status values present in the data (lower case), for the status filter. */
  listStatuses(code: Exclude<ReportCode, "financial-summary">): Promise<string[]>;
  financialSummary(range: DateRange): Promise<FinancialSummary>;
  analytics(range: DateRange): Promise<DashboardAnalytics>;
  /** Audit row for a report export (who, which report, filters, row count; never the data). */
  recordExport(entry: ExportRecord): Promise<void>;
}
