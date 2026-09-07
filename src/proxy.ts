import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { tenantSubdomainFromHost } from "@/lib/tenant-host";
import {
  FLAG_REQUEST_HEADER,
  flagRequestHeaderValue,
  type FeatureFlagSnapshot,
  parseFlagRequestHeader,
} from "@/lib/featureFlags";

export function flagsFromRequestHeaders(headers: Headers): FeatureFlagSnapshot {
  return parseFlagRequestHeader(headers.get(FLAG_REQUEST_HEADER));
}

const PUBLIC_ROUTES = [
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/pricing",
  "/compare",
  "/migrate",
  "/status",
  "/api/health",
  "/api/cron",
  "/api/webhooks",
  "/api/integrations",
  "/api/auth",
  "/api/billing/checkout",
  "/api/portal-theme",
  "/studio/authorize",
];

function isPublicRoute(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname.startsWith("/tenant/")) return true;
  if (pathname.startsWith("/api/tenant/")) return true;
  for (const route of PUBLIC_ROUTES) {
    if (pathname === route || pathname.startsWith(route + "/") || pathname.startsWith(route + "?")) {
      return true;
    }
  }
  return false;
}

// ── Content Security Policy (nonce-based) ───────────────────────────────────
//
// A fresh CSPRNG nonce is generated per request. The nonce and the CSP are
// forwarded as REQUEST headers so Next.js can extract the nonce during SSR
// and apply it to framework scripts, page bundles, and inline scripts. The
// response carries the same CSP so the browser enforces it.
//
// `style-src 'unsafe-inline'` is retained and deliberately NOT split into
// `style-src-elem` + `style-src-attr`:
//   - `style-src-attr 'unsafe-inline'` is required by React inline style
//     attributes — the storefront renderer applies every section style that way.
//   - `style-src-elem 'unsafe-inline'` is required by app-authored styled-jsx
//     `<style jsx>` elements (`@keyframes marquee` in KineticMarqueeSection).
//     Splitting style-src blocks those keyframes (verified in Chromium), which
//     would regress the default theme; tenant CSS cannot create style elements
//     (sanitizer rejects selectors/at-rules), so this directive is
//     defense-in-depth only.
// `script-src` intentionally has NO 'unsafe-inline' in production.

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev
    ? `'self' 'unsafe-inline' 'unsafe-eval' 'nonce-${nonce}' https://app.midtrans.com https://app.sandbox.midtrans.com`
    : `'self' 'nonce-${nonce}' https://app.midtrans.com https://app.sandbox.midtrans.com`;

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.supabase.co https://images.unsplash.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://*.supabase.co https://api.fonnte.com https://api.resend.com https://app.midtrans.com https://app.sandbox.midtrans.com",
    "frame-src 'self' https://app.midtrans.com https://app.sandbox.midtrans.com",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function createNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set(FLAG_REQUEST_HEADER, flagRequestHeaderValue());

  const { pathname } = request.nextUrl;
  const tenantSubdomain = tenantSubdomainFromHost(request.headers.get("host"));

  let response: NextResponse;

  if (tenantSubdomain && (pathname === "/" || pathname.startsWith("/order/"))) {
    const storefrontUrl = request.nextUrl.clone();
    storefrontUrl.pathname = pathname === "/"
      ? `/tenant/${tenantSubdomain}`
      : `/tenant/${tenantSubdomain}${pathname}`;
    response = NextResponse.rewrite(storefrontUrl, {
      request: { headers: requestHeaders },
    });
    response.headers.set("x-roastd-tenant", tenantSubdomain);
  } else if (isPublicRoute(pathname)) {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else if (!request.cookies.get("ros_session")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    response = NextResponse.redirect(loginUrl);
  } else {
    requestHeaders.set("x-pathname", pathname);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  response.headers.set("x-nonce", nonce);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|images/|fonts/|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)",
    },
  ],
};
