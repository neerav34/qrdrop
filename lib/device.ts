"use client";

import type { DeviceInfo, DeviceKind } from "./protocol";

/**
 * A coarse, honest guess at what the user is holding. This is only ever used as
 * a label in the *other* device's UI ("sending to iPhone"), so being wrong is
 * cosmetic — never branch behaviour on it.
 */
export function describeDevice(): DeviceInfo {
  if (typeof navigator === "undefined") return { kind: "laptop", label: "device" };

  const ua = navigator.userAgent;
  const hints = (
    navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  ).userAgentData;

  const isIPad =
    /iPad/.test(ua) ||
    // iPadOS reports itself as a Mac; the touch points give it away.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isIPhone = /iPhone|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isAndroidTablet = isAndroid && !/Mobile/.test(ua);
  const mobile = hints?.mobile ?? (isIPhone || (isAndroid && /Mobile/.test(ua)));

  let kind: DeviceKind = "laptop";
  if (isIPad || isAndroidTablet) kind = "tablet";
  else if (mobile || isIPhone || isAndroid) kind = "phone";

  let label = "device";
  if (isIPhone) label = "iPhone";
  else if (isIPad) label = "iPad";
  else if (isAndroid) label = isAndroidTablet ? "Android tablet" : "Android phone";
  else if (/Macintosh|Mac OS X/.test(ua)) label = "Mac";
  else if (/Windows/.test(ua)) label = "Windows PC";
  else if (/CrOS/.test(ua)) label = "Chromebook";
  else if (/Linux/.test(ua)) label = "Linux PC";

  return { kind, label };
}
