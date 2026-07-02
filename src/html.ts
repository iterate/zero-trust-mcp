import type { Integration, PasswordIntegration } from "./integrations/types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function loginPage(integration: Integration, sealedState: string, error?: string): string {
  const fields = (integration as PasswordIntegration).fields
    .map(
      (f) => `
      <label for="${f.name}">${escapeHtml(f.label)}</label>
      <input id="${f.name}" name="${f.name}" type="${f.type}" required autocomplete="${f.type === "password" ? "current-password" : "username"}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect ${escapeHtml(integration.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f4f4f2; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 24px rgba(0,0,0,.08); padding: 2.5rem; width: 22rem; }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  p.sub { color: #666; font-size: .85rem; margin: 0 0 1.5rem; }
  label { display: block; font-size: .8rem; font-weight: 600; margin: 1rem 0 .3rem; }
  input:not([type=hidden]) { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border: 1px solid #ccc; border-radius: 8px; font-size: .95rem; }
  button { margin-top: 1.5rem; width: 100%; padding: .7rem; border: 0; border-radius: 8px; background: #5c8b41; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #4d7536; }
  .error { background: #fdecea; color: #b3261e; border-radius: 8px; padding: .6rem .8rem; font-size: .85rem; margin-bottom: 1rem; }
  .note { color: #888; font-size: .72rem; margin-top: 1.25rem; line-height: 1.4; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; } .card { background: #262626; }
    input:not([type=hidden]) { background: #1a1a1a; border-color: #444; color: #eee; }
    p.sub { color: #aaa; } .note { color: #777; }
  }
</style>
</head>
<body>
<main class="card">
  <h1>Connect your ${escapeHtml(integration.name)} account</h1>
  <p class="sub">An MCP client is requesting access to ${escapeHtml(integration.name)} on your behalf.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/${integration.id}/authorize">
    <input type="hidden" name="state" value="${escapeHtml(sealedState)}" />
    ${fields}
    <button type="submit">Sign in &amp; authorize</button>
  </form>
  <p class="note">Zero-trust: this server stores nothing. Your credentials are verified against ${escapeHtml(
    integration.name,
  )}, then sealed (AES-256-GCM) into tokens that only your MCP client holds.</p>
</main>
</body>
</html>`;
}

export function indexPage(origin: string, integrationIds: string[]): string {
  const rows = integrationIds
    .map((id) => `<li><code>${origin}/${id}/mcp</code></li>`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>zero-trust-mcp</title>
<style>body{font-family:ui-monospace,monospace;max-width:42rem;margin:4rem auto;line-height:1.6;padding:0 1rem}</style></head>
<body>
<h1>zero-trust-mcp</h1>
<p>A fully stateless MCP server. Upstream credentials are sealed into the OAuth tokens held by your MCP client — this server stores nothing.</p>
<p>One MCP endpoint per integration (streamable HTTP, OAuth required):</p>
<ul>
${rows}
</ul>
<p>e.g. <code>claude mcp add --transport http waitrose ${origin}/waitrose/mcp</code></p>
</body></html>`;
}
