// Steal the VFY agent — Vercel Function edition (mirrors the Gatekeeper
// agent's production shape, which the Agent Games platform already accepts).
//
//   POST /api/agent   preflight + Steal turn envelopes
//
// The platform signs every request with HMAC-SHA256 over the RAW body
// (header x-agent-games-signature); the signature is verified BEFORE the
// body is parsed, and every JSON response is signed the same way. The HMAC
// secret comes from the AGENT_GAMES_HMAC_SECRET env var (set it in the
// Vercel project settings — same value as the Gatekeeper project).
//
// Turn responses carry the Groth16 policy proof INLINE (proof +
// public_signals + publicInputsHash), the same pattern the Gatekeeper agent
// uses in production; the on-chain-submission/proofReference variant from
// the build guide is the documented fallback if a practice turn rejects
// inline proofs (see DEPLOY.md).

import { SIGNATURE_HEADER, verifySignature, signBody } from "../lib/hmac.js";
import { handleMessage } from "../lib/handler.js";
import { getStore } from "../lib/store.js";

export const config = { api: { bodyParser: false } };

function sendJson(res, status, bodyText, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(bodyText);
}

function sendSigned(res, status, obj, secret) {
  const body = JSON.stringify(obj);
  sendJson(res, status, body, { [SIGNATURE_HEADER]: signBody(secret, body) });
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const secret = process.env.AGENT_GAMES_HMAC_SECRET;
  if (!secret) {
    console.error("[steal] AGENT_GAMES_HMAC_SECRET is not set");
    sendJson(res, 500, JSON.stringify({ error: "agent misconfigured" }));
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, JSON.stringify({ error: "method not allowed" }));
    return;
  }
  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    sendJson(res, 413, JSON.stringify({ error: String(err?.message || err) }));
    return;
  }
  if (!verifySignature(secret, raw, req.headers[SIGNATURE_HEADER])) {
    sendJson(res, 401, JSON.stringify({ error: "invalid signature" }));
    return;
  }
  let msg;
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    sendJson(res, 400, JSON.stringify({ error: "invalid json" }));
    return;
  }
  try {
    const response = await handleMessage(msg, getStore());
    sendSigned(res, 200, response, secret);
  } catch (err) {
    console.error("[steal] handler error:", err);
    sendSigned(res, 400, { error: "unrecognized message" }, secret);
  }
}
