/** Types owned by the health module. Not shared with other modules. */

export interface HealthStatus {
  message: string;
  uptimeSeconds: number;
  environment: string;
}
