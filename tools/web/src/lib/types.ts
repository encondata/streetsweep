/** [lat, lng], the order the server stores outlines and street shapes in. */
export type LatLng = [number, number];
export type Ring = LatLng[];

export type Level = "NEIGHBORHOOD" | "CITY" | "COUNTY" | "METRO" | "REGION" | "STATE" | "COUNTRY";

export type Role = "admin" | "driver" | "viewer";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  hasAvatar: boolean;
  avatarVersion: number;
}

/** An area as the server keeps it. parentName is the first parent; alsoIn the rest. */
export interface Area {
  id: number;
  name: string;
  level: Level;
  parentName: string | null;
  alsoIn: string[];
  city: string | null;
  notes: string | null;
  color: string | null;
  /** The main piece. */
  polygon: Ring;
  /** Any further pieces: a county of islands, a city with an exclave. */
  morePieces: Ring[];
  createdAt: string;
  updatedAt: string;
}

/** What the editor sends; the server works out the box and the rest. */
export interface AreaDraft {
  name: string;
  level: Level;
  parentName: string | null;
  alsoIn: string[];
  city: string | null;
  notes: string | null;
  color: string | null;
  polygon: Ring;
  morePieces: Ring[];
}

/** The server's count of an area, by name (GET /api/areas/progress). */
export interface AreaProgress {
  name: string;
  total: number;
  done: number;
  partial: number;
  excluded: number;
  marked: number;
  metersTotal: number;
  metersDriven: number;
  computedAt: number | null;
  pending: boolean;
}

export type StreetStatus = "done" | "partial" | "none" | "marked" | "excluded";

export type ExclusionReason = "GATED" | "NOT_DRIVABLE" | "NOT_NEEDED" | "OTHER";

/** An area's streets with the server's verdict on each (GET /api/areas/:id/network?status=1). */
export interface Network {
  streets: number;
  lines: LatLng[][];
  ids: number[];
  names: (string | null)[];
  lengths: number[];
  driven: number[];
  status: StreetStatus[];
  completed: { wayId: number; updatedAt: number; by: string | null }[];
  excluded: { wayId: number; reason: ExclusionReason; note: string | null; updatedAt: number; by: string | null }[];
  cells: number;
  stale: boolean;
}
