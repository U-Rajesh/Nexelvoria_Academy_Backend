import { env } from "../../config/env";
import type { HealthStatus } from "./health.types";

/**
 * Business logic for the health module.
 *
 * Must stay dependency-free: this endpoint has to answer even when the
 * database and every downstream service is unavailable, which is the
 * whole point of a liveness probe.
 */
export const healthService = {
  getStatus(): HealthStatus {
    return {
      message: "NEXELVORIA Backend is running",
      uptimeSeconds: Math.floor(process.uptime()),
      environment: env.NODE_ENV,
    };
  },
};
