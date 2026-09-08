import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Optimistic auth gate for the tenant portal (Next 16 Proxy, formerly Middleware).
 * This app serves only tenant organisations, on its own origin: every page needs a
 * `tenant_session`; unauthenticated requests bounce to `/login`. Real validation
 * happens in the backend on every proxied call — this only checks for the cookie's
 * presence.
 */

const TENANT_SESSION = "tenant_session";
const LOGIN = "/login";
const DASHBOARD = "/ocr";

/** Routes that are always public — no session required. */
const PUBLIC_PATHS = new Set(["/", "/login", "/register", "/verification", "/api-reference", "/sdks", "/changelog"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const authed = Boolean(request.cookies.get(TENANT_SESSION)?.value);

  const redirect = (path: string, query = "") => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = query;
    return NextResponse.redirect(url);
  };

  if (PUBLIC_PATHS.has(pathname)) {
    // Authenticated users visiting login or home go straight to the dashboard.
    if (authed && pathname === LOGIN) return redirect(DASHBOARD);
    return NextResponse.next();
  }

  if (!authed) return redirect(LOGIN, `?next=${encodeURIComponent(pathname + search)}`);

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
