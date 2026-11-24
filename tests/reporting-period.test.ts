import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { financialYearLabel, financialYearStart, istMonthStart } from "../src/modules/admin/reporting-period";

/** 1 April 00:00 IST is 31 March 18:30 UTC. */
const fyStartUtc = (year: number) => new Date(Date.UTC(year, 2, 31, 18, 30));

describe("reporting periods (Indian financial year, IST)", () => {
  it("starts the financial year on 1 April IST", () => {
    assert.deepEqual(financialYearStart(new Date("2026-11-23T10:00:00Z")), fyStartUtc(2026));
    assert.equal(financialYearLabel(new Date("2026-11-23T10:00:00Z")), "FY 2026-27");
  });

  it("keeps January-March in the previous financial year", () => {
    assert.deepEqual(financialYearStart(new Date("2027-02-10T10:00:00Z")), fyStartUtc(2026));
    assert.equal(financialYearLabel(new Date("2027-02-10T10:00:00Z")), "FY 2026-27");
  });

  it("switches at midnight IST, not midnight UTC", () => {
    // 31 March 23:59 IST -> still FY 2025-26.
    assert.deepEqual(financialYearStart(new Date("2026-03-31T18:29:00Z")), fyStartUtc(2025));
    // 1 April 00:00 IST (still 31 March in UTC) -> FY 2026-27.
    assert.deepEqual(financialYearStart(new Date("2026-03-31T18:30:00Z")), fyStartUtc(2026));
    assert.equal(financialYearLabel(new Date("2026-03-31T18:30:00Z")), "FY 2026-27");
  });

  it("labels the century rollover with two digits", () => {
    assert.equal(financialYearLabel(new Date("2099-06-01T00:00:00Z")), "FY 2099-00");
  });

  it("computes the month start in IST", () => {
    // 1 Dec 03:00 IST is 30 Nov 21:30 UTC: the month is December in IST.
    assert.deepEqual(istMonthStart(new Date("2026-11-30T21:30:00Z")), new Date(Date.UTC(2026, 10, 30, 18, 30)));
  });
});
