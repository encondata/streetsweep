/**
 * The app's own addresses, under /v2. Each screen and selection has one, so the back
 * button goes back, a reload stays put and a link can be shared — none of which v1 had.
 *
 *   /v2/map                         the map, every area
 *   /v2/map/area/12                 one area: its streets and figures
 *   /v2/areas                       the list of areas
 *   /v2/areas/12                    one area's details, with its edit actions
 *   /v2/areas/new                   a new area
 */
const BASE = "/v2";

function current(): string {
  const p = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
  return p === "" || p === "/" ? "/map" : p.replace(/\/+$/, "");
}

class Router {
  path = $state(current());
  query = $state(new URLSearchParams(location.search));

  constructor() {
    addEventListener("popstate", () => {
      this.path = current();
      this.query = new URLSearchParams(location.search);
    });
  }

  go(to: string, { replace = false } = {}) {
    const url = BASE + to;
    if (url === location.pathname + location.search) return;
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    const [p, q] = to.split("?");
    this.path = p.replace(/\/+$/, "") || "/map";
    this.query = new URLSearchParams(q || "");
  }

  /** The path's parts: "/map/area/12" → ["map", "area", "12"]. */
  get parts(): string[] {
    return this.path.split("/").filter(Boolean);
  }
}

export const router = new Router();

/** For <a href>: the real address, so a middle click opens a tab. */
export const href = (to: string) => BASE + to;

/** On an <a>: a plain click navigates inside the app; anything else is the browser's. */
export function link(node: HTMLAnchorElement) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = node.getAttribute("href") || "";
    if (!a.startsWith(BASE)) return;
    e.preventDefault();
    router.go(a.slice(BASE.length) || "/map");
  };
  node.addEventListener("click", onClick);
  return { destroy: () => node.removeEventListener("click", onClick) };
}
