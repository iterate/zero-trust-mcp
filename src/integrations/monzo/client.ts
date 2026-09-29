export class MonzoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class MonzoClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiOrigin = "https://api.monzo.com",
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** Monzo's write endpoints take form-encoded bodies, not JSON. */
  async request<T>(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiOrigin}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.accessToken}`,
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? new URLSearchParams(form) : undefined,
      });
    } catch {
      throw new Error("Monzo request did not complete. For writes, check the result before retrying; the outcome may be unknown.");
    }
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? "Monzo has not approved this token, or the grant was revoked"
        : `Monzo API request failed (${response.status})`;
      throw new MonzoApiError(response.status, message);
    }
    return response.json<T>();
  }
}
