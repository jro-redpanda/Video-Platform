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
