export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function rate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  return `${bytes(bytesPerSec)}/s`;
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "just now", "6 min ago", "yesterday" — short enough for a dense list. */
export function ago(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** Plain-language summary of the route the file is taking. */
export function pathLabel(p: {
  localType: string;
  remoteType: string;
  relayed: boolean;
}): string {
  if (p.relayed) return "Relayed connection";
  if (p.localType === "host" && p.remoteType === "host") {
    return "Direct · same network";
  }
  return "Direct · peer-to-peer";
}

export function eta(remainingBytes: number, bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "—";
  const secs = Math.ceil(remainingBytes / bytesPerSec);
  if (secs < 60) return `${secs}s left`;
  return `${clock(secs * 1000)} left`;
}
