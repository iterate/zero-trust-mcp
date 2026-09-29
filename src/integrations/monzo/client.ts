export class MonzoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Monzo's `code` and `message` explain rejections; `params` can carry client and user IDs, so it is dropped. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    const code = typeof body.code === "string" && /^[\w.]{1,100}$/.test(body.code) ? body.code : undefined;
    const message = typeof body.message === "string" ? body.message.slice(0, 300) : undefined;
    const detail = [code, message].filter(Boolean).join(": ");
    return detail ? ` (${detail})` : "";
  } catch {
    return "";
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

  /**
   * Most Monzo writes take form-encoded bodies (pass URLSearchParams); receipts
   * take JSON (pass an object). Some writes succeed with an empty body, which
   * resolves to undefined.
   */
  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: URLSearchParams | object): Promise<T> {
    const contentType = body === undefined ? undefined
      : body instanceof URLSearchParams ? "application/x-www-form-urlencoded"
      : "application/json";
    let response: Response;
    try {
      response = await fetch(`${this.apiOrigin}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.accessToken}`,
          ...(contentType ? { "content-type": contentType } : {}),
        },
        body: body === undefined || body instanceof URLSearchParams ? body : JSON.stringify(body),
      });
    } catch {
      throw new Error("Monzo request did not complete. For writes, check the result before retrying; the outcome may be unknown.");
    }
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? "Monzo has not approved this token, the grant was revoked, or the resource is not accessible"
        : `Monzo API request failed (${response.status})`;
      throw new MonzoApiError(response.status, message + await errorDetail(response));
    }
    const text = await response.text();
    return (text.trim() ? JSON.parse(text) : undefined) as T;
  }
}
