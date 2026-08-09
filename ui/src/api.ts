export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const response = await fetch(path, { ...options, headers })
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) {
    throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status)
  }
  return body as T
}

export function jsonRequest(method: "POST", body: unknown = {}): RequestInit {
  return { method, body: JSON.stringify(body) }
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  )
}
