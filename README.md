# Senja Sentinel — proof-first safety agent for agentic wallets

Senja Sentinel is the safety pipeline that sits between an autonomous AI agent and two live Binance Agentic Wallets on BNB Smart Chain (Agent ID handles **vallenska** and **valenska**). Its owner hunts free and gas-only NFT and token mints — a niche that is full of traps: unverified contracts presented as verified, fake project sites on free-hosting subdomains, market contracts that burn your token if you list below a floor price, transaction previews that promise one payout and deliver another, and pasted third-party "instructions" that are really attack surface.

The Sentinel's job is not to find opportunities. Its job is to decide what may touch the wallets — and its authority is deliberately asymmetric: it can do exactly one thing without asking the human first, and that is **stop**.

## Who it helps

Small, self-custody wallet owners who use AI agents for on-chain work and cannot afford a single bad signature. Everything the agent is allowed to do is bounded by standing rules the owner set in advance; anything outside those bounds waits for explicit, per-transaction human approval.

## How it works

1. **Screening first.** New opportunities are reported to the human before any claim. Standing authorisation never pre-approves the results of a fresh screening sweep.
2. **Verified contracts only.** Every contract must pass a Sourcify exact-match audit. An unverified contract stops the process; the only exception is an explicit, contract-specific, one-off override in which the human names the unverified status. A general go-ahead is never enough.
3. **Gates by address, never by name.** Eligibility is checked against the real SPACE ID registry contract — identity is a contract address, not a string that a lookalike project can copy.
4. **Domain and hosting checks.** Every project audit includes RDAP domain age and registrar, plus hosting tier. A free-hosting subdomain is treated as a fake-project red flag.
5. **Clean-preview gates.** Every transaction is simulated first. It executes only on a perfectly clean preview: risk fields empty (checked at the inner-collection level), no unexpected allowance or authority changes, expected credit amount only, and no confirmation flag. Anything else is a hard stop.
6. **Hex-level price verification.** Before any NFT listing is signed, the price hex inside the calldata is decoded back — hex to decimal to BNB to USDT — and must match the human-approved price exactly. A mismatch stops the listing.
7. **Realizable value only.** Market value is only ever an executable quote for the full amount being sold, never a spot price. Standing sell rules fire only when net proceeds after marketplace fees, royalties and gas are strictly positive.
8. **Post-transfer verification.** After any transfer, receipt is verified on-chain (`ownerOf`) and at the destination before the move is reported as done.

For first-come-first-served mints, the pipeline pre-arms autonomous snipes that fire preview and execute back-to-back at open, with the clean-preview gates encoded in code — no human round-trip in the race.

## Operating record (proof episodes)

- **The pasted instruction that lied.** A pasted "verified contract" instruction named an unverified contract with an unknown function selector and a third-party signature. The audit caught all three; nothing was signed.
- **The preview that lied.** A claim preview showed a credit of 16,800,000 tokens; the executed draw delivered 8,400,000. Previews are now treated as hints, never as truth — value is only what lands.
- **The paused mine.** A token mining contract was paused on-chain and its price collapsed ~99.5%; the watch detected the paused state from simulation reverts and stopped expecting claims instead of burning gas.
- **The burn line.** One collection's own market burns any token listed below its `floorWei()`. That line is hard-coded into the sell rules for the collection: never list or reprice there automatically.
- **The checker that failed (our own bug).** In one FCFS mint, our gate misread the wallet's clean-preview structure and aborted a clean snipe; the free pool drained to direct-contract bots in under a minute. The gate was rewritten to test the inner risk collections, and the lesson is now a standing rule: an untested gate is a loaded gun pointed at the claim.

## Where zkVerify fits

Today, every gate verdict — "this bytecode matches verified source", "this preview is clean", "this calldata decodes to the approved price" — is a claim made by the same agent that profits from acting on it. The log is written by the actor.

A proof layer like zkVerify changes who has to trust whom: each verdict could be issued as a cheaply verifiable attestation that a judge, a marketplace, or a counterparty can check without trusting the agent — and without the agent revealing its strategy, its watchlists, or its wallet graph. The checker itself becomes checkable. That is the property this system was built around before it had a name: **no proof, no signature**.

## Status

Live and operating daily since October 2026: continuous market watches (30-minute cycles), standing auto-sell rules under the profit gate, FCFS snipes for free mints, and a full audit trail of stops, skips, and failures — including the failures that were our fault.

*Submitted to the zkVerify Agent Games — Wildcard track.*
