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
