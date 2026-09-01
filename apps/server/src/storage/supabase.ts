import { Readable } from "node:stream";
import type { Storage } from "./adapter.js";

/**
 * Supabase Storage driver.
 *
 * The same three methods as the local driver, but the bytes land in a Supabase
 * Storage bucket instead of a volume beside the database. That is what makes
 * uploads survive a redeploy and work from a serverless or multi-replica host,
 * where a local directory would be empty or per-instance.
 *
 * The bucket is private. Nothing here hands the browser a Supabase URL: the
 * server reads the bytes with the service key and streams them back through its
 * own `/api/files/:id` route, which is where the board authorisation and the
 * safe-content-type rules live. The storage backend never sees who is asking.
 *
 * Reads from `process.env` directly, like the local driver — each driver owns
 * its own settings so the boot-time schema every deployment must satisfy does
 * not grow a column for a backend most instances never use.
 *
 * The declared content type travels in a sidecar object beside the bytes, the
 * same way the local driver keeps a `.type` file, rather than being read back
 * off the response. That is not belt and braces: Supabase Storage rewrites some
 * types on the way out — an uploaded text/html comes back as text/plain — and
 * the route that decides what is safe to serve inline has to see what was
 * actually uploaded, not what the bucket decided to call it.
 *
 *   STORAGE_DRIVER           "supabase"
 *   SUPABASE_URL             https://<ref>.supabase.co             (required)
 *   SUPABASE_SECRET_KEY      sb_secret_… / service key             (required)
 *   SUPABASE_STORAGE_BUCKET  bucket name              (default "attachments")
 */
export function createSupabaseStorage(): Storage {
  const url = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SECRET_KEY");
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "attachments";
  const object = `${url}/storage/v1/object`;
  const auth = { apikey: key, authorization: `Bearer ${key}` };
  const path = (k: string) => `${object}/${bucket}/${encodeURIComponent(k)}`;
  /** Bytes and their content type sit side by side, as `abcd…` and `abcd….type`. */
  const META = ".type";

  return {
    async put(k, data, contentType) {
      const res = await fetch(path(k), {
        method: "POST",
        headers: {
          ...auth,
          "content-type": contentType,
          // The key is a UUID, so a collision means a retry of the same upload;
          // upsert makes that idempotent rather than a 409.
          "x-upsert": "true",
          "cache-control": "max-age=31536000",
        },
        body: data,
      });
      if (!res.ok) {
        throw new Error(`supabase storage put failed: ${res.status} ${await res.text().catch(() => "")}`);
      }

      const meta = await fetch(path(k + META), {
        method: "POST",
        headers: { ...auth, "content-type": "text/plain", "x-upsert": "true" },
        body: contentType,
      });
      if (!meta.ok) {
        throw new Error(`supabase storage put failed (type): ${meta.status}`);
      }
      return { key: k, size: data.byteLength, contentType };
    },

    async get(k) {
      const [res, meta] = await Promise.all([
        fetch(path(k), { headers: auth }),
        fetch(path(k + META), { headers: auth }),
      ]);
      // Absent bytes are a 404 for the caller, not a fault.
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`supabase storage get failed: ${res.status}`);
      // Buffer rather than stream: the cap is 10 MB, and holding it lets us hand
      // back a byte-accurate Content-Length instead of trusting a header.
      const buf = Buffer.from(await res.arrayBuffer());
      // The sidecar is the truth. A missing one — bytes written before a crash,
      // or by an older build — falls back to a download rather than a guess at
      // what the bucket meant.
      const declared = meta.ok ? (await meta.text().catch(() => "")).trim() : "";
      return {
        stream: Readable.from(buf),
        contentType: declared || "application/octet-stream",
        size: buf.byteLength,
      };
    },

    async delete(k) {
      // Idempotent: already gone is a success, for the bytes and their sidecar.
      const gone = (res: Response) => res.ok || res.status === 404 || res.status === 400;
      const [res, meta] = await Promise.all([
        fetch(path(k), { method: "DELETE", headers: auth }),
        fetch(path(k + META), { method: "DELETE", headers: auth }),
      ]);
      if (!gone(res) || !gone(meta)) {
        throw new Error(`supabase storage delete failed: ${res.status}/${meta.status}`);
      }
    },
  };
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required when STORAGE_DRIVER is "supabase"`);
  return v;
}
