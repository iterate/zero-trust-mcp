import { DurableObject } from "cloudflare:workers";
import { parseTokenResponse } from "./client.js";
import type { Env } from "../types.js";
import { sha256b64url } from "../../seal.js";

interface CoordinatorState {
  generation: number;
  refreshHash: string;
}

export interface YotoRotationRequest {
  generation: number;
  refreshHash: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

export interface YotoRotationResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

interface ActiveRotation {
  generation: number;
  refreshHash: string;
  promise: Promise<YotoRotationResult>;
}

interface RecentRotation {
  generation: number;
  refreshHash: string;
  expiresAt: number;
  result: YotoRotationResult;
}

const RECENT_RESULT_TTL_MS = 30_000;

/**
 * One coordinator per Yoto connection.
 *
 * Durable state is deliberately capability-free: only a generation number
 * and SHA-256 hash of the current refresh token. Credentials and provider
 * tokens exist only in request memory while a caller presents the sealed MCP
 * refresh token that contains them.
 */
export class YotoRefreshCoordinator extends DurableObject<Env> {
  private active?: ActiveRotation;
  private recent?: RecentRotation;

  async initialize(input: CoordinatorState): Promise<void> {
    const current = await this.ctx.storage.get<CoordinatorState>("state");
    if (!current) {
      await this.ctx.storage.put("state", input);
      return;
    }
    if (current.generation !== input.generation || current.refreshHash !== input.refreshHash) {
      throw new Error("coordinator_already_initialized");
    }
  }

  async rotate(input: YotoRotationRequest): Promise<YotoRotationResult> {
    if (
      this.recent &&
      this.recent.expiresAt > Date.now() &&
      this.recent.generation === input.generation &&
      this.recent.refreshHash === input.refreshHash
    ) {
      return this.recent.result;
    }

    if (this.active) {
      if (
        this.active.generation === input.generation &&
        this.active.refreshHash === input.refreshHash
      ) {
        return this.active.promise;
      }
      try {
        await this.active.promise;
      } catch {
        // Re-check durable state below; the other attempt may have failed.
      }
      return this.rotate(input);
    }

    const promise = this.performRotation(input);
    this.active = { generation: input.generation, refreshHash: input.refreshHash, promise };

    try {
      const result = await promise;
      const recent: RecentRotation = {
        generation: input.generation,
        refreshHash: input.refreshHash,
        expiresAt: Date.now() + RECENT_RESULT_TTL_MS,
        result,
      };
      this.recent = recent;
      setTimeout(() => {
        if (this.recent === recent) this.recent = undefined;
      }, RECENT_RESULT_TTL_MS);
      return result;
    } finally {
      if (this.active?.promise === promise) this.active = undefined;
    }
  }

  private async performRotation(input: YotoRotationRequest): Promise<YotoRotationResult> {
    const current = await this.ctx.storage.get<CoordinatorState>("state");
    if (
      !current ||
      current.generation !== input.generation ||
      current.refreshHash !== input.refreshHash ||
      (await sha256b64url(input.refreshToken)) !== input.refreshHash
    ) {
      throw new Error("stale_refresh_generation");
    }

    const authOrigin = this.env.YOTO_AUTH_ORIGIN ?? "https://login.yotoplay.com";
    const response = await fetch(`${authOrigin}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: input.clientId,
        client_secret: input.clientSecret,
        refresh_token: input.refreshToken,
      }),
    });
    if (!response.ok) throw new Error("yoto_refresh_rejected");

    const token = await parseTokenResponse(response);

    const nextState: CoordinatorState = {
      generation: current.generation + 1,
      refreshHash: await sha256b64url(token.refresh_token),
    };
    // Persist the successor hash before any caller receives the rotated token.
    await this.ctx.storage.put("state", nextState);

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresInSeconds: token.expires_in,
    };
  }
}
