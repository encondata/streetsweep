import type { MapController } from "./map";

export interface Toast { id: number; text: string; tone?: "bad" | "good"; undo?: () => Promise<void> | void }

/** What the map workspace's panels share: the map itself, messages, and undo. */
class Workspace {
  map = $state.raw<MapController | null>(null);
  /** An area being pointed at in a list, outlined on the map. */
  hover = $state<number | null>(null);
  toasts = $state<Toast[]>([]);
  private next = 1;

  say(text: string, opts: { tone?: "bad" | "good"; undo?: () => Promise<void> | void; ms?: number } = {}) {
    const t: Toast = { id: this.next++, text, tone: opts.tone, undo: opts.undo };
    this.toasts = [...this.toasts.slice(-2), t];
    setTimeout(() => this.dismiss(t.id), opts.ms ?? (opts.undo ? 7000 : 3500));
  }

  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const ws = new Workspace();
