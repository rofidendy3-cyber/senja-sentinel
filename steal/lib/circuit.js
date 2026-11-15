// vfy-policy circuit plumbing (Groth16 / BN128, artifacts served by the
// platform at /circuits/vfy-policy.wasm + /circuits/vfy-policy_final.zkey;
// vkHash 0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047).
//
// Interface (reverse-engineered from the official WASM; see SPEC_NOTES.md):
//   inputs (17): commitment, matchId, turnNumber, selfBalance,
//     opponentBalance, action (HOLD=0, FORTIFY=1, EXTRACT=2), amount,
//     circuitVersion (=1)  [all public]
//     salt, strategyParams[8]  [private]
//   public signals (9): [policyBindingHash (circuit-computed output),
//     commitment, matchId, turnNumber, selfBalance, opponentBalance,
//     action, amount, circuitVersion]
//
// publicInputsHash (response field, per the /build guide snippet):
//   keccak256 of the 8 ABI-packed 32-byte big-endian fields:
//   commitment, matchId (uuid hex), turn, selfBalance, opponentBalance,
//   action code, amount (0 for HOLD/FORTIFY), circuitVersion number (1).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import sha3 from "js-sha3";
const { keccak256 } = sha3;

export const BN128_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function candidatePaths(file) {
  return [
    path.join(process.cwd(), "circuits", file),
    path.join(process.cwd(), "steal", "circuits", file),
    path.join(moduleDir, "..", "circuits", file),
    path.join("/var/task", "circuits", file),
    path.join("/var/task", "steal", "circuits", file),
  ];
}

const resolvedCache = new Map();
export function artifactPath(file) {
  if (resolvedCache.has(file)) return resolvedCache.get(file);
  const tried = candidatePaths(file);
  for (const p of tried) {
    if (fs.existsSync(p)) {
      resolvedCache.set(file, p);
      return p;
    }
  }
  throw new Error(
    `circuit artifact ${file} not found; tried: ${tried.join(", ")} ` +
      `(is "circuits/**" listed in vercel.json includeFiles?)`
  );
}

export const WASM_PATH = () => artifactPath("vfy-policy.wasm");
export const ZKEY_PATH = () => artifactPath("vfy-policy_final.zkey");
export const VK_PATH = () => artifactPath("vk.json");

let vkCache = null;
export function loadVk() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH(), "utf8"));
  return vkCache;
}

// matchId is a UUID string in the envelope; the circuit and the
// publicInputsHash both encode it as the 128-bit integer of its hex digits.
export function matchIdToField(matchId) {
  return BigInt("0x" + String(matchId).replace(/-/g, "")) % BN128_PRIME;
}

function hex32(v) {
  return BigInt(v).toString(16).padStart(64, "0");
}

// keccak256 of ABI-packed fields, per the official /build snippet.
// fields: { commitment, matchId, turn, selfBalance, opponentBalance, action, amount }
export function publicInputsHash(fields) {
  const packed =
    hex32(fields.commitment) +
    hex32(matchIdToField(fields.matchId)) +
    hex32(fields.turn) +
    hex32(fields.selfBalance) +
    hex32(fields.opponentBalance) +
    hex32(fields.action) +
    hex32(fields.amount) +
    hex32(1); // circuitVersion "v1" -> 1
  return "0x" + keccak256(Buffer.from(packed, "hex"));
}

export function buildCircuitInput({ envelope, action, amount, commitment, strategy }) {
  const state = envelope.state || {};
  return {
    commitment: BigInt(commitment) % BN128_PRIME,
    matchId: matchIdToField(envelope.matchId),
    turnNumber: BigInt(envelope.turn),
    selfBalance: BigInt(state.selfBalance),
    opponentBalance: BigInt(state.opponentBalance),
    action: BigInt(action),
    amount: BigInt(amount),
    circuitVersion: 1n,
    salt: strategy.salt,
    strategyParams: strategy.params,
  };
}

export async function prove(circuitInput) {
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH(),
    ZKEY_PATH()
  );
  return { proof, publicSignals, proveMs: performance.now() - t0 };
}

export async function verifyLocal(proof, publicSignals) {
  const t0 = performance.now();
  const ok = await snarkjs.groth16.verify(loadVk(), publicSignals, proof);
  return { ok, verifyMs: performance.now() - t0 };
}
