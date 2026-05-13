import { NextRequest, NextResponse } from "next/server";

// Feste IP des Pi im AP-Modus
const AP_IP = "10.42.0.1";
const PORTAL_URL = `http://${AP_IP}:3000/portal`;

// Captive-Portal-Probes der verschiedenen Betriebssysteme
const CAPTIVE_PROBES: Record<string, true> = {
  "/hotspot-detect.html":         true,
  "/library/test/success.html":   true,
  "/bag/1.0/hotspot-detect.html": true,
  "/generate_204":                true,
  "/gen_204":                     true,
  "/connecttest.txt":             true,
  "/ncsi.txt":                    true,
  "/redirect":                    true,
  "/canonical.html":              true,
  "/success.txt":                 true,
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!CAPTIVE_PROBES[pathname]) return NextResponse.next();
  return NextResponse.redirect(PORTAL_URL, 302);
}

export const config = {
  matcher: [
    "/hotspot-detect.html",
    "/library/test/success.html",
    "/bag/1.0/hotspot-detect.html",
    "/generate_204",
    "/gen_204",
    "/connecttest.txt",
    "/ncsi.txt",
    "/redirect",
    "/canonical.html",
    "/success.txt",
  ],
};
