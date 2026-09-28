import type { McpServer } from "@modelcontextprotocol/server";

export interface Env {
  SEAL_KEY: string;
  DEMO_PROVIDER_URL: string;
  MONZO_REFRESH_COORDINATOR: DurableObjectNamespace;
  YOTO_REFRESH_COORDINATOR: DurableObjectNamespace;
  /** Test overrides; production uses api.yotoplay.com and login.yotoplay.com. */
  YOTO_API_ORIGIN?: string;
  YOTO_AUTH_ORIGIN?: string;
  /** Test override; production defaults to https://api.monzo.com. */
  MONZO_API_ORIGIN?: string;
  /** Test override; production defaults to https://auth.monzo.com. */
  MONZO_AUTH_ORIGIN?: string;
}

export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "email" | "password";
}

/**
 * The result of establishing (or refreshing) access to an upstream API.
 * - `session` is what a request needs (sealed into the ACCESS token).
 * - `grant` is the durable material that can mint future sessions (sealed
 *   into the REFRESH token and the browser cookie): credentials for
 *   password integrations, the upstream refresh token for OAuth ones.
 */
export interface GrantResult {
  session: unknown;
  expiresInSeconds: number;
  grant: unknown;
}

/** Declarative provider identity used by the shared setup/completion pages. */
export interface IntegrationPresentation {
  /** Trusted, source-controlled SVG markup. Never populate this from user input. */
  logoSvg?: string;
  wordmark?: string;
  productLabel?: string;
  setupDescription?: string;
  securitySummary?: string;
  /** Provider-specific independence/trademark notice shown on connection surfaces. */
  affiliationNotice?: string;
  setupGuide?: {
    title: string;
    description: string;
    actionLabel: string;
    actionUrl: string;
    steps: Array<{
      title: string;
      description: string;
      settings?: Array<{
        label: string;
        /** Supports {origin} and {id}, resolved by the catalogue page. */
        value: string;
        copy?: boolean;
      }>;
    }>;
  };
  colors?: {
    background: string;
    ink: string;
    accent: string;
    accentInk: string;
    subtle: string;
  };
}

/**
 * Optional post-OAuth lifecycle for providers whose token is not usable until
 * a separate approval step completes. The OAuth engine owns all state and UI;
 * an integration only declares copy and a readiness probe.
 */
export interface ConnectionFlow {
  instructionTitle: string;
  instructionDescription: string;
  pendingTitle: string;
  pendingDescription: string;
  readyTitle: string;
  readyDescription: string;
  checkLabel: string;
  returnLabel: string;
  check(session: unknown, env: Env): Promise<"pending" | "ready">;
}

interface IntegrationBase {
  id: string;
  name: string;
  presentation?: IntegrationPresentation;
  connectionFlow?: ConnectionFlow;
  /** Register this integration's tools (named `<id>_*`) bound to an unsealed session. */
  registerTools(server: McpServer, session: unknown): void;
  /** Mint a fresh session from grant material (refresh grant, cookie fast-pass). Throws if the grant is dead. */
  refreshGrant(grant: unknown, env: Env): Promise<GrantResult>;
}

/** Username/password upstream (e.g. Waitrose): the wizard renders a login form. */
export interface PasswordIntegration extends IntegrationBase {
  kind: "password";
  fields: CredentialField[];
  login(creds: Record<string, string>, env: Env): Promise<GrantResult>;
}

/** Real OAuth upstream (e.g. the dummy provider, Gmail): the wizard redirects out and back. */
export interface OAuthIntegration extends IntegrationBase {
  kind: "oauth";
  authorizeUrl(callbackUrl: string, state: string, env: Env): string;
  exchangeCode(code: string, callbackUrl: string, env: Env): Promise<GrantResult>;
}

/**
 * OAuth provider where every user supplies their own confidential client.
 * The credentials travel only in client-held sealed protocol artifacts.
 */
export interface UserClientOAuthIntegration extends IntegrationBase {
  kind: "user-client-oauth";
  fields: CredentialField[];
  authorizeUrl(
    callbackUrl: string,
    state: string,
    credentials: Record<string, string>,
    env: Env,
  ): string;
  exchangeCode(
    code: string,
    callbackUrl: string,
    credentials: Record<string, string>,
    env: Env,
  ): Promise<GrantResult>;
}

export type Integration = PasswordIntegration | OAuthIntegration | UserClientOAuthIntegration;
