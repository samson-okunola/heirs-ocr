import express, { type Request, type Response } from "express";
import morgan from "morgan";
import path from "path";

import { metricsAuth, securityHeaders } from "./http/middleware/security-headers";
import { metricsContentType, renderMetrics } from "./observability/metrics";
import { openApiRouter, tenantApiRouter } from "./http/tenant/routes";
import { errorHandler, notFound } from "./http/middleware/error";
import { checkDependencies } from "./observability/health";
import { adminApiRouter } from "./http/admin/routes";
import { corsMiddleware } from "./config/cors";
import { ocrRouter } from "./http/routes";
import { env } from "./config/env";

/** Builds the Express app. Kept free of `listen` so it can be imported by tests. */
export function main() {
  const app = express();

  // Baseline browser-security headers (CSP, X-Frame-Options, HSTS…) on every response.
  app.use(securityHeaders);
  // Default-closed CORS (server-to-server). See config/cors.ts.
  app.use(corsMiddleware);
  // Structured "combined" access logs in production; the colourful "dev" format is dev-only.
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/", (_req: Request, res: Response) => {
    res.json({ message: "Heirs OCR API" });
  });

  // Liveness: is the process itself up? Deliberately dependency-free — a Redis
  // outage must not get every pod killed and restarted into the same outage.
  app.get("/healthz", (_req: Request, res: Response) => res.json({ status: "ok" }));

  // Readiness: can this instance actually serve? Both stores are hard dependencies,
  // so an unreachable one takes the pod out of rotation (503) instead of letting it
  // accept traffic it can only fail.
  app.get("/readyz", async (_req: Request, res: Response) => {
    const deps = await checkDependencies();
    const ready = deps.redis && deps.postgres;
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "unavailable", ...deps });
  });

  // Prometheus scrape endpoint. Guarded by a bearer token when METRICS_AUTH_TOKEN
  // is set (see metricsAuth); otherwise open, which is only safe on a private net.
  app.get("/metrics", metricsAuth, async (_req: Request, res: Response) => {
    res.set("Content-Type", metricsContentType);
    res.send(await renderMetrics());
  });

  app.use("/v1/ocr", ocrRouter);
  app.use("/api", openApiRouter);

  // Admin console: static assets + JSON API, both under /admin. Same-origin (no
  // CORS). Login is open; other /admin/api routes gate on session + role. The first
  // owner is seeded on boot by `ensureBootstrapAdmin` (src/auth/admins.ts) from
  // ADMIN_BOOTSTRAP_EMAIL/_PASSWORD, so the console is usable on a fresh deploy.
  app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));
  app.use("/admin", adminApiRouter);

  // Tenant portal JSON API under /tenant. Same-origin (no CORS); login is open, the
  // rest gate on a tenant session. The tenant UI is served by the separate Next app,
  // which proxies here — so no static assets are mounted for it.
  app.use("/tenant", tenantApiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
