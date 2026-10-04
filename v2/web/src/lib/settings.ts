// How the app behaves for you (Settings on your page): where it opens, the map style it
// starts in, and the team Home and the map show first. Kept on the server, so they
// follow you to any browser. On this device, the map remembers a style or team you
// switch to; these are what it starts from.
import { session } from "./session.svelte";

export type StartPage = "home" | "map" | "drives";
export type BaseStyle = "map" | "satellite" | "hybrid";
export interface AppSettings { start_page?: StartPage; base?: BaseStyle; team_id?: string | null }

export function mySettings(): AppSettings {
  return session.me?.user.preferences?.settings ?? {};
}

/** The team to open on: this device's last choice, else your setting, else just you. */
export function defaultTeam(storageKey: string): string {
  const teams = session.me!.teams;
  try {
    const t = localStorage.getItem(storageKey);
    if (t && teams.some((x) => x.id === t)) return t;
  } catch { /* private window */ }
  const chosen = mySettings().team_id;
  if (chosen && teams.some((x) => x.id === chosen)) return chosen;
  return teams.find((t) => t.kind === "personal")?.id ?? teams[0]?.id ?? "";
}
