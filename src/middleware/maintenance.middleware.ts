import { Router, type NextFunction, type Request, type Response } from "express";
import { ApiError } from "../utils/api-error";
import { sendSuccess } from "../utils/send";
import { verifyAccessToken } from "../modules/auth/token.service";
import { logger } from "../utils/logger";

export interface MaintenanceState {
  enabled: boolean;
  message?: string | undefined;
}

export const DEFAULT_MAINTENANCE_MESSAGE = "Nexelvoria Academy is undergoing scheduled maintenance. Please try again shortly.";

/**
 * Maintenance mode (CFG-20). While it is on, every API request is answered
 * with 503 MAINTENANCE_MODE except:
 * - the health check and GET /maintenance (so clients can show the notice);
 * - /auth/* (so a Super Admin can still sign in, and anyone can sign out);
 * - requests carrying a valid Super Admin access token (they turn it off).
 * The flag is read from NXA_InstituteSettings with a short cache; a save
 * through the settings service invalidates it immediately.
 */
export function createMaintenanceGuard(options: { read: () => Promise<MaintenanceState>; ttlMs?: number }) {
  const ttl = options.ttlMs ?? 5000;
  let cached: { state: MaintenanceState; at: number } | null = null;

  const current = async (): Promise<MaintenanceState> => {
    if (cached && Date.now() - cached.at < ttl) return cached.state;
    try {
      const state = await options.read();
      cached = { state, at: Date.now() };
      return state;
    } catch (err) {
      // Fail open: a settings read failure must not take the whole API down.
      logger.error("maintenance state could not be read", { err: err instanceof Error ? err.message : String(err) });
      return { enabled: false };
    }
  };

  const isSuperAdmin = (req: Request): boolean => {
    const m = /^Bearer[ ]+(\S+)$/.exec(req.headers.authorization ?? "");
    if (!m) return false;
    const v = verifyAccessToken(m[1]);
    // Bypass only; the route's own authentication still checks the session.
    return v.valid && v.claims.role === "super_admin";
  };

  const exempt = (req: Request): boolean =>
    req.path === "/health" || req.path.startsWith("/health/") || req.path === "/maintenance" || req.path.startsWith("/auth/");

  const middleware = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (exempt(req)) return next();
    const state = await current();
    if (!state.enabled || isSuperAdmin(req)) return next();
    next(ApiError.serviceUnavailable(state.message || DEFAULT_MAINTENANCE_MESSAGE, "MAINTENANCE_MODE"));
  };

  /** Public status, so the frontend can show the notice instead of a generic error. */
  const statusRouter = Router();
  statusRouter.get("/maintenance", async (_req, res) => {
    const state = await current();
    sendSuccess(res, { data: { enabled: state.enabled, ...(state.enabled ? { message: state.message || DEFAULT_MAINTENANCE_MESSAGE } : {}) } });
  });

  return {
    middleware,
    statusRouter,
    invalidate: () => {
      cached = null;
    },
  };
}
