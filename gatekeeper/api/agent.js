// Proof Gatekeeper agent — Vercel Function edition (POST /api/agent).
//
// Behaviour is identical to the proven local service (src/server.js):
//  - HMAC (header `x-agent-games-signature`) is verified over the RAW request
//    body BEFORE any JSON parsing; mismatches get a plain 401.
//  - "agent-games.preflight.v1"      -> signed { ok: true, protocolVersion: "v1" }
//  - "agent-games.proof-gatekeeper.v1" -> 7-case decision (lib/decision.js);
//    provable verdicts carry an inline snarkjs Groth16 proof; PROOF_REUSED is
//    answered WITHOUT a proof (excluded by the event design). The proof_tx is
//    recorded in the seen-set (lib/store.js) only AFTER the decision.
//  - Anything unexpected fails CLOSED with a signed REJECT.
//
// The proof is returned inline only — this package never submits on-chain
// (the equivalent of SUBMIT_MODE=off in the local build; see DEPLOY.md).
//
// The HMAC secret comes from env AGENT_GAMES_HMAC_SECRET. There is NO dev
// placeholder fallback: if the env var is missing the function returns 500
// with a clear error instead of silently signing with a wrong secret.

import { SIGNATURE_HEADER, verifySignature, signBody } from "../lib/hmac.js";
import { decide } from "../lib/decision.js";
import { buildCircuitInput, prove } from "../lib/circuit.js";
import { getStore } from "../lib/store.js";

// Vercel must NOT pre-parse the body: the HMAC is computed over raw bytes.
export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res, status, bodyText, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(bodyText);
}

function sendSigned(res, secret, status, obj) {
  const body = JSON.stringify(obj);
  sendJson(res, status, body, { [SIGNATURE_HEADER]: signBody(secret, body) });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy?.();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleTask(secret, store, task) {
  const input = task.input || {};
  const verdict = await decide(input, store);
  const response = {
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    proof_tx: input.proof_tx, // optional on-chain audit pointer (echo of the task's reference)
  };
  if (verdict.provable) {
    const circuitInput = buildCircuitInput(task, verdict.decision);
    const { proof, publicSignals, proveMs } = await prove(circuitInput);
    response.proof = proof;
    response.public_signals = publicSignals;
    response.meta = { proveMs: Math.round(proveMs) };
  }
  // Record the reference as seen AFTER deciding (reuse = seen in a PREVIOUS task).
  if (input.proof_tx !== undefined) {
    try {
      await store.add(input.proof_tx);
    } catch (err) {
      // A store write failure must not fail the task response; worst case a
      // later reuse is missed. Log loudly — visible in Vercel function logs.
      console.error("[gatekeeper] seen-set add failed:", err);
    }
  }
  return response;
}

export default async function handler(req, res) {
  const secret = process.env.AGENT_GAMES_HMAC_SECRET;
  if (!secret) {
    sendJson(res, 500, JSON.stringify({
      error: "AGENT_GAMES_HMAC_SECRET is not set — configure it in the Vercel project env vars (value: the agent secret from the Agent Games dashboard)",
    }));
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 404, JSON.stringify({ error: "not found" }));
    return;
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    sendJson(res, 413, JSON.stringify({ error: "request body too large" }));
    return;
  }

  // 1) Verify HMAC over the RAW body BEFORE parsing (spec requirement).
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
    // 2) Preflight handshake.
    if (msg.type === "agent-games.preflight.v1") {
      sendSigned(res, secret, 200, { ok: true, protocolVersion: "v1" });
      return;
    }
    // 3) Gatekeeper task. Fail closed on any unexpected shape.
    if (msg.type === "agent-games.proof-gatekeeper.v1" && msg.input) {
      const response = await handleTask(secret, getStore(), msg);
      sendSigned(res, secret, 200, response);
      return;
    }
    sendSigned(res, secret, 400, { decision: "REJECT", reason_code: "INTERNAL_ERROR" });
  } catch (err) {
    // Fail closed: a signed REJECT beats a timeout.
    console.error("[gatekeeper] task handling error:", err);
    sendSigned(res, secret, 200, {
      decision: "REJECT",
      reason_code: "INTERNAL_ERROR",
      proof_tx: msg?.input?.proof_tx,
    });
  }
}
