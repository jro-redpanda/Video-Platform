import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: isProduction ? undefined : null,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers['stripe-signature']",
    "req.headers['x-api-key']",
    "res.headers['set-cookie']",
    "password",
    "secret",
    "token",
    "apiKey",
    "accessToken",
    "refreshToken",
    "*.password",
    "*.secret",
    "*.token",
    "*.apiKey",
    "*.accessToken",
    "*.refreshToken",
  ],
  ...(isDevelopment
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}),
});

/** Safe metadata for boundary logs; external error messages can contain credentials. */
export function summarizeError(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name, ...(code ? { code } : {}) };
}
