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

  async request(path: string, body?: unknown): Promise<unknown> {
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
        : "Try again later.";
      throw new Error(`Yoto API request failed (${response.status}). ${hint}`);
    }
    return response.json();
  }
}
