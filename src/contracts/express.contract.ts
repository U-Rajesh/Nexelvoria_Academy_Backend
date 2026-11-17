import type { AuthenticatedPrincipal, AuthenticatedUser } from "./user.contract";

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
       * The verified caller, derived from the access token.
       *
       * Set ONLY by `authenticate` - never from a request body, query
       * string or header. A client that sends `X-User-Role: super_admin`
       * is ignored entirely: this field comes from a signed token or it
       * stays undefined, and the role guards fail closed when it is
       * undefined.
       */
      principal?: AuthenticatedPrincipal;

      /**
       * DEPRECATED and NOT an authorization identity.
       *
       * Nothing populates this - an access token carries no email - and as
       * of Step 6E the role guards ignore it entirely: setting it does NOT
       * grant access, and a request carrying it without a `principal` is
       * logged as an error and denied.
       *
       * It remains declared only so code written against it still compiles
       * while the backend lead and Developer 2 agree on removing it. Use
       * `principal`.
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
