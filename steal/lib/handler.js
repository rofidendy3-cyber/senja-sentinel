// Steal the VFY — message handler shared by the local server (src/server.js)
// and the Vercel function (deploy-vercel/api/agent.js).
//
// Handles:
//   - { type: "agent-games.preflight.v1", ... } -> { ok: true, protocolVersion: "v1" }
//   - Steal turn envelopes (eventId "steal-the-vfy", protocolVersion "v1"):
//       verify shape -> decide via the committed strategy -> generate the
//       per-turn policy proof -> schema-valid turn response.
// Failure discipline (event page: "Handle failure gracefully"): a turn is
// NEVER left unanswered. If proving or local verification fails, the handler
// falls back to a HOLD response WITHOUT a policyProof — the platform scores a
// proof-less response as HOLD with no proof (no invalid-proof penalty), which
// strictly dominates submitting a bad proof (-2) or timing out (-1 + HOLD).

import crypto from "node:crypto";
import { loadStrategy, decide, ourCommitment, ACTION, ACTION_NAME } from "./strategy.js";
import { buildCircuitInput, prove, verifyLocal, publicInputsHash } from "./circuit.js";

export function isPreflight(msg) {
  return msg && msg.type === "agent-games.preflight.v1";
}

export function isTurnEnvelope(msg) {
  return (
    msg &&
    msg.eventId === "steal-the-vfy" &&
    typeof msg.matchId === "string" &&
    msg.turn !== undefined &&
    msg.state &&
    msg.strategyCommitment &&
    typeof msg.nonce === "string"
  );
}

function holdResponse(envelope) {
  return {
    matchId: envelope.matchId,
    turn: envelope.turn,
    action: { type: "HOLD" },
    agentTimestamp: new Date().toISOString(),
    idempotencyKey: crypto.randomUUID(),
  };
}

export async function handleTurn(envelope, store) {
  const strategy = loadStrategy();
  const state = envelope.state;

  // The envelope carries the commitment the platform has registered for us.
  // It is authoritative for the circuit input and the publicInputsHash; our
  // stored params+salt must reproduce it (checked here — a mismatch means the
  // registration used different values and every proof would fail at the
  // circuit's commitment assert; the practice turn exists to catch this).
  const envelopeCommitment = BigInt(envelope.strategyCommitment.hash);
  try {
    const ours = await ourCommitment();
    if (ours !== envelopeCommitment) {
      console.error(
        `[steal] COMMITMENT MISMATCH: envelope ${envelopeCommitment} != ours ${ours} — registration/params divergence`
      );
    }
  } catch (err) {
    console.error("[steal] commitment self-check failed:", err);
  }

  if (envelope.deadlineAt && Date.now() > Date.parse(envelope.deadlineAt)) {
    console.error(`[steal] turn envelope already past deadlineAt (${envelope.deadlineAt}) — answering anyway`);
  }

  // Replay bookkeeping: a re-delivered nonce for the same match+turn is a
  // platform retry — answer again (idempotent); the first accepted response
  // is the one that counts.
  if (store && envelope.nonce) {
    try {
      if (await store.has(envelope.nonce)) {
        console.log(`[steal] duplicate nonce ${envelope.nonce} (match ${envelope.matchId} turn ${envelope.turn}) — re-answering`);
      }
    } catch (err) {
      console.error("[steal] nonce has() failed:", err);
    }
  }

  const verdict = decide(state, strategy.params);
  const actionName = ACTION_NAME[verdict.action];

  let response;
  try {
    const circuitInput = buildCircuitInput({
      envelope,
      action: verdict.action,
      amount: verdict.amount,
      commitment: envelopeCommitment,
      strategy,
    });
    const { proof, publicSignals, proveMs } = await prove(circuitInput);
    const { ok, verifyMs } = await verifyLocal(proof, publicSignals);
    if (!ok) throw new Error("local verification of own proof failed");
    const action = { type: actionName };
    if (verdict.action === ACTION.EXTRACT) action.amount = Number(verdict.amount);
    response = {
      matchId: envelope.matchId,
      turn: envelope.turn,
      action,
      policyProof: {
        circuitVersion: "v1",
        proof,
        public_signals: publicSignals,
        publicInputsHash: publicInputsHash({
          commitment: envelopeCommitment,
          matchId: envelope.matchId,
          turn: envelope.turn,
          selfBalance: state.selfBalance,
          opponentBalance: state.opponentBalance,
          action: verdict.action,
          amount: verdict.amount,
        }),
      },
      agentTimestamp: new Date().toISOString(),
      idempotencyKey: crypto.randomUUID(),
    };
    console.log(
      `[steal] turn answered match=${envelope.matchId} turn=${envelope.turn} action=${actionName} proveMs=${Math.round(proveMs)} verifyMs=${Math.round(verifyMs)}`
    );
  } catch (err) {
    console.error(
      `[steal] proof path failed for match ${envelope.matchId} turn ${envelope.turn} (decided ${actionName}):`,
      err
    );
    response = holdResponse(envelope);
  }

  if (store && envelope.nonce) {
    try {
      await store.add(envelope.nonce);
    } catch (err) {
      console.error("[steal] nonce add() failed:", err);
    }
  }
  return response;
}

export async function handleMessage(msg, store) {
  if (isPreflight(msg)) return { ok: true, protocolVersion: "v1" };
  if (isTurnEnvelope(msg)) return handleTurn(msg, store);
  throw new Error("unrecognized message shape");
}
