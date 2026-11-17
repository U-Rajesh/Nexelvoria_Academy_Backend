import type { Request, Response } from "express";

import { sendSuccess } from "../../utils/send";
import { healthService } from "./health.service";

/**
 * HTTP adapter for the health module.
 *
 * A controller does three things and nothing else: read input off the
 * request, call the service, write the response. No business rules here.
 */
export const healthController = {
  getHealth(_req: Request, res: Response): void {
    const status = healthService.getStatus();

    // Response shape is pinned to the contract agreed in Step 1:
    // { success: true, message: "NEXELVORIA Backend is running" }
    sendSuccess(res, { message: status.message });
  },
};
