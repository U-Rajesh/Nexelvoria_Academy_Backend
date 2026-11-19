import { isProduction } from "../../config/env";
import { logger } from "../../utils/logger";
import type { OtpPurpose } from "./otp.types";

/**
 * How an OTP reaches the student.
 *
 * A PORT, for the same reason the repositories are ports: no provider has
 * been chosen or provisioned, and inventing SMTP hosts or API keys was
 * explicitly out of bounds. The service depends on this interface alone, so
 * swapping the logging adapter for a real one is a one-line change in the
 * container and touches no business logic.
 */

/** What an adapter is asked to deliver. */
export interface OtpDeliveryRequest {
  /** The student's email address. SENSITIVE - never log it unmasked. */
  destination: string;

  /**
   * The plaintext passcode.
   *
   * This is the ONLY place in the system where the plaintext exists after
   * generation: it is handed to the adapter and then dropped. It is never
   * stored, never returned from an endpoint and never logged outside the
   * development adapter below.
   */
  code: string;

  purpose: OtpPurpose;

  /** For the message body ("expires in 10 minutes"). */
  expiresInSeconds: number;
}

/**
 * Outcome of a delivery attempt.
 *
 * A failure is a VALUE, not an exception: "the mail provider is down" is an
 * expected operational condition the service must translate into a 503, and
 * modelling it as a return value stops it being mistaken for a bug.
 */
export type OtpDeliveryResult =
  | { delivered: true }
  | {
      delivered: false;
      /**
       * Operator-facing reason. Logged, never sent to the client - a
       * provider's error text can name internal infrastructure.
       */
      reason: string;
    };

export interface OtpDeliveryPort {
  /** Which channel this adapter speaks. Email only today (BR-014, Q3). */
  readonly channel: "email";

  send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult>;
}

/**
 * Masks an email address for logging: `aarav.sharma@example.com` becomes
 * `a***a@example.com`.
 *
 * The domain is kept because it is operationally useful (a provider outage
 * usually hits one domain) and is not personal on its own. The local part is
 * reduced to its first and last character, which is enough to correlate two
 * log lines about the same address without recording the address.
 */
export const maskDestination = (destination: string): string => {
  const at = destination.lastIndexOf("@");

  if (at <= 0) {
    // Not an address shape. Reveal nothing rather than guess.
    return "***";
  }

  const local = destination.slice(0, at);
  const domain = destination.slice(at);

  if (local.length <= 2) {
    return `***${domain}`;
  }

  return `${local[0] ?? ""}***${local[local.length - 1] ?? ""}${domain}`;
};

/**
 * The refusal message, exported so a test can assert on it exactly.
 */
export const LOGGING_DELIVERY_REFUSAL =
  "createLoggingOtpDelivery() writes one-time passcodes to the application log and must " +
  "never be constructed when NODE_ENV=production. Register a real email adapter in the " +
  "production container instead.";

/**
 * DEVELOPMENT AND TEST ONLY - writes the passcode to the log instead of
 * sending it.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT CANNOT REACH PRODUCTION.
 *
 * No email provider has been chosen, and no credentials exist. Rather than
 * invent them, the whole OTP domain - generation, hashing, expiry, resend
 * limits, attempt ceilings, verification - is built and tested against this
 * adapter now, and a real provider drops in behind the same port later.
 *
 * Logging a passcode is, deliberately, a credential in the log. That is
 * acceptable on a developer's machine and nowhere else, so the constructor
 * THROWS under NODE_ENV=production. It fails at construction rather than at
 * the first send, so a misconfigured production process dies at startup
 * instead of quietly printing passcodes under load.
 * ===========================================================================
 */
export const createLoggingOtpDelivery = (): OtpDeliveryPort => {
  if (isProduction) {
    throw new Error(LOGGING_DELIVERY_REFUSAL);
  }

  return {
    channel: "email",

    async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
      // `warn`, not `info`: a passcode in a log is a finding, and the level
      // should say so even in development.
      logger.warn(
        "DEVELOPMENT OTP DELIVERY - the passcode below was logged instead of emailed. " +
          "Never run this adapter in production.",
        {
          channel: "email",
          purpose: request.purpose,
          to: maskDestination(request.destination),
          code: request.code,
          expiresInSeconds: request.expiresInSeconds,
        },
      );

      return { delivered: true };
    },
  };
};
