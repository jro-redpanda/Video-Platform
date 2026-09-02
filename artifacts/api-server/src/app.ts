import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { bootstrapDevelopmentTenant } from "./lib/bootstrap";
import { resolveTenant } from "./lib/tenant-context";
import publicRouter from "./routes/public";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth";
import { videoProviders } from "./lib/provider-registry";
import { receiveBunnyRoundTripCallback } from "./lib/bunny-roundtrip";
import providerWebhooksRouter from "./routes/provider-webhooks";
import { processStripeWebhook } from "./lib/stripe-webhook";

const app: Express = express();
app.locals.videoProviders = videoProviders;

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.all("/api/auth/*splat", toNodeHandler(auth));
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json", limit: "2mb" }),
  async (req, res) => {
    const header = req.headers["stripe-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return void res.status(400).json({ error: "Missing stripe-signature" });
    try {
      await processStripeWebhook(req.body as Buffer, signature);
      res.status(200).json({ received: true });
    } catch {
      res.status(400).json({ error: "Webhook processing failed" });
    }
  },
);
app.post(
  "/api/provider-tests/bunny/:token",
  express.raw({ type: "application/json", limit: "64kb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body)) return void res.sendStatus(400);
    const result = receiveBunnyRoundTripCallback(req.params.token, req.body, req.headers);
    res.sendStatus(result.accepted ? 204 : 401);
  },
);
app.use("/api", providerWebhooksRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

await bootstrapDevelopmentTenant();
app.use("/api/public", publicRouter);
app.use("/api", resolveTenant);
app.use("/api", router);

export default app;
