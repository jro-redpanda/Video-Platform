const STRIPE_HOST = /(^|\.)stripe\.com$/i

export function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = getHttpStatus(error)
  if (status === 401 || status === 403 || status === 404) return false
  return failureCount < 2
}

export function getSafeMediaUrl(
  value: string | null | undefined,
  baseUrl = typeof window === "undefined" ? "https://local.invalid" : window.location.href,
): string | null {
  if (!value) return null

  try {
    const base = new URL(baseUrl)
    const parsed = new URL(value, base)
    if (parsed.username || parsed.password) return null
    const isHttps = parsed.protocol === "https:"
    const isSameOriginHttp = parsed.protocol === "http:" && parsed.origin === base.origin
    return isHttps || isSameOriginHttp ? parsed.toString() : null
  } catch {
    return null
  }
}

export function getSafePosterUrl(
  value: string | null | undefined,
  baseUrl?: string,
): string | null {
  if (value && /^data:image\/(?:gif|jpeg|png|svg\+xml|webp)[;,]/i.test(value)) {
    return value
  }
  return getSafeMediaUrl(value, baseUrl)
}

export function getSafeStripeUrl(value: string | null | undefined): string | null {
  if (!value) return null

  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && STRIPE_HOST.test(parsed.hostname)
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}