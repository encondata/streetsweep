// A small history-API router: enough for a handful of pages, no dependency.
class Router {
  path = $state(location.pathname);
  query = $state(new URLSearchParams(location.search));

  go(url: string, replace = false) {
    history[replace ? "replaceState" : "pushState"](null, "", url);
    this.sync();
    if (!replace) scrollTo(0, 0);
  }

  sync() {
    this.path = location.pathname;
    this.query = new URLSearchParams(location.search);
  }
}

export const router = new Router();
addEventListener("popstate", () => router.sync());

// Same-origin links become client-side navigation, except pages the server owns.
const SERVER_PAGES = /^\/(login|signup|delete-me|policys|policies|privacy|api\/)/;
document.addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a || a.target || a.hasAttribute("download") || e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin || SERVER_PAGES.test(url.pathname)) return;
  e.preventDefault();
  router.go(url.pathname + url.search);
});

/** match("/teams/:id", "/teams/42") → { id: "42" } */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) out[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}
