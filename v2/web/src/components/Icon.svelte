<script lang="ts">
  // Line icons drawn inline; the illustrations come from ChatGPT, these stay as code.
  let { name, size = 20 }: { name: string; size?: number } = $props();
  const PATHS: Record<string, string> = {
    map: "M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4Zm0 0v13.5m6-11v13.5",
    drives: "M4 17c3-9 13-9 16 0M7 17a1.5 1.5 0 1 0 0 .01M17 17a1.5 1.5 0 1 0 0 .01M12 8V4",
    fleet: "M3 16V11l2.5-5h13L21 11v5H3Zm0 0v2.5M21 16v2.5M3 11h18M7 13.5h.01M17 13.5h.01",
    teams: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c.8-3.4 3.2-5.5 6-5.5s5.2 2.1 6 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c1.5.8 2.6 2.6 3 5.2",
    admin: "M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6L12 3Zm-3 9 2.2 2.2L15.5 10",
    plus: "M12 5v14M5 12h14",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 3-4-4",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    back: "M15 5l-7 7 7 7",
    check: "m5 12.5 4.5 4.5L19 7.5",
    out: "M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h10",
  };
</script>

<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={PATHS[name] ?? ""} /></svg>
