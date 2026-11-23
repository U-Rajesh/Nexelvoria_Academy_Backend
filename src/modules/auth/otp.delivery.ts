import nodemailer, { type Transporter } from "nodemailer";

import { isProduction } from "../../config/env";
import {
  isSmtpConfigured,
  loadSmtpConfig,
  type SmtpConfig,
} from "../../config/smtp";
import { logger } from "../../utils/logger";
import { describeError } from "../../utils/redact";
import type { OtpPurpose } from "./otp.types";

/**
 * How an OTP reaches the student.
 *
 * Implements the Port pattern: business services depend solely on `OtpDeliveryPort`,
 * allowing adapters for SMTP (production), logging (development), or mock transport
 * (testing) to be swapped without changing business logic.
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
   * stored, never returned from an endpoint and never logged in production.
   */
  code: string;

  purpose: OtpPurpose;

  /** For the message body ("expires in 5 minutes"). */
  expiresInSeconds: number;
}

/**
 * Outcome of a delivery attempt.
 *
 * A failure is a VALUE, not an exception: "the mail provider is down" is an
 * expected operational condition the service translates into a retryable failure,
 * and modelling it as a return value prevents it from crashing the request.
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
  /** Which channel this adapter speaks. Email only (BR-014, Q3). */
  readonly channel: "email";

  send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult>;
}

/**
 * Masks an email address for logging: `aarav.sharma@example.com` becomes
 * `a***a@example.com`.
 */
export const maskDestination = (destination: string): string => {
  const at = destination.lastIndexOf("@");

  if (at <= 0) {
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
 * Refusal message when the logging adapter is constructed in production.
 */
export const LOGGING_DELIVERY_REFUSAL =
  "createLoggingOtpDelivery() writes one-time passcodes to the application log and must " +
  "never be constructed when NODE_ENV=production. Configure SMTP credentials for " +
  "production email delivery instead.";

/**
 * Options for creating an SMTP OTP delivery adapter.
 */
export interface SmtpOtpDeliveryOptions {
  config: SmtpConfig;
  /**
   * Optional custom Nodemailer transporter.
   * Used primarily for automated testing with mocked transports.
   */
  transporter?: Transporter | undefined;
}

/**
 * Production-ready SMTP email delivery adapter using Nodemailer.
 *
 * Transmits professional HTML and plaintext OTP verification emails to the
 * registered user's email address. Never logs the plaintext passcode.
 */
export const createSmtpOtpDelivery = (options: SmtpOtpDeliveryOptions): OtpDeliveryPort => {
  const transporter =
    options.transporter ??
    nodemailer.createTransport({
      host: options.config.host,
      port: options.config.port,
      secure: options.config.secure,
      auth: {
        user: options.config.user,
        pass: options.config.pass,
      },
    });

  return {
    channel: "email",

    async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
      const minutes = Math.round(request.expiresInSeconds / 60);
      const subject = "Nexelvoria Academy — Your Verification Code";
      const text =
        `Hello,\n\n` +
        `Your Nexelvoria Academy verification code is: ${request.code}\n\n` +
        `This code is valid for ${minutes} minutes. If you did not request this code, please ignore this email.\n\n` +
        `Nexelvoria Academy Admissions Team`;

      const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h2 style="color: #0f172a; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">NEXELVORIA ACADEMY</h2>
    <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Student Portal Email Verification</p>
  </div>
  <p style="color: #334155; font-size: 15px; line-height: 1.5;">Hello,</p>
  <p style="color: #334155; font-size: 15px; line-height: 1.5;">Thank you for registering with Nexelvoria Academy. Please enter the following 6-digit verification code to confirm your email address:</p>
  <div style="text-align: center; margin: 28px 0;">
    <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; background: #eff6ff; padding: 12px 28px; border-radius: 8px; border: 1px dashed #60a5fa;">${request.code}</span>
  </div>
  <p style="color: #64748b; font-size: 13px; line-height: 1.5;">This passcode expires in <strong>${minutes} minutes</strong>. For your security, never share this code with anyone.</p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
  <p style="color: #94a3b8; font-size: 12px; text-align: center; margin: 0;">If you did not initiate this registration, please disregard this email.</p>
</div>
      `.trim();

      try {
        const info = await transporter.sendMail({
          from: options.config.from,
          to: request.destination,
          subject,
          text,
          html,
        });

        // Provider rejected the destination address
        if (info.rejected && info.rejected.length > 0) {
          logger.error("email delivery rejected by SMTP provider", {
            destination: maskDestination(request.destination),
            rejected: info.rejected,
          });

          return {
            delivered: false,
            reason: `Recipient rejected by mail provider for ${maskDestination(request.destination)}`,
          };
        }

        // SECURITY: Mask destination, log messageId, and NEVER log the code itself.
        logger.info("otp email delivered successfully", {
          channel: "email",
          purpose: request.purpose,
          to: maskDestination(request.destination),
          messageId: info.messageId,
        });

        return { delivered: true };
      } catch (err: unknown) {
        logger.error("failed to deliver otp email via smtp", {
          destination: maskDestination(request.destination),
          errorType: describeError(err),
        });

        return {
          delivered: false,
          reason: err instanceof Error ? err.message : "SMTP delivery error",
        };
      }
    },
  };
};

/**
 * DEVELOPMENT AND TEST ONLY - writes the passcode to the log instead of
 * sending it.
 *
 * Refuses to construct under `NODE_ENV=production`.
 */
export const createLoggingOtpDelivery = (): OtpDeliveryPort => {
  if (isProduction) {
    throw new Error(LOGGING_DELIVERY_REFUSAL);
  }

  return {
    channel: "email",

    async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
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

/**
 * Resolves the appropriate OTP delivery adapter:
 * - When `NODE_ENV=production`: strictly loads SMTP config and fails closed if invalid.
 * - When `NODE_ENV!=production`:
 *     - If SMTP is configured and not explicitly opted out via USE_LOGGING_OTP=true, uses SMTP.
 *     - Otherwise, falls back to the development logging adapter with a visible notice.
 */
export const resolveOtpDelivery = (
  envSource: NodeJS.ProcessEnv = process.env,
  customTransporter?: Transporter,
): OtpDeliveryPort => {
  const isProd = envSource["NODE_ENV"] === "production";
  const useLoggingExplicit = envSource["USE_LOGGING_OTP"] === "true";

  if (isProd) {
    const config = loadSmtpConfig(envSource, "production");
    return createSmtpOtpDelivery({ config, transporter: customTransporter });
  }

  if (isSmtpConfigured(envSource) && !useLoggingExplicit) {
    try {
      const config = loadSmtpConfig(envSource, envSource["NODE_ENV"] || "development");
      return createSmtpOtpDelivery({ config, transporter: customTransporter });
    } catch (err: unknown) {
      logger.warn("SMTP configuration error in development. Falling back to logging adapter.", {
        errorType: describeError(err),
      });
    }
  }

  return createLoggingOtpDelivery();
};
