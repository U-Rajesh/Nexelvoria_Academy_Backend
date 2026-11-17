import type { HelmetOptions } from "helmet";

import { isProduction } from "./env";

/**
 * Helmet configuration.
 *
 * This is a JSON API, not a web page: it serves no HTML, loads no scripts
 * and embeds no frames. So the content policy is locked to "nothing" rather
 * than tuned for a document.
 */
export const helmetOptions: HelmetOptions = {
  // Deny every content source. An API response should never be able to
  // pull a script or style, so there is nothing to allow.
  contentSecurityPolicy: {
    // Without this, helmet merges its browser-oriented defaults in and we
    // end up advertising script-src/style-src/font-src on a JSON API.
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      sandbox: [],
    },
  },

  // API responses are not framed.
  frameguard: { action: "deny" },

  // Do not leak our URLs to third parties via the Referer header.
  referrerPolicy: { policy: "no-referrer" },

  // Opt browsers out of cross-origin embedding of our responses.
  crossOriginResourcePolicy: { policy: "same-site" },

  // HSTS only makes sense over real HTTPS; asserting it in development
  // would pin localhost to https in the developer's browser.
  hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
};
