// Side-effect import: refuses to load in a production process. MUST stay
// first, so the refusal happens before any fake is constructed.
import "./guard.dev";

import type { AppContainer } from "../src/container/container";
import type { RegistrationServiceDeps } from "../src/modules/auth/registration.service";
import { createTestHarness, type TestHarness } from "../tests/fakes";

/**
 * DEVELOPMENT ONLY - the shared in-memory container for the local
 * registration harness. See dev/guard.dev.ts for why this cannot reach
 * production.
 *
 * ONE CONTAINER PER PROCESS, deliberately.
 *
 * `createContainer()` memoises each repository on first access, so a single
 * container yields a single instance of every fake - which is what makes
 * state survive across HTTP requests. A container per request would hand
 * every request an empty store, and a registration would never be visible
 * to the duplicate check that follows it.
 *
 * The consequence to know about: state lives in this process's memory only.
 * It is lost on restart (including every `tsx watch` reload), it is not
 * shared between processes, and it is NOT a database.
 */
let harness: TestHarness | undefined;

/**
 * The process-wide harness, created on first use.
 *
 * Returned whole rather than just the container so a local script can seed
 * or inspect the fakes directly, exactly as a test does.
 */
export const getDevHarness = (): TestHarness => {
  harness ??= createTestHarness();

  return harness;
};

/** The shared container. Pass to `createApp({ container })`. */
export const createDevContainer = (): AppContainer => getDevHarness().container;

/**
 * The three repositories the registration service needs, resolved from the
 * shared container.
 *
 * Dependencies are passed as GETTERS, matching `src/routes/index.ts`: the
 * repository is resolved on the first request that needs it rather than at
 * wiring time, so building the routes can never fail on a missing adapter.
 */
export const createDevRegistrationDeps = (
  container: AppContainer = createDevContainer(),
): RegistrationServiceDeps => ({
  get users() {
    return container.repositories.users;
  },
  get credentials() {
    return container.repositories.credentials;
  },
  get students() {
    return container.repositories.students;
  },
});
