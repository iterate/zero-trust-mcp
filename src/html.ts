import type {
  Integration,
  IntegrationPresentation,
  PasswordIntegration,
  UserClientOAuthIntegration,
} from "./integrations/types.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";

const DEFAULT_COLORS = {
  background: "#f4f4f2",
  ink: "#172033",
  accent: "#315f4a",
  accentInk: "#ffffff",
  subtle: "#eef2ef",
};

function presentationFor(integration: Integration): Required<Pick<IntegrationPresentation, "productLabel">> & IntegrationPresentation {
  return {
    productLabel: "Zero Trust MCP",
    ...integration.presentation,
    colors: { ...DEFAULT_COLORS, ...integration.presentation?.colors },
  };
}

function brandMarkup(integration: Integration): string {
  const presentation = presentationFor(integration);
  if (!presentation.logoSvg && !presentation.wordmark) return "";
  return `<div class="brand" aria-label="${escapeHtml(integration.name)} and Zero Trust MCP">
    ${presentation.logoSvg ?? ""}
    ${presentation.wordmark ? `<span class="wordmark">${escapeHtml(presentation.wordmark)}</span>` : ""}
    <span class="product">${escapeHtml(presentation.productLabel)}</span>
  </div>`;
}

function resolvePlaceholders(value: string, origin: string, id: string): string {
  return value.replaceAll("{origin}", origin).replaceAll("{id}", id);
}

/** Setup guide description and steps, shared by the authorize and index pages. */
function setupGuideBody(integration: Pick<Integration, "id" | "presentation">, origin: string): string {
  const guide = integration.presentation?.setupGuide;
  if (!guide) return "";
  const markdown = (text: string) => renderMarkdown(resolvePlaceholders(text, origin, integration.id));
  const steps = guide.steps.map((step) => {
    const settings = step.settings?.length
      ? `<div class="settings">${step.settings.map((setting) => {
          const value = resolvePlaceholders(setting.value, origin, integration.id);
          const copy = setting.copy
            ? `<button class="setting-copy" type="button" data-copy="${escapeHtml(value)}" aria-label="Copy ${escapeHtml(setting.label)}">copy</button>`
            : "";
          return `<div class="setting"><div><span class="setting-label">${escapeHtml(setting.label)}</span><span class="setting-value">${escapeHtml(value)}</span></div>${copy}</div>`;
        }).join("")}</div>`
      : "";
    return `<li class="guide-step"><h3>${escapeHtml(step.title)}</h3><div class="md">${markdown(step.description)}</div>${settings}</li>`;
  }).join("");
  return `<div class="md guide-description">${markdown(guide.description)}</div><ol class="guide-steps">${steps}</ol>`;
}

/** Clipboard helper plus a delegated handler for every [data-copy] button. */
const COPY_SCRIPT = `
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = text;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      return copied;
    }
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest && event.target.closest("[data-copy]");
    if (!button) return;
    const copied = await copyText(button.dataset.copy);
    button.textContent = copied ? "copied" : "select";
    setTimeout(() => { button.textContent = "copy"; }, 1600);
  });`;

