// Seen-set of proof_tx references (PROOF_REUSED detection) — serverless edition.
//
// Vercel Functions have NO durable disk, so the on-disk JSON seen-set used by
// the local build (src/decision.js SeenSet) cannot work here. Two backends:
//
// 1) Upstash Redis (PREFERRED — required before scored rounds):
//    If env UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, the
//    seen-set lives in Upstash Redis via its REST API (plain fetch, no SDK).
//    Each proof_tx is stored as a key `gk:seen:<ref>` with a 14-day TTL using
//    SET ... NX (set-if-not-exists), so the memory survives cold starts,
//    redeploys and parallel instances. Upstash has a free tier; it can be
//    added later from the Vercel Marketplace (see DEPLOY.md) — no code change
//    is needed, only the two env vars + a redeploy.
//
// 2) In-memory fallback (practice only):
//    If the Upstash env vars are absent, a module-level Map is used. It is
//    shared across invocations of the SAME warm function instance, but a cold
//    start (new instance, redeploy, scale-to-zero) FORGETS everything — a
//    reused proof_tx could then be misjudged as fresh (wrong APPROVE = -6,
//    and a proof generated for a task the circuit would only approve).
//    Acceptable while practising; MUST be fixed (backend 1) before scored
//    rounds. This is also printed to the function log on cold start.

export const SEEN_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

export function normalizeRef(v) {
  return String(v ?? "").trim().toLowerCase();
}

const KEY_PREFIX = "gk:seen:";

class UpstashStore {
  constructor(url, token) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  async command(...parts) {
    // Upstash REST: GET {url}/{command}/{arg1}/{arg2}... with Bearer auth.
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
    const result = await this.command("exists", KEY_PREFIX + normalizeRef(ref));
    return result === 1;
  }

  // Set-if-not-exists with TTL. Returns true if this call created the entry.
  async add(ref) {
    const result = await this.command(
      "set", KEY_PREFIX + normalizeRef(ref), "1",
      "EX", SEEN_TTL_SECONDS, "NX"
    );
    return result === "OK";
  }
}

class MemoryStore {
  constructor() {
    this.map = new Map(); // ref -> expiresAt (ms epoch)
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
    this.map.set(k, Date.now() + SEEN_TTL_SECONDS * 1000);
    return true;
  }

  get size() {
    return this.map.size;
  }
}

let storeSingleton = null;

// Returns the process-wide store. Backend selection happens once per cold
// start, based on env. Both backends expose async has(ref) / add(ref) with
// the same contract as the local SeenSet (has = seen in a PREVIOUS task).
export function getStore() {
  if (storeSingleton) return storeSingleton;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    storeSingleton = new UpstashStore(url, token);
    console.log("[gatekeeper] seen-set backend: Upstash Redis (durable)");
  } else {
    storeSingleton = new MemoryStore();
    console.log(
      "[gatekeeper] seen-set backend: in-memory Map (WARNING: forgotten on cold start — practice only, add Upstash before scored rounds)"
    );
  }
  return storeSingleton;
}
