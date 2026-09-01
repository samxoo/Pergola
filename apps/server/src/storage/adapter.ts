import { createLocalStorage } from "./local.js";
import { createSupabaseStorage } from "./supabase.js";
import { isServerless } from "../runtime.js";

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

  /*
   * A serverless host has no writable disk and no disk that survives the next
   * invocation, so the default driver would accept an upload and lose it — or
   * fail with an EROFS deep inside a request weeks after the deploy. Refusing at
   * boot, by name, is the difference between a five-second fix and an afternoon.
   */
  if (driver === "local" && isServerless) {
    throw new Error(
      'STORAGE_DRIVER is "local", which needs a writable disk this runtime does not have. ' +
        'Set STORAGE_DRIVER=supabase (with SUPABASE_URL and SUPABASE_SECRET_KEY).',
    );
  }

  switch (driver) {
    case "local":
      return createLocalStorage();
    case "supabase":
      return createSupabaseStorage();
    default:
      // Thrown at boot, where it is one line in the log, rather than on the
      // first upload weeks later, where it is a mystery.
      throw new Error(`STORAGE_DRIVER is "${driver}"; the drivers are "local" and "supabase"`);
  }
}
