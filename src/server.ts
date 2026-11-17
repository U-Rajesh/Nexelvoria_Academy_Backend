import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./utils/logger";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`NEXELVORIA Backend listening on http://localhost:${env.PORT}`);
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`Health check: http://localhost:${env.PORT}/api/v1/health`);
});

const shutdown = (signal: string): void => {
  logger.info(`${signal} received, shutting down gracefully...`);

  server.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A process in an unknown state must not keep serving traffic.
process.on("unhandledRejection", (reason: unknown) => {
  logger.error("unhandled promise rejection - shutting down", { err: reason });
  server.close(() => process.exit(1));
});

process.on("uncaughtException", (error: Error) => {
  logger.error("uncaught exception - shutting down", { err: error });
  server.close(() => process.exit(1));
});
