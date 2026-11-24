import nodemailer from "nodemailer";

import { describeSmtpConfig, isSmtpConfigured, loadSmtpConfig, SmtpConfigError } from "../../config/smtp";
import { PASSWORD_MIN_LENGTH } from "../auth/auth.validation";
import { MAX_FAILED_LOGIN_ATTEMPTS } from "../auth/login.service";
import {
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
} from "../auth/otp.service";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../auth/token.service";
import { financialYearLabel, financialYearStart } from "./reporting-period";

/**
 * Platform configuration as the server ACTUALLY runs it (Super Admin, read-only).
 *
 * There is no configuration table: SMTP, tokens, lockout and OTP policy come
 * from environment variables and code constants, so this reports those values
 * rather than a stored document that nothing reads. Secrets are never
 * returned - only whether they are set and a masked identity. Editable
 * institute details live in institute settings (`/admin/settings`).
 */
export interface SystemConfigStatus {
  source: "server_environment";
  editable: false;
  email: {
    /** "smtp": real delivery; "development_log": codes are written to the server log; "not_configured". */
    delivery: "smtp" | "development_log" | "not_configured";
    host?: string;
    port?: number;
    secure?: boolean;
    /** Masked, e.g. "no***@example.com". */
    user?: string;
    from?: string;
    /** Present when SMTP variables exist but are invalid. */
    configurationError?: string;
  };
  sms: { configured: false; note: string };
  /**
   * CFG-08 / CFG-22: what is actually configured. Only presence is reported,
   * never a secret value; nothing here claims a provider was verified.
   */
  integrations: {
    paymentGateway: {
      provider: "razorpay";
      /** RAZORPAY_WEBHOOK_SECRET or RAZORPAY_KEY_SECRET is set (webhook signature verification). */
      webhookSecretConfigured: boolean;
      /** Checkout (order creation) is not integrated: no key id is read by the server. */
      checkoutIntegrated: false;
      verified: false;
      note: string;
    };
    fileStorage: { configured: false; note: string };
    whatsapp: { configured: false; note: string };
    backups: { configured: false; note: string };
  };
  security: {
    maxFailedLoginAttempts: number;
    passwordMinLength: number;
    accessTokenTtlMinutes: number;
    refreshTokenTtlDays: number;
    rememberMeRefreshTokenTtlDays: number;
  };
  otp: { channel: "email"; ttlMinutes: number; maxVerifyAttempts: number; resendCooldownSeconds: number };
  reporting: { timezone: "Asia/Kolkata"; financialYear: string; financialYearStartsAt: string };
  environment: string;
}

export const buildSystemConfigStatus = (
  source: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): SystemConfigStatus => {
  const nodeEnv = source["NODE_ENV"] || "development";
  let email: SystemConfigStatus["email"];

  if (!isSmtpConfigured(source)) {
    email = { delivery: nodeEnv === "production" ? "not_configured" : "development_log" };
  } else {
    try {
      const d = describeSmtpConfig(loadSmtpConfig(source, nodeEnv));
      email = {
        delivery: source["USE_LOGGING_OTP"] === "true" && nodeEnv !== "production" ? "development_log" : "smtp",
        host: String(d["host"]),
        port: Number(d["port"]),
        secure: Boolean(d["secure"]),
        user: String(d["user"]),
        from: String(d["from"]),
      };
    } catch (err) {
      email = {
        delivery: "not_configured",
        configurationError: err instanceof SmtpConfigError ? err.message : "SMTP configuration could not be read",
      };
    }
  }

  return {
    source: "server_environment",
    editable: false,
    email,
    sms: { configured: false, note: "No SMS provider is configured. Mobile OTP is not available." },
    integrations: {
      paymentGateway: {
        provider: "razorpay",
        webhookSecretConfigured: Boolean(source["RAZORPAY_WEBHOOK_SECRET"] || source["RAZORPAY_KEY_SECRET"]),
        checkoutIntegrated: false,
        verified: false,
        note: "Only webhook signature verification is wired. Online checkout is not integrated and no live payment has been verified (Q12).",
      },
      fileStorage: { configured: false, note: "No file storage is configured: logo, media, certificate template and document uploads are unavailable (Q11)." },
      whatsapp: { configured: false, note: "No WhatsApp messaging provider is approved or configured; the WhatsApp number is a contact detail only." },
      backups: { configured: false, note: "No backup service or scheduler is configured; backups are managed outside the application." },
    },
    security: {
      maxFailedLoginAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
      passwordMinLength: PASSWORD_MIN_LENGTH,
      accessTokenTtlMinutes: ACCESS_TOKEN_TTL_SECONDS / 60,
      refreshTokenTtlDays: REFRESH_TOKEN_TTL_SECONDS / 86400,
      rememberMeRefreshTokenTtlDays: REFRESH_TOKEN_REMEMBER_ME_TTL_SECONDS / 86400,
    },
    otp: {
      channel: "email",
      ttlMinutes: OTP_TTL_SECONDS / 60,
      maxVerifyAttempts: OTP_MAX_VERIFY_ATTEMPTS,
      resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    },
    reporting: {
      timezone: "Asia/Kolkata",
      financialYear: financialYearLabel(now),
      financialYearStartsAt: financialYearStart(now).toISOString(),
    },
    environment: nodeEnv,
  };
};

/** Sends one test message; resolves with the SMTP server's message id. */
export type TestMailer = (to: string) => Promise<{ messageId: string }>;

/**
 * A real SMTP send through the configured server. Returns `undefined` when
 * SMTP is not configured, so the caller can refuse instead of pretending.
 */
export const createSmtpTestMailer = (source: NodeJS.ProcessEnv = process.env): TestMailer | undefined => {
  if (!isSmtpConfigured(source)) return undefined;
  const config = loadSmtpConfig(source);
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  return async (to) => {
    const info = await transporter.sendMail({
      from: config.from,
      to,
      subject: "Nexelvoria Academy - SMTP test message",
      text:
        "This is a test message sent from the Nexelvoria Academy Super Admin console " +
        "to confirm that outgoing email is working. No action is needed.",
    });
    return { messageId: String(info.messageId ?? "") };
  };
};
