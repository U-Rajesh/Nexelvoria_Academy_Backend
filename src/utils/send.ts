import type { Response } from "express";

import type { ApiSuccess, PaginatedResult } from "../contracts/api.contract";
import { HttpStatus, type HttpStatusCode } from "./http-status";

interface SendOptions<T> {
  data?: T;
  message?: string;
  status?: HttpStatusCode;
}

/**
 * Writes a success envelope. `data` is omitted from the JSON entirely when
 * not supplied, so payload-free endpoints stay `{ success, message }`.
 *
 * Failure responses are NOT sent from here - throw an ApiError instead and
 * let the error middleware format it. That keeps one exit path for errors.
 */
export const sendSuccess = <T>(res: Response, options: SendOptions<T> = {}): void => {
  const body: ApiSuccess<T> = { success: true };

  if (options.message !== undefined) {
    body.message = options.message;
  }

  if (options.data !== undefined) {
    body.data = options.data;
  }

  res.status(options.status ?? HttpStatus.OK).json(body);
};

/** Convenience wrapper for list endpoints. */
export const sendPaginated = <T>(
  res: Response,
  result: PaginatedResult<T>,
  message?: string,
): void => {
  sendSuccess(res, message === undefined ? { data: result } : { data: result, message });
};