function documentStart(integration: Integration, title: string, wide = false): string {
  const presentation = presentationFor(integration);
  const colors = presentation.colors!;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --page: ${escapeHtml(colors.background)};
    --ink: ${escapeHtml(colors.ink)};
    --accent: ${escapeHtml(colors.accent)};
    --accent-ink: ${escapeHtml(colors.accentInk)};
    --subtle: ${escapeHtml(colors.subtle)};
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.25rem; background: var(--page); color: var(--ink); }
  .card { background: #fff; width: min(25rem, 100%); padding: 2rem; border: 1px solid rgba(20,35,60,.10); border-radius: 18px; box-shadow: 0 18px 50px rgba(20,35,60,.10); }
  .brand { display: flex; align-items: center; gap: .7rem; margin-bottom: 2.2rem; }
  .brand svg { width: auto; max-width: 8.625rem; height: 1.5rem; flex: none; }
  .wordmark { font-size: 1.35rem; font-weight: 760; letter-spacing: -.055em; }
  .product { margin-left: auto; color: #667085; font-size: .68rem; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }
  .eyebrow { color: #667085; font-size: .7rem; font-weight: 700; letter-spacing: .08em; margin: 0 0 .7rem; text-transform: uppercase; }
  h1 { font-size: 1.75rem; line-height: 1.08; letter-spacing: -.045em; margin: 0 0 .65rem; }
  p.sub { color: #526071; font-size: .9rem; line-height: 1.5; margin: 0 0 1.6rem; }
  label { display: block; color: #26364d; font-size: .76rem; font-weight: 650; margin: 1rem 0 .3rem; }
  input:not([type=hidden]) { width: 100%; background: #fff; color: var(--ink); border: 1px solid #bdc7c3; border-radius: 10px; padding: .72rem .8rem; outline: none; font-size: .95rem; transition: border-color .15s, box-shadow .15s; }
  input:not([type=hidden]):focus { border-color: var(--ink); box-shadow: 0 0 0 3px rgba(20,35,60,.10); }
  button, .button { display: block; width: 100%; margin-top: 1.35rem; padding: .82rem; border: 0; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 750; text-align: center; text-decoration: none; cursor: pointer; }
  button:hover, .button:hover { filter: brightness(1.06); }
  .error { background: #fdecea; color: #b3261e; border-radius: 8px; padding: .6rem .8rem; font-size: .85rem; margin-bottom: 1rem; }
  .security-note { display: flex; gap: .65rem; align-items: flex-start; background: var(--subtle); border-radius: 11px; padding: .8rem .9rem; color: #31565b; font-size: .75rem; line-height: 1.45; margin-top: 1rem; }
  .security-note b { color: var(--ink); }
  .note { color: #707b88; font-size: .72rem; line-height: 1.45; text-align: center; margin: 1.25rem 0 0; }
  .affiliation-note { color: #707b88; font-size: .68rem; line-height: 1.45; text-align: center; margin: .65rem 0 0; }
  .status { display: flex; align-items: center; gap: .55rem; color: #526071; font-size: .78rem; margin-top: 1rem; }
  .pulse { width: .55rem; height: .55rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 40%, transparent); animation: pulse 1.8s infinite; }
  .check { display: grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: 50%; background: var(--subtle); color: var(--ink); font-size: 1.25rem; margin-bottom: 1.15rem; }
  @keyframes pulse { 70% { box-shadow: 0 0 0 .45rem transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  .card.wide { width: min(33rem, 100%); }
  .setup { margin: 0 0 1.4rem; border: 1px solid rgba(20,35,60,.10); border-radius: 12px; }
  .setup summary { display: flex; justify-content: space-between; gap: 1rem; padding: .85rem 1rem; cursor: pointer; font-size: .86rem; font-weight: 700; list-style: none; }
  .setup summary::-webkit-details-marker { display: none; }
  .setup summary::after { content: "+"; color: #667085; font-weight: 500; }
  .setup[open] summary::after { content: "−"; }
  .setup-body { padding: 0 1rem 1rem; color: #3f4a56; font-size: .8rem; line-height: 1.5; }
  .md p { margin: 0; }
  .md p + p, .md ul { margin: .45rem 0 0; }
  .md ul { padding-left: 1.1rem; }
  .md a, .portal-link { color: var(--ink); font-weight: 650; text-decoration-thickness: 1px; text-underline-offset: .15em; }
  .md code { padding: .05rem .25rem; border-radius: 4px; background: var(--subtle); font: 500 .72rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .guide-steps { display: grid; gap: 1rem; margin: 1rem 0 0; padding: 0; list-style: none; counter-reset: setup-step; }
  .guide-step { position: relative; padding-left: 1.85rem; counter-increment: setup-step; }
  .guide-step::before { content: counter(setup-step); position: absolute; left: 0; top: .05rem; display: grid; place-items: center; width: 1.3rem; height: 1.3rem; border-radius: 50%; background: var(--subtle); color: var(--ink); font: 700 .66rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .guide-step h3 { margin: 0 0 .2rem; color: var(--ink); font-size: .84rem; }
  .settings { display: grid; gap: .6rem; margin-top: .6rem; padding: .7rem .8rem; border-radius: 9px; background: var(--subtle); }
  .setting { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .6rem; align-items: center; }
  .setting-label { display: block; color: #667085; font: 700 .6rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; text-transform: uppercase; }
  .setting-value { display: block; color: var(--ink); font: 500 .72rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: break-word; }
  .settings .setting-copy { display: inline-block; width: auto; margin: 0; padding: .28rem .5rem; border: 1px solid rgba(20,35,60,.14); border-radius: 6px; background: #fff; color: #526071; font: 700 .62rem ui-monospace, SFMono-Regular, Menlo, monospace; }
  .portal-link { display: inline-block; margin-top: 1rem; font-size: .8rem; }
  @media (max-width: 480px) {
    body { padding: .75rem; }
    .card { padding: 1.5rem 1.1rem; }
    .setup summary { padding: .8rem; }
    .setup-body { padding: 0 .8rem .9rem; }
    .guide-step { padding-left: 1.6rem; }
    .settings { padding: .65rem; }
  }
</style>
</head>
<body>
<main class="card${wide ? " wide" : ""}">
  ${brandMarkup(integration)}`;
}

function securityNote(integration: Integration): string {
  const summary = integration.presentation?.securitySummary;
  if (!summary) return "";
  return `<div class="security-note"><span aria-hidden="true">↳</span><span>${escapeHtml(summary)}</span></div>`;
}

function affiliationNote(integration: Integration): string {
  const notice = integration.presentation?.affiliationNotice;
  return notice ? `<p class="affiliation-note">${escapeHtml(notice)}</p>` : "";
}

function documentEnd(): string {
  return `</main></body></html>`;
}

export function loginPage(integration: Integration, origin: string, sealedState: string, error?: string): string {
  const credentialIntegration = integration as PasswordIntegration | UserClientOAuthIntegration;
  const isUserClientOAuth = integration.kind === "user-client-oauth";
  const fields = credentialIntegration.fields
    .map(
      (field) => `
      <label for="${field.name}">${escapeHtml(field.label)}</label>
      <input id="${field.name}" name="${field.name}" type="${field.type}" required autocomplete="${
        isUserClientOAuth ? "off" : field.type === "password" ? "current-password" : "username"
      }" />`,
    )
    .join("\n");
  const description = integration.presentation?.setupDescription ?? (
    isUserClientOAuth
      ? `Enter the confidential OAuth client you created in the ${integration.name} developer portal.`
      : `An MCP client is requesting access to ${integration.name} on your behalf.`
  );

  const guide = integration.presentation?.setupGuide;
  // Open by default for first-time setup; a collapse is remembered per provider.
  const setup = guide
    ? `<details class="setup" open data-setup="${escapeHtml(integration.id)}">
    <summary>${escapeHtml(guide.title)}</summary>
    <div class="setup-body">
      ${setupGuideBody(integration, origin)}
      <a class="portal-link" href="${escapeHtml(guide.actionUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(guide.actionLabel)} ↗</a>
    </div>
  </details>
  <script>
    ${COPY_SCRIPT}
    (function () {
      var setup = document.querySelector("details.setup");
      var key = "setup-collapsed:" + setup.dataset.setup;
      try { if (localStorage.getItem(key) === "1") setup.open = false; } catch (e) {}
      setup.addEventListener("toggle", function () { try { localStorage.setItem(key, setup.open ? "0" : "1"); } catch (e) {} });
    })();
  </script>`
    : "";

  return `${documentStart(integration, `Connect ${integration.name}`, Boolean(guide))}
  <h1>${isUserClientOAuth ? `Connect ${escapeHtml(integration.name)}` : `Connect your ${escapeHtml(integration.name)} account`}</h1>
  <p class="sub">${escapeHtml(description)}</p>
  ${setup}
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/${integration.id}/authorize">
    <input type="hidden" name="state" value="${escapeHtml(sealedState)}" />
    ${fields}
    <button type="submit">${isUserClientOAuth ? `Continue to ${escapeHtml(integration.name)}` : "Sign in &amp; authorize"}</button>
  </form>
  ${securityNote(integration)}
  <p class="note">Zero Trust MCP does not persist upstream credentials or tokens.</p>
  ${affiliationNote(integration)}
${documentEnd()}`;
}

export interface ConnectionPageOptions {
  phase: "instruction" | "pending" | "ready";
  handoff?: string;
  returnUrl?: string;
}

export function connectionPage(integration: Integration, options: ConnectionPageOptions): string {
  const flow = integration.connectionFlow;
  if (!flow) throw new Error(`Integration ${integration.id} has no connection flow`);
  const pending = options.phase !== "ready";
  const title = options.phase === "instruction"
    ? flow.instructionTitle
    : options.phase === "pending"
      ? flow.pendingTitle
      : flow.readyTitle;
  const description = options.phase === "instruction"
    ? flow.instructionDescription
    : options.phase === "pending"
      ? flow.pendingDescription
      : flow.readyDescription;

  return `${documentStart(integration, title)}
  ${pending ? `<p class="eyebrow">One last step</p>` : `<div class="check" aria-hidden="true">✓</div>`}
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${escapeHtml(description)}</p>
  ${
    pending
      ? `<form id="connection-check" method="post" action="/${integration.id}/complete">
    <input type="hidden" name="handoff" value="${escapeHtml(options.handoff ?? "")}" />
    <button type="submit">${escapeHtml(flow.checkLabel)}</button>
  </form>
  <div class="status"><span class="pulse" aria-hidden="true"></span><span>Checking securely—this page will update automatically.</span></div>
  <script>setTimeout(function () { var form = document.getElementById("connection-check"); if (form && document.visibilityState === "visible") form.requestSubmit(); }, 2500);</script>`
      : `<a class="button" href="${escapeHtml(options.returnUrl ?? "")}" target="_blank" rel="noopener">${escapeHtml(flow.returnLabel)}</a>
  <p class="note">The connection is ready. The button finishes the OAuth handoff in your MCP client; you can then close this page.</p>`
  }
  ${securityNote(integration)}
  ${affiliationNote(integration)}
${documentEnd()}`;
}

export function indexPage(
  origin: string,
  integrations: Array<Pick<Integration, "id" | "name" | "presentation">>,
): string {
  const catalog = integrations.map((integration) => {
    const guide = integration.presentation?.setupGuide;
    return {
      id: integration.id,
      name: integration.name,
      endpoint: `${origin}/${integration.id}/mcp`,
      affiliationNotice: integration.presentation?.affiliationNotice,
      setupGuide: guide
        ? { title: guide.title, actionLabel: guide.actionLabel, actionUrl: guide.actionUrl, html: setupGuideBody(integration, origin) }
        : undefined,
    };
  });
  const catalogJson = JSON.stringify(catalog).replace(/</g, "\\u003c");
  const providers = catalog
    .map(
      ({ id, name }, index) => `<button class="provider${index === 0 ? " selected" : ""}" type="button" data-provider="${escapeHtml(id)}" aria-pressed="${index === 0}"><span>${escapeHtml(name)}</span><small>/${escapeHtml(id)}/mcp</small></button>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>Zero Trust MCP</title>
<meta name="description" content="MCP servers for third-party APIs that do not provide one." />
<style>
  :root { --ink:#162238; --muted:#67717d; --paper:#fbfbf8; --panel:#f0f1ed; --white:#fff; --accent:#e84d5b; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:ui-serif,Georgia,Cambria,"Times New Roman",serif; }
  a { color:inherit; text-decoration-thickness:1px; text-underline-offset:.16em; }
  button { font:inherit; }
  .shell { width:min(68rem,calc(100% - 2.5rem)); margin:auto; padding:1.5rem 0 4rem; }
  header { display:flex; align-items:center; justify-content:space-between; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.72rem; }
  .brand { font-weight:700; letter-spacing:.02em; }
  .source { display:inline-flex; align-items:center; gap:.45rem; color:var(--muted); }
  .source svg { width:1rem; height:1rem; }
  .top-panels { display:grid; grid-template-columns:1fr 1fr; gap:.75rem; margin:2rem 0 5rem; }
  .explainer { align-self:start; padding:.85rem 1rem; border-radius:.55rem; background:var(--panel); }
  .explainer summary { display:flex; align-items:center; justify-content:space-between; gap:1rem; cursor:pointer; color:#354050; font:700 .7rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; list-style:none; }
  .explainer summary::-webkit-details-marker { display:none; }
  .explainer summary::after { content:"+"; color:var(--muted); font-size:.9rem; font-weight:500; }
  .explainer[open] summary::after { content:"−"; }
  .explainer-copy { max-width:46rem; margin:.85rem 0 .2rem; color:#3f4a56; font-size:.83rem; line-height:1.55; }
  .explainer-copy p { margin:.55rem 0 0; }
  .compact-flow { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .6rem; margin:.8rem 0 .35rem; }
  .compact-flow strong { font-size:.78rem; }
  .compact-flow span { color:var(--accent); font:700 .72rem ui-monospace,SFMono-Regular,Menlo,monospace; }
  h1 { max-width:50rem; margin:0; font-size:clamp(2.75rem,6.4vw,4.9rem); font-weight:500; line-height:1.03; letter-spacing:-.02em; text-wrap:balance; }
  .thesis { max-width:40rem; margin:1.25rem 0 4.5rem; color:#3f4a56; font-size:1.02rem; line-height:1.6; }
  .provider-browser { display:grid; grid-template-columns:11rem minmax(0,1fr); gap:3.5rem; align-items:start; }
  .provider-list { position:sticky; top:1rem; display:flex; flex-direction:column; gap:.35rem; }
  .provider { position:relative; width:100%; padding:.7rem .8rem .7rem 1.35rem; border:0; border-radius:.5rem; background:transparent; color:var(--muted); cursor:pointer; text-align:left; }
  .provider::before { content:""; position:absolute; left:.65rem; top:50%; width:.32rem; height:.32rem; border-radius:50%; background:transparent; transform:translateY(-50%); }
  .provider span { display:block; font-size:1rem; }
  .provider small { display:block; margin-top:.15rem; font:500 .6rem ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.7; }
  .provider:hover { color:var(--ink); background:color-mix(in srgb,var(--panel) 65%,transparent); }
  .provider.selected { color:var(--ink); background:var(--white); box-shadow:0 1px 8px rgba(22,34,56,.06); }
  .provider.selected::before { background:var(--accent); }
  .add-provider { margin:.65rem 0 0 1.35rem; color:var(--muted); font:700 .66rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .provider-detail { min-width:0; min-height:38rem; }
  .provider-head { display:flex; align-items:flex-start; justify-content:space-between; gap:1.5rem; margin-bottom:1.7rem; }
  .provider-head h2 { margin:0; font-size:2rem; font-weight:500; letter-spacing:-.025em; }
  .endpoint { max-width:60%; margin:.35rem 0 0; color:var(--muted); font:500 .65rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; text-align:right; }
  .tabs { display:flex; flex-wrap:wrap; gap:.25rem; width:max-content; max-width:100%; padding:.25rem; border-radius:.55rem; background:var(--panel); }
  .tab { flex:none; padding:.42rem .68rem; border:0; border-radius:.38rem; background:none; color:var(--muted); cursor:pointer; font-size:.76rem; }
  .tab:hover,.tab.selected { color:var(--ink); background:var(--white); box-shadow:0 1px 4px rgba(22,34,56,.06); }
  .example-copy { margin:1.25rem 0 .55rem; color:var(--muted); font-size:.84rem; }
  .provider-note { margin:.75rem 0 0; color:var(--muted); font:500 .64rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .command { position:relative; padding:1rem 4.4rem 1rem 1rem; border-radius:.55rem; background:#eef0ec; overflow:auto; }
  pre { margin:0; font:500 .75rem/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre; }
  .copy { position:absolute; top:.7rem; right:.8rem; padding:.35rem .45rem; border:0; border-radius:.3rem; background:var(--white); color:var(--muted); font:700 .64rem ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; }
  .copy:hover { color:var(--ink); }
  .guide[hidden] { display:none; }
  .guide { margin-top:3.5rem; }
  .guide-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:.4rem 2rem; }
  .guide-head h2 { margin:0; font-size:1.55rem; font-weight:500; letter-spacing:-.025em; }
  .guide-description { max-width:44rem; margin:.35rem 0 0; color:var(--muted); font-size:.85rem; }
  .md p { margin:0; }
  .md p + p, .md ul { margin:.45rem 0 0; }
  .md ul { padding-left:1.1rem; }
  .md code { padding:.05rem .25rem; border-radius:.25rem; background:var(--panel); font:500 .72rem ui-monospace,SFMono-Regular,Menlo,monospace; }
  .portal-button { font:700 .72rem ui-monospace,SFMono-Regular,Menlo,monospace; }
  .guide-steps { display:grid; gap:1.35rem; margin:1.8rem 0 0; padding:0; list-style:none; counter-reset:setup-step; }
  .guide-step { display:grid; grid-template-columns:1.5rem minmax(8rem,10rem) minmax(0,1fr); gap:1rem; counter-increment:setup-step; }
  .guide-step::before { display:grid; place-items:center; align-self:start; width:1.35rem; height:1.35rem; border-radius:50%; background:color-mix(in srgb,var(--accent) 12%,transparent); content:counter(setup-step); color:var(--accent); font:700 .65rem ui-monospace,SFMono-Regular,Menlo,monospace; }
  .guide-step h3 { margin:.15rem 0 0; font-size:.9rem; }
  .guide-step > .md { margin:.12rem 0 0; color:var(--muted); font-size:.82rem; line-height:1.45; }
  .settings { grid-column:3; display:grid; gap:.65rem; margin-top:.25rem; padding:.75rem .9rem; border-radius:.5rem; background:var(--panel); }
  .setting { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.7rem; align-items:baseline; }
  .setting-label,.setting-value { display:block; }
  .setting-label { margin-bottom:.16rem; color:var(--muted); font:700 .61rem ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:uppercase; }
  .setting-value { overflow-wrap:anywhere; font:500 .68rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .setting-copy { padding:.2rem .35rem; border:0; border-radius:.25rem; background:var(--white); color:var(--muted); font:700 .61rem ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; }
  .setting-copy:hover { color:var(--ink); }
  @media (max-width:650px) {
    .shell{width:min(100% - 1.25rem,68rem);padding-top:1rem}.top-panels{grid-template-columns:1fr;margin:1.6rem 0 3.5rem}h1{font-size:clamp(2.7rem,15vw,4rem)}.thesis{margin-bottom:3.5rem;font-size:.98rem}
    .provider-browser{grid-template-columns:6.6rem minmax(0,1fr);gap:1rem}.provider-list{top:.5rem}.provider{padding:.65rem .5rem .65rem 1.1rem}.provider::before{left:.45rem}.provider span{font-size:.92rem}.provider small{display:none}.add-provider{margin-left:.5rem;font-size:.61rem}
    .provider-head{display:block;margin-bottom:1.25rem}.provider-head h2{font-size:1.65rem}.endpoint{max-width:none;margin-top:.4rem;text-align:left}.tabs{width:100%}.tab{flex:1 1 45%;padding:.4rem .3rem}.command{padding-right:3.6rem}.guide{margin-top:3rem}.guide-head{display:block}.portal-button{display:inline-block;margin-top:.55rem}.guide-step{grid-template-columns:1.35rem minmax(0,1fr)}.guide-step>.md,.settings{grid-column:2}.guide-step h3{margin-top:.08rem}
  }
  @media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto!important; transition:none!important; } }
</style></head>
<body>
<div class="shell">
  <header><span class="brand">zero-trust-mcp</span><a class="source" href="https://github.com/iterate/zero-trust-mcp" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.17.55-.39 0-.19-.01-.83-.01-1.5-2.01.38-2.53-.5-2.69-.96-.09-.23-.48-.96-.82-1.15-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.2-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.4 7.4 0 0 1 8 3.99c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.96.08 2.16.51.57.82 1.3.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.74.54 1.5 0 1.08-.01 1.95-.01 2.22 0 .22.15.47.55.39A8.14 8.14 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z"/></svg><span>Read the code</span></a></header>
  <div class="top-panels">
    <details class="explainer">
      <summary>What is this?</summary>
      <div class="explainer-copy">
        <p>Each integration adapts a third party’s existing authentication and API to MCP. Credentials are encrypted inside OAuth tokens held by the MCP client. The Worker decrypts them only for a request and does not persist them.</p>
        <p>Open-source software. Self-host it, audit it, or add an integration. Made by <a href="https://x.com/jonas" target="_blank" rel="noopener">@jonas on X</a>.</p>
      </div>
    </details>
    <details class="explainer">
      <summary>How a request works</summary>
      <div class="explainer-copy">
        <div class="compact-flow" aria-label="AI agent to MCP client to Zero Trust MCP to third-party API">
          <strong>AI agent</strong><span>→</span><strong>MCP client</strong><span>→</span><strong>Zero Trust MCP</strong><span>→</span><strong>Third-party API</strong>
        </div>
        <p>The agent never receives the upstream credential. The client holds the encrypted capability; the Worker opens it only while handling the call.</p>
      </div>
    </details>
  </div>
  <main>
    <h1>MCP servers for APIs that don’t have one.</h1>
    <p class="thesis">Use a third-party API from an AI agent without giving the agent the upstream credentials.</p>
    <section class="provider-browser" aria-label="MCP server connection recipes">
      <aside class="provider-list" aria-label="Providers">
        ${providers}
        <a class="add-provider" href="https://github.com/iterate/zero-trust-mcp/compare" target="_blank" rel="noopener">Add your own ↗</a>
      </aside>
      <section class="provider-detail" aria-live="polite">
        <div class="provider-head">
          <h2 id="provider-title"></h2>
          <p class="endpoint" id="provider-endpoint"></p>
        </div>
        <nav class="tabs" aria-label="Connection examples">
          <button class="tab selected" type="button" aria-pressed="true" data-recipe="add">Add to Claude</button>
          <button class="tab" type="button" aria-pressed="false" data-recipe="only">Claude only</button>
          <button class="tab" type="button" aria-pressed="false" data-recipe="inspector">Inspector</button>
          <button class="tab" type="button" aria-pressed="false" data-recipe="endpoint">Endpoint</button>
        </nav>
        <p class="example-copy" id="recipe-description"></p>
        <div class="command"><pre><code id="recipe-code"></code></pre><button class="copy" type="button" aria-label="Copy command">copy</button></div>
        <span id="copy-status" role="status" aria-live="polite" hidden></span>
        <p class="provider-note" id="provider-note" hidden></p>
        <section class="guide" id="setup-guide" aria-labelledby="guide-title" hidden>
          <div class="guide-head">
            <h2 id="guide-title"></h2>
            <a class="portal-button" id="guide-action" target="_blank" rel="noopener"></a>
          </div>
          <div id="guide-body"></div>
        </section>
      </section>
    </section>
  </main>
</div>
<noscript><p>Endpoints: ${catalog.map(({ endpoint }) => escapeHtml(endpoint)).join(" · ")}</p></noscript>
<script>
  const catalog = ${catalogJson};
  const recipes = {
    add(provider) {
      return { description: "Save it in Claude.", code: "claude mcp add --transport http " + provider.id + " " + provider.endpoint };
    },
    only(provider) {
      const config = JSON.stringify({ mcpServers: { [provider.id]: { type: "http", url: provider.endpoint } } });
      return { description: "Start Claude with no other MCP servers.", code: "claude --strict-mcp-config --mcp-config '" + config + "'" };
    },
    inspector(provider) {
      return { description: "Inspect the endpoint.", code: "npx -y @modelcontextprotocol/inspector@latest --web --transport http --server-url " + provider.endpoint };
    },
    endpoint(provider) {
      return { description: "Use this URL in any MCP client.", code: provider.endpoint };
    },
  };
  let selectedProvider = catalog.find((provider) => location.hash === "#" + provider.id) || catalog[0];
  let selectedRecipe = "add";
  const description = document.getElementById("recipe-description");
  const code = document.getElementById("recipe-code");
  const copyStatus = document.getElementById("copy-status");
  const providerNote = document.getElementById("provider-note");
  const providerTitle = document.getElementById("provider-title");
  const providerEndpoint = document.getElementById("provider-endpoint");
  const guide = document.getElementById("setup-guide");
  const guideTitle = document.getElementById("guide-title");
  const guideAction = document.getElementById("guide-action");
  const guideBody = document.getElementById("guide-body");
  function renderGuide() {
    const setup = selectedProvider.setupGuide;
    guide.hidden = !setup;
    if (!setup) return;
    guideTitle.textContent = setup.title;
    guideAction.textContent = setup.actionLabel + " ↗";
    guideAction.href = setup.actionUrl;
    // Server-rendered from source-controlled copy with escaped Markdown.
    guideBody.innerHTML = setup.html;
  }
  function render() {
    const recipe = recipes[selectedRecipe](selectedProvider);
    providerTitle.textContent = selectedProvider.name;
    providerEndpoint.textContent = selectedProvider.endpoint;
    description.textContent = recipe.description;
    code.textContent = recipe.code;
    providerNote.textContent = selectedProvider.affiliationNotice || "";
    providerNote.hidden = !selectedProvider.affiliationNotice;
    document.querySelectorAll(".provider").forEach((item) => { const active = item.dataset.provider === selectedProvider.id; item.classList.toggle("selected", active); item.setAttribute("aria-pressed", String(active)); });
    renderGuide();
  }
  document.querySelectorAll(".provider").forEach((button) => button.addEventListener("click", () => {
    selectedProvider = catalog.find((provider) => provider.id === button.dataset.provider);
    history.replaceState(null, "", "#" + selectedProvider.id);
    render();
  }));
  window.addEventListener("hashchange", () => {
    const provider = catalog.find((item) => location.hash === "#" + item.id);
    if (!provider) return;
    selectedProvider = provider;
    render();
  });
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
    selectedRecipe = button.dataset.recipe;
    document.querySelectorAll(".tab").forEach((item) => { const active = item === button; item.classList.toggle("selected", active); item.setAttribute("aria-pressed", String(active)); });
    render();
  }));
${COPY_SCRIPT}
  document.querySelector(".copy").addEventListener("click", async () => {
    const copied = await copyText(code.textContent);
    const button = document.querySelector(".copy");
    button.textContent = copied ? "copied" : "select";
    copyStatus.hidden = false;
    copyStatus.textContent = copied ? "Command copied" : "Clipboard unavailable; select the command manually";
    setTimeout(() => { button.textContent = "copy"; copyStatus.hidden = true; }, 1600);
  });
  render();
</script>
</body></html>`;
}
