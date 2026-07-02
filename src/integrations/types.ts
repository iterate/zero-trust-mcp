import type { McpServer } from "@modelcontextprotocol/server";

export interface Env {
  SEAL_KEY: string;
  DEMO_PROVIDER_URL: string;
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

interface IntegrationBase {
  id: string;
  name: string;
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

export type Integration = PasswordIntegration | OAuthIntegration;
