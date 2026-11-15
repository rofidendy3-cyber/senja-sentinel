// Steal the VFY — committed strategy (circuit vfy-policy, "circuitVersion" v1).
//
// Circuit semantics were reverse-engineered from the official WASM by
// constraint probing (see SPEC_NOTES.md for the full evidence trail):
//
//   strategyParams[8] (private), salt (private)
//   commitment = Poseidon(strategyParams[0..7], salt)   [circomlib Poseidon, 9 inputs]
//   validity: 1 <= p0 <= 10; p3 in {0,1}; strategyParams[4..7] must all be 0.
//   mandated action for a turn state:
//     1. selfBalance < p1                          -> FORTIFY (amount 0)
//     2. p3 == 0 && opponentBalance > p2           -> EXTRACT (amount == p0)
//     3. otherwise                                 -> HOLD    (amount 0)
//
// Our committed strategy — "max pressure, never fortify":
//   p0 = 10  extract the circuit maximum every time (EXTRACT is free).
//   p1 = 0   never FORTIFY: the fortify fee is paid even when unopposed, and a
//            state-triggered fortify can trap the policy into fortifying every
//            remaining turn once the balance dips below the threshold (the
//            balance can never recover while fortifying) — a slow fee bleed
//            that converts draws into losses. Match points ignore margin.
//   p2 = 0   extract whenever the opponent holds anything.
//   p3 = 0   extraction enabled.
// Against a mirror policy every turn nets to zero (draw, +9); against passive
// (HOLD) or fortify-happy opponents the free 10/turn extraction wins outright.
// The commitment is frozen mid-match but may be redeployed BETWEEN rounds, so
// this can be revised after the first played round if resolver data says so.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

export const ACTION = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 };
export const ACTION_NAME = ["HOLD", "FORTIFY", "EXTRACT"];

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function loadStrategyFile() {
  const candidates = [
    path.join(process.cwd(), "data", "strategy.json"),
    path.join(moduleDir, "..", "data", "strategy.json"),
    path.join("/var/task", "data", "strategy.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

let cached = null;

// Strategy source of truth, in priority order:
//  1. env STEAL_STRATEGY_PARAMS ("10,0,0,0,0,0,0,0") + STEAL_STRATEGY_SALT
//  2. data/strategy.json (generated at build time; holds params + salt +
//     the commitment that must be registered on the platform)
export function loadStrategy() {
  if (cached) return cached;
  let params, salt;
  if (process.env.STEAL_STRATEGY_PARAMS && process.env.STEAL_STRATEGY_SALT) {
    params = process.env.STEAL_STRATEGY_PARAMS.split(",").map((x) => BigInt(x.trim()));
    salt = BigInt(process.env.STEAL_STRATEGY_SALT);
  } else {
    const file = loadStrategyFile();
    if (!file) {
      throw new Error(
        "steal strategy not configured: set STEAL_STRATEGY_PARAMS + STEAL_STRATEGY_SALT or provide data/strategy.json"
      );
    }
    params = file.strategyParams.map(BigInt);
    salt = BigInt(file.salt);
  }
  if (params.length !== 8) throw new Error("strategyParams must have exactly 8 elements");
  cached = { params, salt };
  return cached;
}

let poseidonCache = null;
async function poseidon() {
  if (!poseidonCache) poseidonCache = await buildPoseidon();
  return poseidonCache;
}

// commitment = Poseidon(strategyParams[0..7], salt) as a BigInt.
export async function computeCommitment(params, salt) {
  const p = await poseidon();
  return p.F.toObject(p([...params, salt]));
}

export async function ourCommitment() {
  const { params, salt } = loadStrategy();
  return computeCommitment(params, salt);
}

// The circuit-mandated action for a turn state, per the committed strategy.
// state: { selfBalance, opponentBalance } (BigInt-able).
export function decide(state, params) {
  const self = BigInt(state.selfBalance);
  const opp = BigInt(state.opponentBalance);
  const [p0, p1, p2, p3] = params;
  if (self < p1) return { action: ACTION.FORTIFY, amount: 0n };
  if (p3 === 0n && opp > p2) return { action: ACTION.EXTRACT, amount: p0 };
  return { action: ACTION.HOLD, amount: 0n };
}
