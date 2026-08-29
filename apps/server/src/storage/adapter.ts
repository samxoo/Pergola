import { createLocalStorage } from "./local.js";

/**
 * Where uploaded bytes live.
 *
 * Three methods, picked once at boot. Callers write, read and delete without
 * knowing whether the bytes land on a volume beside the database or in a bucket
 * on the other side of the world — which is the whole point: adding a second
 * driver is a new file and one `case` below, and not one line changes in the
 * routes that use it.
 *
 * S3 is the one worth adding next, and it buys more than S3: Supabase Storage,
 * Cloudflare R2, Backblaze B2, MinIO and Wasabi all speak the same protocol, so
 * a single driver covers every hosted deployment anyone is likely to want.
 */

export type StoredFile = { key: string; size: number; contentType: string };

export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<StoredFile>;
  /** Null rather than a throw: bytes that are not there are a 404, not a fault. */
  get(
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number } | null>;
  /** Idempotent. Deleting what is already gone has succeeded. */
  delete(key: string): Promise<void>;
}

/**
 * Read straight from `process.env` rather than through env.ts on purpose: each
 * driver owns its own settings, so adding S3 later adds an endpoint, a bucket
 * and two credentials to that driver and nothing at all to the schema every
 * deployment must satisfy at boot.
 *
 *   STORAGE_DRIVER  which driver to use              (default "local")
 *   STORAGE_DIR     where the local driver writes    (default "./data/uploads")
 */
export function createStorage(): Storage {
  const driver = process.env.STORAGE_DRIVER?.trim() || "local";

  switch (driver) {
    case "local":
      return createLocalStorage();
    default:
      // Thrown at boot, where it is one line in the log, rather than on the
      // first upload weeks later, where it is a mystery.
      throw new Error(`STORAGE_DRIVER is "${driver}"; the only driver is "local"`);
  }
}
