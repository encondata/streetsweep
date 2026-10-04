// A team's areas (drawn and followed), and the same as map features: shared by the Map
// page (which shows them) and the Areas page (which manages them), so both draw an
// area the same colour and shade it the same way once it's finished.
import { api } from "./api";
import { assignAreaColors } from "./areaColors";
import type { Area } from "./types";

export interface TeamAreas { areas: Area[]; can_edit: boolean }

export const loadTeamAreas = (teamId: string) => api<TeamAreas>(`/api/teams/${teamId}/areas`);

/** Every street driven or marked done (the ones left out don't count against it). */
export const isComplete = (a: Area) => a.build_status === "built" && !!a.total_m && (a.driven_m ?? 0) >= a.total_m * 0.9999;

export function areaFeatures(areas: Area[]): GeoJSON.Feature[] {
  const colors = assignAreaColors(areas);
  return areas.filter((a) => a.geometry).map((a) => ({
    type: "Feature", id: a.id,
    properties: { id: a.id, level: a.level, color: colors.get(a.id), complete: isComplete(a) },
    geometry: a.geometry!,
  }));
}
