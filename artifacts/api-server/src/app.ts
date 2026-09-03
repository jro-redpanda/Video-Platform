import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { resolveTenant } from "./lib/tenant-context";
import publicRouter from "./routes/public";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth";
import { videoProviders } from "./lib/provider-registry";
import { receiveBunnyRoundTripCallback } from "./lib/bunny-roundtrip";
import providerWebhooksRouter from "./routes/provider-webhooks";
import { processStripeWebhook } from "./lib/stripe-webhook";
import onboardingRouter from "./routes/onboarding";
import healthRouter from "./routes/health";
import workspacesRouter from "./routes/workspaces";
import cookieParser from "cookie-parser";
import type { InvitationDelivery } from "./lib/invitation-delivery";
import invitationAcceptanceRouter from "./routes/invitation-acceptance";

type AppOptions = {
  initialReady?: boolean;
  stripeWebhookHandler?: typeof processStripeWebhook;
  bunnyRoundTripHandler?: typeof receiveBunnyRoundTripCallback;
  invitationDelivery?: InvitationDelivery;
};

export function createApp(options: AppOptions = {}): Express {
  const app: Express = express();
  app.set("trust proxy", 1);
  app.locals.videoProviders = videoProviders;
  app.locals.ready = options.initialReady ?? true;
  app.locals.invitationDelivery = options.invitationDelivery;

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

  // Liveness must remain available before auth, tenant lookup, and readiness.
  app.use("/api", healthRouter);
  app.use("/api", (_req, res, next) => {
    if (app.locals.ready === true) return next();
    res.setHeader("Retry-After", "1");
    return void res.status(503).json({ error: "Service starting" });
  });

  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
      const header = req.headers["stripe-signature"];
      const signature = Array.isArray(header) ? header[0] : header;
      if (!signature) return void res.status(400).json({ error: "Missing stripe-signature" });
      if (!Buffer.isBuffer(req.body)) {
        return void res.status(400).json({ error: "Malformed webhook body" });
      }
      try {
        await (options.stripeWebhookHandler ?? processStripeWebhook)(req.body, signature);
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
      const result = (options.bunnyRoundTripHandler ?? receiveBunnyRoundTripCallback)(
        req.params.token,
        req.body,
        req.headers,
      );
      res.sendStatus(result.accepted ? 204 : 401);
    },
  );
  // All provider signature checks must see bytes before general body parsers.
  app.use("/api", providerWebhooksRouter);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use("/api/public", publicRouter);
  app.use("/api", onboardingRouter);
  app.use("/api", workspacesRouter);
  app.use("/api", invitationAcceptanceRouter);
  app.use("/api", resolveTenant);
  app.use("/api", router);

  return app;
}

export function setApplicationReady(app: Express, ready: boolean) {
  app.locals.ready = ready;
}

const app = createApp();
export default app;
