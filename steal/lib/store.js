// Seen-nonce set for turn envelopes (replay protection) — serverless edition,
// mirroring the Gatekeeper agent's store. Backends:
//   1) Upstash Redis via REST when KV_REST_API_URL/KV_REST_API_TOKEN (Vercel
//      Marketplace) or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are set.
//   2) In-memory Map fallback (practice-grade: forgotten on cold start).
// The platform itself rejects expired nonces and dedupes turns; this set is
// defence-in-depth so a replayed envelope is never answered twice with proofs.

export const NONCE_TTL_SECONDS = 2 * 24 * 60 * 60; // 2 days

const KEY_PREFIX = "steal:nonce:";

function normalizeRef(v) {
  return String(v ?? "").trim().toLowerCase();
}

class UpstashStore {
  constructor(url, token) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }
  async command(...parts) {
    const path = parts.map((p) => encodeURIComponent(String(p))).join("/");
    const res = await fetch(`${this.url}/${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`upstash http ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`upstash: ${data.error}`);
    return data.result;
  }
  async has(ref) {
    return (await this.command("exists", KEY_PREFIX + normalizeRef(ref))) === 1;
  }
  async add(ref) {
    const result = await this.command(
      "set", KEY_PREFIX + normalizeRef(ref), "1", "EX", NONCE_TTL_SECONDS, "NX"
    );
    return result === "OK";
  }
}

class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async has(ref) {
    const k = normalizeRef(ref);
    const exp = this.map.get(k);
    if (exp === undefined) return false;
    if (exp <= Date.now()) {
      this.map.delete(k);
      return false;
    }
    return true;
  }
  async add(ref) {
    const k = normalizeRef(ref);
    if (await this.has(k)) return false;
    this.map.set(k, Date.now() + NONCE_TTL_SECONDS * 1000);
    return true;
  }
}

let storeSingleton = null;
export function getStore() {
  if (storeSingleton) return storeSingleton;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    storeSingleton = new UpstashStore(url, token);
    console.log("[steal] nonce-set backend: Upstash Redis (durable)");
  } else {
    storeSingleton = new MemoryStore();
    console.log("[steal] nonce-set backend: in-memory Map (forgotten on cold start)");
  }
  return storeSingleton;
}
