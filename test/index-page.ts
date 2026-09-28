import { indexPage, loginPage } from "../src/html.js";
import { monzo } from "../src/integrations/monzo/index.js";
import { yoto } from "../src/integrations/yoto/index.js";
import { waitrose } from "../src/integrations/waitrose/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

const html = indexPage("https://mcp.example.test", [
  {
    id: "waitrose",
    name: "Waitrose",
    presentation: { affiliationNotice: "Independent software. Not affiliated with or endorsed by Waitrose & Partners." },
  },
  {
    id: "demo",
    name: "Demo",
    presentation: {
      setupGuide: {
        title: "Try the demo",
        description: "No account required.",
        actionLabel: "Read the demo code",
        actionUrl: "https://github.com/iterate/zero-trust-mcp/tree/main/dummy-oauth",
        steps: [{ title: "Approve", description: "Use the fake provider." }],
      },
    },
  },
  {
    id: "monzo",
    name: "Monzo",
    presentation: {
      affiliationNotice: "Independent software. Not affiliated with or endorsed by Monzo Bank Limited.",
      setupGuide: {
        title: "Monzo setup",
        description: "Two minutes.",
        actionLabel: "Open Monzo developer portal",
        actionUrl: "https://developers.monzo.com/",
        steps: [{
          title: "Use these settings",
          description: "Exact values.",
          settings: [
            { label: "Redirect URL", value: "{origin}/{id}/callback", copy: true },
            { label: "Confidentiality", value: "Confidential" },
          ],
        }],
      },
    },
  },
  { id: "future", name: "Future Provider" },
  yoto,
] as any);

console.log("\n=== Integration picker ===");
assert(html.includes('data-provider="waitrose"'), "renders the first registered provider as a selectable control");
assert(html.includes('data-provider="monzo"'), "renders every current provider as a selectable control");
assert(html.includes('data-provider="demo"'), "renders the runnable demo provider");
assert(html.includes("Future Provider"), "renders a newly registered provider without provider-specific page code");
assert(html.includes("https://mcp.example.test/future/mcp"), "derives the selected endpoint from origin and provider id");

assert(html.includes('data-provider="yoto"'), "renders Yoto in the integration picker");
assert(html.includes("https://mcp.example.test/yoto/callback"), "Yoto setup resolves the deployment callback");
assert(html.includes("https://dashboard.yoto.dev/"), "Yoto setup links to its developer portal");
assert(loginPage(yoto, "sealed-state").includes('name="client_secret"'), "Yoto setup collects a developer client secret");

console.log("\n=== Client recipes ===");
for (const label of ["Add to Claude", "Claude only", "Inspector", "Endpoint"]) {
  assert(html.includes(label), `includes the ${label} recipe`);
}
assert(html.includes("--strict-mcp-config"), "documents the isolated Claude launch flag");
assert(html.includes("--server-url"), "uses the Inspector's supported preconfigured web mode");
assert(html.includes("navigator.clipboard.writeText"), "offers one-click command copying");

console.log("\n=== Provider setup guide ===");
assert(html.includes("Monzo setup"), "renders provider-declared setup guidance");
assert(html.includes("https://developers.monzo.com/"), "links directly to the provider's developer portal");
assert(html.includes("https://mcp.example.test/monzo/callback"), "resolves the deployment-specific callback URL");
assert(html.includes("Confidential"), "shows the required Monzo client confidentiality setting");
assert(html.includes("Not affiliated with or endorsed by Monzo Bank Limited"), "shows the selected provider's independence notice");

console.log("\n=== Provider identity ===");
const monzoLogin = loginPage(monzo, "sealed-state");
const waitroseLogin = loginPage(waitrose, "sealed-state");
assert(monzoLogin.includes('viewBox="0 0 138 24"'), "uses Monzo's official wordmark geometry");
assert(!monzoLogin.includes('viewBox="0 0 64 64"'), "does not use the synthesized Monzo mark");
assert(monzoLogin.includes("Not affiliated with or endorsed by Monzo Bank Limited"), "disclaims Monzo affiliation on its connection page");
assert(waitroseLogin.includes("Not affiliated with or endorsed by Waitrose &amp; Partners"), "disclaims Waitrose affiliation on its connection page");

console.log("\n=== Minimal public page ===");
assert(html.includes("Read the code"), "links to the source in the header");
assert(html.includes('viewBox="0 0 16 16"'), "shows the GitHub mark beside the source link");
assert(html.includes("MCP servers for APIs that don’t have one"), "states what the project is without a slogan");
assert(html.includes('class="provider-list"'), "stacks providers in a dedicated left-hand list");
assert(html.includes('class="provider-detail"'), "keeps changing provider content in one stable detail pane");
assert(html.includes('id="provider-title"'), "updates the selected provider heading inside that pane");
assert(html.includes('window.addEventListener("hashchange"'), "keeps the detail pane in sync with direct provider URLs");
assert(!html.includes("Supported third parties"), "does not repeat an unnecessary provider-list heading");
assert(html.includes("https://github.com/iterate/zero-trust-mcp/compare"), "links Add your own to GitHub's pull-request flow");
assert(html.includes("What is this?"), "explains the mechanism directly");
assert(html.includes("held by the MCP client"), "states where credentials are held");
assert(html.includes("does not persist them"), "states the server-side storage boundary");
assert(html.includes("@jonas on X"), "credits the author concisely");
assert(html.includes("How a request works"), "includes the four-party trust-boundary diagram");
assert(html.match(/<details class="explainer">/g)?.length === 2, "puts both explanations in compact disclosures at the top");
assert(!html.includes("border-block:1px"), "does not divide the command area with horizontal rules");
for (const actor of ["AI agent", "MCP client", "Zero Trust MCP", "Third-party API"]) {
  assert(html.includes(actor), `shows ${actor} in the request path`);
}

console.log("\n✅ INDEX PAGE PROOF PASSED");
