// Generate a public PKCE client record. An administrator installs it in OAUTH_KV.
const [clientId, ...redirectUris] = process.argv.slice(2);
if (!clientId || !/^[a-zA-Z0-9_-]{1,120}$/.test(clientId) || redirectUris.length < 1 || redirectUris.length > 5) {
  throw new Error("Usage: node scripts/create-mcp-client.mjs <client-id> <redirect-uri> [redirect-uri...]");
}
for (const value of redirectUris) {
  const uri = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname);
  if (uri.username || uri.password || uri.hash ||
      (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopback))) {
    throw new Error("Redirect URIs must use HTTPS or a local loopback HTTP address");
  }
}
process.stdout.write(JSON.stringify({
  clientId, clientName: clientId, redirectUris,
  tokenEndpointAuthMethod: "none", authMethodExplicit: true,
  grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"],
  registrationDate: Math.floor(Date.now() / 1000),
}, null, 2) + "\n");
