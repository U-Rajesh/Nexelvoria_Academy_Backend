import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestHarness } from "./fakes";
import { describeCredentialRepositoryContract } from "./conformance/credential.conformance";
import { describeOtpRepositoryContract } from "./conformance/otp.conformance";
import { describeStudentRegistrationRepositoryContract } from "./conformance/registration.conformance";
import { describeSessionRepositoryContract } from "./conformance/session.conformance";
import {
  describeStudentRepositoryContract,
  type StudentPorts,
} from "./conformance/student.conformance";
import { describeUserRepositoryContract } from "./conformance/user.conformance";

/**
 * Runs the repository port-conformance suites against the IN-MEMORY FAKES.
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR.
 *
 * The suites in `tests/conformance/` are written against the interfaces
 * alone. This file is one of two intended runners:
 *
 *   - THIS ONE, binding them to the fakes, which runs in CI today. It proves
 *     the suites are honest (a specification nothing satisfies is worthless)
 *     and it protects the fakes from drifting away from the ports they stand
 *     in for.
 *
 *   - A SECOND runner, `conformance.mssql.test.ts`, which does not exist yet.
 *     It will bind the identical suites to the MS SQL Server adapters once
 *     the database team supplies a schema and a development database
 *     (handoff Q-M5 and Q-C5). No test in `tests/conformance/` should need to
 *     change when that happens - if one does, it was testing the fake rather
 *     than the contract.
 *
 * ---------------------------------------------------------------------------
 * READ THE LIMITATION BEFORE TRUSTING A GREEN RUN.
 *
 * The `[concurrency]` tests fire overlapping calls with `Promise.all`.
 * Against these fakes that is not real concurrency: no fake awaits anything
 * inside a method, so the event loop runs each to completion in turn. Passing
 * here demonstrates only the SEQUENTIAL half of each contract.
 *
 * Those tests exist now so the requirement is written down before the SQL is,
 * and so the adapter is measured against a specification rather than against
 * someone's recollection of a code comment. They become load-bearing on the
 * day the second runner exists.
 * ===========================================================================
 */

const fakes = () => {
  const h = createTestHarness();

  return h;
};

describeUserRepositoryContract("in-memory fake", () => ({
  repo: fakes().container.repositories.users,
}));

describeCredentialRepositoryContract("in-memory fake", () => ({
  repo: fakes().container.repositories.credentials,
}));

describeSessionRepositoryContract("in-memory fake", () => ({
  repo: fakes().container.repositories.sessions,
}));

describeOtpRepositoryContract("in-memory fake", () => ({
  repo: fakes().container.repositories.otpChallenges,
}));

describeStudentRegistrationRepositoryContract("in-memory fake", () => ({
  repo: fakes().container.repositories.studentRegistration,
}));

describeStudentRepositoryContract("in-memory fake", () => {
  const h = fakes();

  return {
    repo: {
      students: h.container.repositories.students,
      users: h.container.repositories.users,
    } satisfies StudentPorts,
  };
});

/**
 * A guard on the suite itself.
 *
 * The conformance modules are libraries, not tests: `npm test` globs
 * `tests/*.test.ts` (top level only), so nothing under `tests/conformance/`
 * runs unless a runner imports it. If a suite were added there and never
 * wired up here it would silently never execute, which is worse than not
 * having written it.
 */
describe("conformance suite wiring", () => {
  it("every port with a conformance suite is bound to the fakes in this file", () => {
    const bound = [
      "users",
      "credentials",
      "sessions",
      "otpChallenges",
      "students",
      "studentRegistration",
    ] as const;

    const h = fakes();

    for (const name of bound) {
      assert.ok(
        h.container.has(name),
        `${name} must be registered in the test harness for its suite to run`,
      );
    }
  });
});
