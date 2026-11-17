import type { AuthenticatedUser } from "./user.contract";

/**
 * Augments Express's Request with the fields our middleware attaches.
 *
 * `validatedQuery` exists because Express 5 exposes `req.query` as a
 * getter: assigning to it fails silently (verified - the write is accepted
 * but reads return `{}`). Validated query params therefore live here
 * instead. `req.body` and `req.params` remain safe to overwrite.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Parsed + coerced query params. Set by `validate()`. */
      validatedQuery?: unknown;

      /**
       * The authenticated caller. Set ONLY by the authentication
       * middleware, which does not exist yet - so this is always
       * undefined today and role guards fail closed because of it.
       *
       * Never populate this from a request body or header.
       */
      user?: AuthenticatedUser;

      /**
       * Correlation id for this request. Set by `requestContext()` as the
       * very first middleware, so everything downstream can log it.
       */
      requestId?: string;
    }
  }
}

export {};
