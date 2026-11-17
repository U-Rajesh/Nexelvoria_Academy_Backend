import type { Application } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Starts an app on an ephemeral port and returns helpers to call it.
 *
 * Port 0 lets the OS pick a free port, so tests never collide with the dev
 * server or with each other when run concurrently.
 */
export interface TestServer {
  url: string;
  close: () => Promise<void>;
  get: (path: string, init?: RequestInit) => Promise<Response>;
  post: (path: string, body?: unknown, init?: RequestInit) => Promise<Response>;
}

export const startServer = async (app: Application): Promise<TestServer> => {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    get: (path, init) => fetch(`${url}${path}`, init),
    post: (path, body, init) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...init,
      }),
  };
};

/** Reads a JSON body as an unknown-shaped record. */
export const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;
