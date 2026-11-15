import { normalizeRef } from "./store.js";

// The 7-case deterministic decision engine — identical logic and check order
// to the local build (src/decision.js), adapted only so the seen-set lookup
// is awaited (the serverless store in lib/store.js is async: Upstash REST or
// an in-memory Map; awaiting a plain value would also work).
//
// Check order: field traps first (these are what the circuit enforces and what
// a generated proof can attest), then reuse (answered WITHOUT a proof, per the
// event page: PROOF_REUSED tasks "have no proof to submit and are excluded").
// Tasks are single-trap by design (documented frequencies sum to ~100%), so
// precedence between traps should not matter in practice.
// Returns { decision, reason_code, provable } where provable=false means the
// response must NOT carry a Groth16 proof (PROOF_REUSED only).

function hexEq(a, b) {
  // Compare two hex-ish values as integers when possible (robust to case /
  // leading zeros); fall back to normalized string equality.
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return normalizeRef(a) === normalizeRef(b);
  }
}

function toBig(v) {
  return BigInt(v);
}

// The seen-set lookup must NEVER kill a task: if the store backend errors
// (bad credentials, outage), treat the reference as unseen and log loudly.
// A missed reuse costs one task; a thrown error would fail EVERY valid task
// (~50% of a round). Learned the hard way in practice, 2026-11-15: an invalid
// Upstash token made every VALID_CONDITION task return INTERNAL_ERROR, while
// field-trap tasks (which never reach this check) kept passing.
async function hasSeen(store, ref) {
  try {
    return await store.has(ref);
  } catch (err) {
    console.error("[gatekeeper] seen-set has() failed — treating as unseen:", err);
    return false;
  }
}

export async function decide(input, store) {
  const {
    registered_vk, proof_vk, minimum, public_balance,
    expiry_block, current_block, recipient, condition_recipient,
    amount, max_transfer, proof_tx,
  } = input;

  let verdict = null;
  if (!hexEq(proof_vk, registered_vk)) {
    verdict = { decision: "REJECT", reason_code: "VK_SUBSTITUTION", provable: true };
  } else if (toBig(public_balance) < toBig(minimum)) {
    verdict = { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH", provable: true };
  } else if (toBig(current_block) > toBig(expiry_block)) {
    verdict = { decision: "REJECT", reason_code: "EXPIRED_CONDITION", provable: true };
  } else if (!hexEq(recipient, condition_recipient)) {
    verdict = { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH", provable: true };
  } else if (toBig(amount) > toBig(max_transfer)) {
    verdict = { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW", provable: true };
  } else if (store && proof_tx !== undefined && (await hasSeen(store, proof_tx))) {
    verdict = { decision: "REJECT", reason_code: "PROOF_REUSED", provable: false };
  } else {
    verdict = { decision: "APPROVE", reason_code: "VALID_CONDITION", provable: true };
  }
  return verdict;
}
