import "dotenv/config";

/**
 * SMTP configuration for email delivery (e.g. OTP verification).
 *
 * Follows the pattern established in `src/config/sqlserver.ts`:
 * parsed on demand, validated against production requirements, and fails
 * closed with clear, actionable error messages.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** SENSITIVE. Never logged, never serialised, never returned from an endpoint. */
  pass: string;
  from: string;
}

export class SmtpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpConfigError";
  }
}

export const REQUIRED_SMTP_VARS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
] as const;

const SMTP_PLACEHOLDERS = new Set([
  "smtp.example.com",
  "your-smtp-host",
  "smtp.yourprovider.com",
  "replace-me",
  "changeme",
  "change-me",
  "username",
  "password",
  "apikey",
  "your-smtp-password",
]);

const read = (source: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = source[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const parsePort = (value: string | undefined): number => {
  if (value === undefined) {
    return 587;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SmtpConfigError(
      `Invalid SMTP_PORT: "${value}". Expected an integer between 1 and 65535.`,
    );
  }

  return port;
};

const validateEmailAddress = (value: string, keyName: string): string => {
  // Accepts "user@example.com" or "Name <user@example.com>"
  const emailRegex = /^(?:[^\s<]+@[^\s>]+\.[^\s>]+|.+<[^\s<]+@[^\s>]+\.[^\s>]+>)$/;
  if (!emailRegex.test(value)) {
    throw new SmtpConfigError(
      `Invalid ${keyName}: "${value}". Expected a valid email address (e.g. "noreply@nexelvoria.com" or "Nexelvoria <noreply@nexelvoria.com>").`,
    );
  }
  return value;
};

/**
 * Checks whether minimum SMTP variables are supplied in the given environment.
 */
export const isSmtpConfigured = (source: NodeJS.ProcessEnv = process.env): boolean => {
  const host = read(source, "SMTP_HOST");
  const user = read(source, "SMTP_USER");
  const pass = read(source, "SMTP_PASS");
  return host !== undefined && user !== undefined && pass !== undefined;
};

/**
 * Loads and validates SMTP configuration.
 *
 * In production (`NODE_ENV=production`), fails closed if any required
 * variable is missing or set to a placeholder value.
 *
 * In development / test, returns undefined if unconfigured, allowing
 * fallback to the logging OTP delivery adapter when explicitly enabled.
 */
export const loadSmtpConfig = (
  source: NodeJS.ProcessEnv = process.env,
  nodeEnv: string = source["NODE_ENV"] || "development",
): SmtpConfig => {
  const host = read(source, "SMTP_HOST");
  const portStr = read(source, "SMTP_PORT");
  const user = read(source, "SMTP_USER");
  const pass = read(source, "SMTP_PASS");
  const from = read(source, "SMTP_FROM");
  const secureVal = read(source, "SMTP_SECURE");

  const isProd = nodeEnv === "production";

  if (isProd) {
    const missing = REQUIRED_SMTP_VARS.filter((key) => read(source, key) === undefined);
    if (missing.length > 0) {
      throw new SmtpConfigError(
        `Missing required SMTP configuration for production: ${missing.join(", ")}. ` +
          "Real email delivery is mandatory when NODE_ENV=production.",
      );
    }

    for (const [key, val] of [
      ["SMTP_HOST", host!],
      ["SMTP_USER", user!],
      ["SMTP_PASS", pass!],
    ] as const) {
      if (SMTP_PLACEHOLDERS.has(val.toLowerCase())) {
        throw new SmtpConfigError(
          `${key} is set to a placeholder value ("${val}"). Production requires valid SMTP credentials.`,
        );
      }
    }
  }

  if (host === undefined || user === undefined || pass === undefined) {
    throw new SmtpConfigError(
      "Incomplete SMTP configuration. SMTP_HOST, SMTP_USER, and SMTP_PASS must all be provided.",
    );
  }

  const port = parsePort(portStr);
  const secure = secureVal !== undefined ? secureVal.toLowerCase() === "true" : port === 465;
  const verifiedFrom = validateEmailAddress(
    from ?? "Nexelvoria Academy <admissions@nexelvoria.com>",
    "SMTP_FROM",
  );

  return {
    host,
    port,
    secure,
    user,
    pass,
    from: verifiedFrom,
  };
};

/**
 * Safe, redacted representation of SMTP configuration suitable for logs.
 * Never includes the password.
 */
export const describeSmtpConfig = (config: SmtpConfig): Record<string, unknown> => {
  const at = config.user.indexOf("@");
  const maskedUser =
    at > 1
      ? `${config.user.slice(0, 2)}***${config.user.slice(at)}`
      : config.user.length > 2
        ? `${config.user.slice(0, 2)}***`
        : "***";

  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: maskedUser,
    from: config.from,
  };
};
