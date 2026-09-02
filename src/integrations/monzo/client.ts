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

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.apiOrigin}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${this.accessToken}` },
    });
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? "Monzo has not approved this token, or the grant was revoked"
        : `Monzo API request failed (${response.status})`;
      throw new MonzoApiError(response.status, message);
    }
    return response.json<T>();
  }
}
