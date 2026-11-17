import { Router } from "express";

import { healthController } from "./health.controller";

/**
 * Routes owned by the health module.
 *
 * Paths here are relative - the parent prefix (`/api/v1`) is applied in
 * src/routes/index.ts, so this file never repeats the version.
 */
export const healthRoutes = Router();

healthRoutes.get("/health", healthController.getHealth);
