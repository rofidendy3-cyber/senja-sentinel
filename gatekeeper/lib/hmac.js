import crypto from "node:crypto";

// HMAC over the RAW body bytes, header `x-agent-games-signature`.
// Algorithm assumption: HMAC-SHA256, lowercase hex digest (not specified on
// agentgames.zkverify.io/build — to be confirmed at preflight after registration).
export const SIGNATURE_HEADER = "x-agent-games-signature";

export function hmacHex(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(secret, rawBody, headerValue) {
  if (!secret || !headerValue || typeof headerValue !== "string") return false;
  const expected = hmacHex(secret, rawBody);
  const got = headerValue.trim().toLowerCase().replace(/^sha256=/, "");
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

export function signBody(secret, rawBody) {
  return hmacHex(secret, rawBody);
}
