export function apiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined
  }

  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}