import { api } from "./api";
import type { Me } from "./types";

class Session {
  me = $state<Me | null>(null);

  async load() {
    this.me = await api<Me>("/api/me");
  }

  set(me: Me) {
    this.me = me;
  }

  /** Re-read after anything that changes team membership or roles. */
  refresh() {
    return this.load().catch(() => {});
  }

  get pendingForMe() {
    return this.me?.teams.reduce((n, t) => n + t.pending_requests, 0) ?? 0;
  }
}

export const session = new Session();
