const REDACTIONS: Array<[RegExp, string]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1[redacted]@"],
  [/\b(password|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]"],
];

export function formatOperationalError(error: unknown): string {
  if (!(error instanceof Error)) return "Operational command failed";
  let message = `${error.name}: ${error.message}`;
  for (const [pattern, replacement] of REDACTIONS) {
    message = message.replace(pattern, replacement);
  }
  return message.slice(0, 2_000);
}