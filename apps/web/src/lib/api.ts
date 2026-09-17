export class ApiRequestError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly payload: {
      error?: string;
      code?: string;
      issues?: unknown;
      availableCohorts?: unknown;
    },
  ) {
    super(payload.error ?? `${path} returned HTTP ${status}`);
    this.name = "ApiRequestError";
  }
  get code(): string | undefined {
    return this.payload.code;
  }
}

export async function getJson(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, { signal });
  const payload = await response.json();
  if (!response.ok)
    throw new ApiRequestError(
      path,
      response.status,
      payload as ApiRequestError["payload"],
    );
  return payload;
}

export async function sendJson(
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok)
    throw new Error(
      payload.error ?? `${path} returned HTTP ${response.status}`,
    );
  return payload;
}
