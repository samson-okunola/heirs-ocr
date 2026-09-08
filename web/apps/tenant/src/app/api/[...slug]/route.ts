import { NextRequest } from "next/server";

import { ocrApiUrl } from "@/lib/ocr";

/**
 * BFF proxy for the backend's open API routes. Forwards `/api/<slug>` to
 * `${OCR_API_URL}/api/<slug>`, so the browser only ever talks same-origin to
 * Next (the backend is CORS-closed and server-to-server).
 *
 * Session handling mirrors the tenant proxy: the backend issues an httpOnly
 * `tenant_session` cookie. We forward it upstream on every request; the backend
 * already scopes it to `Path=/`, so any `Set-Cookie` (login/logout) passes straight
 * through for the browser to store against the Next origin.
 */

const SESSION_COOKIE = "tenant_session";

async function proxy(req: NextRequest, slug: string[]): Promise<Response> {
  const path = slug.map(encodeURIComponent).join("/");
  const target = `${ocrApiUrl()}/api/${path}${req.nextUrl.search}`;

  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) headers["cookie"] = `${SESSION_COOKIE}=${token}`;

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await req.text() : undefined,
    cache: "no-store",
    redirect: "manual",
  });

  const upstreamType = upstream.headers.get("content-type") ?? "application/json";
  const resHeaders = new Headers();
  resHeaders.set("content-type", upstreamType);
  for (const cookie of upstream.headers.getSetCookie()) {
    resHeaders.append("set-cookie", cookie);
  }

  if (upstream.body && upstreamType.includes("text/event-stream")) {
    resHeaders.set("cache-control", "no-cache, no-transform");
    resHeaders.set("connection", "keep-alive");
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  }

  return new Response(await upstream.text(), { status: upstream.status, headers: resHeaders });
}

type Ctx = { params: Promise<{ slug: string[] }> };
const run = (req: NextRequest, ctx: Ctx) => ctx.params.then(({ slug }) => proxy(req, slug));

export const GET = run;
export const POST = run;
export const PUT = run;
export const PATCH = run;
export const DELETE = run;
