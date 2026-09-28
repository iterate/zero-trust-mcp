import { z } from "zod";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});

export async function parseTokenResponse(response: Response) {
  const result = tokenSchema.safeParse(await response.json().catch(() => null));
  if (!result.success) {
    // Do not reflect provider responses (which may contain credentials).
    throw new Error("Yoto returned incomplete tokens; enable offline_access and reconnect");
  }
  return result.data;
}

export class YotoClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiOrigin = "https://api.yotoplay.com",
  ) {}

  private async send(path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.apiOrigin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const hint = response.status === 401 ? "Reconnect Yoto to renew access."
        : response.status === 403 ? "Check the Yoto application's scopes and reconnect."
        : response.status === 404 ? "The resource was not found or is not accessible to this account."
        : response.status === 429 ? "Yoto rate limit reached; try again later."
        : "Check the player or resource before retrying.";
      throw new Error(`Yoto API request failed (${response.status}). ${hint}`);
    }
    return response;
  }

  async request(path: string, body?: unknown): Promise<unknown> {
    return (await this.send(path, body)).json();
  }

  // Android's command API returns an empty 200, not a JSON playback state.
  async command(deviceId: string, command: string, body: unknown = {}) {
    let response: Response;
    try {
      response = await this.send(`/device-v2/${encodeURIComponent(deviceId)}/command/${command}`, body);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Yoto API request failed")) throw error;
      throw new Error("Yoto command outcome is unknown. Check the player before retrying.");
    }
    await response.body?.cancel();
    return {
      accepted: true,
      deviceId,
      command,
      requestId: response.headers.get("x-amzn-RequestId"),
      message: "Yoto accepted the command. This is not confirmation that the player executed it.",
    };
  }
}
