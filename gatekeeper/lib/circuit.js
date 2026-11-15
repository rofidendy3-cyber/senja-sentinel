import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

// Circuit interface (reverse-engineered from the published WASM; see
// SPEC_NOTES.md in the parent project): 13 public inputs: taskId,
// registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
// currentBlock, recipient, conditionRecipient, amount, maxTransfer,
// decision (APPROVE=1, REJECT=0), salt. The circuit ENFORCES decision ==
// correct verdict over the field checks; proof reuse is not visible to it.

export const BN128_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// --- Artifact path resolution ---------------------------------------------
// The circuit artifacts live in <package>/circuits/ and are bundled into the
// function via `includeFiles` in vercel.json. Depending on the Vercel Root
// Directory setting and the local test setup, the runtime working directory
// differs, so we probe several candidate locations and use the first that
// exists on disk. Resolution is cached after the first successful lookup.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function candidatePaths(file) {
  return [
    path.join(process.cwd(), "circuits", file),
    path.join(process.cwd(), "gatekeeper", "circuits", file),
    path.join(moduleDir, "..", "circuits", file),
    path.join("/var/task", "circuits", file),
    path.join("/var/task", "gatekeeper", "circuits", file),
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

export const WASM_PATH = () => artifactPath("gatekeeper.wasm");
export const ZKEY_PATH = () => artifactPath("gatekeeper_final.zkey");
export const VK_PATH = () => artifactPath("vk.json");

let vkCache = null;
export function loadVk() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH(), "utf8"));
  return vkCache;
}

export function fieldFromHexOrDecimal(v) {
  return BigInt(v) % BN128_PRIME;
}

// Deterministic string -> field element: UTF-8 bytes, big-endian, mod p.
// CONVENTION (ours): used for taskId, whose envelope form is a string like
// "gk_24_9d1". The circuit treats taskId as an opaque binder, so any
// deterministic encoding satisfies the constraints; whether the platform
// cross-checks this public signal is a practice-phase unknown (see SPEC_NOTES).
export function fieldFromString(s) {
  const bytes = Buffer.from(String(s), "utf8");
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) + BigInt(b);
  return acc % BN128_PRIME;
}

export function buildCircuitInput(task, decision /* "APPROVE" | "REJECT" */) {
  const input = task.input;
  return {
    taskId: fieldFromString(task.task_id),
    registeredVkHash: fieldFromHexOrDecimal(input.registered_vk),
    proofVkHash: fieldFromHexOrDecimal(input.proof_vk),
    minimum: BigInt(input.minimum),
    publicBalance: BigInt(input.public_balance),
    expiryBlock: BigInt(input.expiry_block),
    currentBlock: BigInt(input.current_block),
    recipient: fieldFromHexOrDecimal(input.recipient),
    conditionRecipient: fieldFromHexOrDecimal(input.condition_recipient),
    amount: BigInt(input.amount),
    maxTransfer: BigInt(input.max_transfer),
    decision: decision === "APPROVE" ? 1n : 0n,
    // CONVENTION (ours): salt binds the decision proof to the task's proof
    // reference. If real envelopes carry an explicit input.salt, prefer it.
    salt:
      input.salt !== undefined
        ? BigInt(input.salt) % BN128_PRIME
        : fieldFromHexOrDecimal(input.proof_tx),
  };
}

export async function prove(circuitInput) {
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH(),
    ZKEY_PATH()
  );
  const proveMs = performance.now() - t0;
  return { proof, publicSignals, proveMs };
}

export async function verifyLocal(proof, publicSignals) {
  const t0 = performance.now();
  const ok = await snarkjs.groth16.verify(loadVk(), publicSignals, proof);
  return { ok, verifyMs: performance.now() - t0 };
}
