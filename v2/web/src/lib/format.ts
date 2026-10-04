const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"]];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return rtf.format(Math.round(v), "year");
}

export const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Oct 3, 2:40 PM – 4:05 PM" on one day; "Oct 3, 2026 – Oct 9, 2026" across days; open end = "now". */
export function span(fromIso: string, toIso: string | null): string {
  const from = new Date(fromIso);
  const to = toIso ? new Date(toIso) : null;
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (!to) return `${day(from)}, ${time(from)} – now`;
  if (from.toDateString() === to.toDateString()) return `${day(from)}, ${time(from)} – ${time(to)}`;
  return `${date(fromIso)} – ${date(toIso!)}`;
}

/** Distances in miles: "0.4 mi", "12 mi". */
export function miles(m: number | null | undefined): string {
  if (m == null) return "—";
  const mi = m / 1609.34;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString()} mi`;
}

/** "45 min", "1 h 20 min". */
export function duration(fromIso: string, toIso: string): string {
  const min = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** Whole percent, but never 100% until it really is all done, and never 0% once started. */
export function percent(part: number, whole: number): string {
  if (!whole) return "—";
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return "<1%";
  if (p < 100 && p > 99) return "99%";
  return `${Math.round(p)}%`;
}
