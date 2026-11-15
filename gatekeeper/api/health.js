// Proof Gatekeeper agent — health check (GET /api/health).
// The platform pings this to confirm the endpoint is alive.
export default function handler(req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "proof-gatekeeper" }));
}
