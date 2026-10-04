export type Role = "owner" | "admin" | "driver" | "viewer";

export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_site_admin: boolean;
  created_at: string;
  /** Free-form settings: map_colors, onboarded. */
  preferences?: { map_colors?: import("./colors").MapColors; onboarded?: boolean; settings?: import("./settings").AppSettings; shade_complete?: boolean };
}

export interface TeamSummary {
  id: string;
  name: string;
  kind: "personal" | "shared";
  role: Role;
  pending_requests: number;
}

export interface Me {
  user: User;
  teams: TeamSummary[];
}

export interface Member {
  user_id: string;
  display_name: string;
  email?: string;
  avatar_url: string | null;
  role: Role;
  joined_at: string;
}

export interface JoinRequest {
  id: string;
  message: string | null;
  requested_at: string;
  user_id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
}

export interface DriveTypeToggle {
  key: string;
  label: string;
  icon: string | null;
  counts: boolean;
}

export interface TeamDetail {
  team: { id: string; name: string; kind: "personal" | "shared"; listed: boolean; join_code?: string };
  my_role: Role | null;
  can_admin: boolean;
  members: Member[];
  drive_types: DriveTypeToggle[];
  requests: JoinRequest[];
}

export interface TeamPreview {
  team: { id: string; name: string; kind: string; listed: boolean; member_count: number };
  my_role: Role | null;
  my_request: { id: string; status: string; requested_at: string } | null;
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", driver: "Driver", viewer: "Viewer" };
export const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including deleting the team and making other owners",
  admin: "Approves join requests, manages members and settings",
  driver: "Drives count toward the team's coverage",
  viewer: "Can look, doesn't drive for the team",
};

// ---- fleet ----

export type VehicleKind = "car" | "suv" | "van" | "truck" | "motorcycle" | "other";
export const VEHICLE_KINDS: { key: VehicleKind; label: string }[] = [
  { key: "car", label: "Car" }, { key: "suv", label: "SUV" }, { key: "van", label: "Van" },
  { key: "truck", label: "Truck" }, { key: "motorcycle", label: "Motorcycle" }, { key: "other", label: "Other" },
];

export interface VehicleFormValue {
  name: string; kind: VehicleKind; make: string; model: string; color: string; plate: string;
  /** A number input binds as a number, or null when empty. */
  year: number | string | null;
  checkout_policy: "open" | "admin_only";
}

export interface PersonRef {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}

export interface Vehicle {
  id: string;
  name: string;
  kind: VehicleKind;
  make: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  plate: string | null;
  checkout_policy: "open" | "admin_only";
  team_id: string;
  team_name: string;
  team_kind: "personal" | "shared";
  my_role: Role | null;
  photo_url: string | null;
  archived_at: string | null;
  created_at: string;
  checkout: (PersonRef & { id: string; since: string; note: string | null }) | null;
  assigned: (PersonRef & { id: string; since: string })[];
  logger_count: number;
}

export interface VehicleDetail {
  vehicle: Vehicle;
  can_admin: boolean;
  can_drive: boolean;
  history: {
    id: string; kind: "permanent" | "checkout"; started_at: string; ended_at: string | null; note: string | null;
    user_id: string; display_name: string; avatar_url: string | null;
    assigned_by_name: string | null; ended_by_name: string | null;
  }[];
  loggers: { id: string; name: string; last_seen_at: string | null; firmware_version: string | null; installed_at: string; owner_name: string; mine: boolean }[];
  drivers: (PersonRef & { role: Role })[];
}

export interface Logger {
  id: string;
  name: string;
  owner_user_id: string;
  owner_name: string;
  default_drive_type_key: string;
  default_drive_type_label: string;
  hardware_id: string | null;
  firmware_version: string | null;
  last_battery_mv: number | null;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
  installed: { install_id: string; vehicle_id: string; vehicle_name: string; team_name: string; since: string } | null;
}

export interface LoggerSetup {
  logger_id: string;
  secret: string;
  server: string;
  config_url: string;
}

export interface LoggerDetail {
  logger: Logger;
  history: { id: string; vehicle_id: string; vehicle_name: string; started_at: string; ended_at: string | null }[];
  setup?: LoggerSetup;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  app_version: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface DriveType {
  key: string;
  label: string;
  icon: string | null;
  sort: number;
  archived_at: string | null;
}

/** "2022 Ford Transit · ABC 123" */
export function vehicleLine(v: Pick<Vehicle, "year" | "make" | "model" | "plate" | "color">): string {
  const what = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return [what || null, v.color, v.plate].filter(Boolean).join(" · ");
}

// ---- areas ----

export type AreaLevel = "state" | "county" | "city" | "neighborhood" | "section" | "custom";
export const LEVEL_LABEL: Record<AreaLevel, string> = {
  state: "State", county: "County", city: "City", neighborhood: "Neighborhood", section: "Section", custom: "Custom area",
};

export interface Area {
  id: string;
  name: string;
  level: AreaLevel;
  source: "drawn" | "osm_boundary";
  team_id: string | null;
  team_name?: string | null;
  parent_id: string | null;
  parent_name: string | null;
  color: string | null;
  notes: string | null;
  version: number;
  build_status: "none" | "queued" | "building" | "built" | "failed";
  built_version: number | null;
  built_at: string | null;
  build_error?: string | null;
  segment_count: number | null;
  street_m: number | null;
  km2: number;
  bbox: [number, number, number, number];
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  followed?: boolean;
  followed_by?: string[];
  /** In a team's list: how much of it the team has swept (only once its streets are listed). */
  total_m?: number | null;
  driven_m?: number | null;
  total_segments?: number | null;
  driven_segments?: number | null;
  /** Other areas in the same list that touch or overlap this one (for colouring). */
  neighbors?: string[];
}

/** Area colours, given out automatically so neighbours differ (lib/areaColors). Bright and
 * far apart, so an outline reads on satellite imagery as well as on the plain map. */
export const AREA_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#21b8d8", "#f032e6", "#d4a017"];

// ---- drives ----

export type Attribution = "explicit" | "inferred" | "unknown" | "edited";

export interface Drive {
  id: string;
  source: "phone" | "logger";
  status: "received" | "matching" | "matched" | "failed";
  match_method: string | null;
  match_error: string | null;
  started_at: string;
  ended_at: string;
  distance_m: number;
  point_count: number;
  segment_count: number | null;
  drive_type_key: string;
  drive_type_label: string;
  attribution: Attribution;
  user_id: string | null;
  user_name: string | null;
  user_avatar_url: string | null;
  vehicle_id: string | null;
  vehicle_name: string | null;
  vehicle_kind: VehicleKind | null;
  vehicle_team_id: string | null;
  logger_id: string | null;
  logger_name: string | null;
  logger_owner_id: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface DriveDetail {
  drive: Drive;
  track: GeoJSON.LineString | null;
  streets: GeoJSON.MultiLineString | null;
  counts_for: { id: string; name: string; kind: "personal" | "shared" }[];
  can_edit: boolean;
  can_set_driver: boolean;
}

export interface Segment {
  id: number;
  name: string | null;
  highway: string;
  length_m: number;
  first_driven_at: string | null;
  passes: number | null;
  first_driver: string | null;
  mark: "complete" | "excluded" | null;
  mark_note: string | null;
  marked_by: string | null;
  marked_at: string | null;
}

// ---- insights ----

export interface Figures { drives: number; drive_m: number; streets: number; street_m: number }
export interface Stats {
  total: Figures;
  month: Figures;
  weeks: { week: string; street_m: number; drive_m: number }[];
  month_drivers?: number;
  members?: number;
}

export type Tier = "common" | "uncommon" | "rare" | "legendary";
export interface LadderStep { level: number; name: string; art: string; tier: Tier; need: number; earned: boolean; earned_at: string | null; rarity: number }
export interface Ladder {
  kind: "ladder"; code: string; name: string; icon: string; blurb: string; unit: string; category: string;
  level: number; top: number; value: number; next: number | null; progress: number; earned_at: string | null;
  steps: LadderStep[];
}
export interface Badge {
  kind: "badge"; code: string; name: string; icon: string; blurb: string; category: string; art: string; tier: Tier;
  earned: boolean; earned_at: string | null; progress: { value: number; need: number } | null; rarity: number;
}
export interface AchievementSet { ladders: Ladder[]; badges: Badge[]; earned_count: number; total: number; eligible: number }

export type Board = "new" | "miles" | "drives";
export type Period = "week" | "month" | "all";
export interface LeaderRow { user_id: string; display_name: string; avatar_url: string | null; value: number; extra: number; rank: number }

export interface Place {
  id: string;
  name: string;
  note: string | null;
  lon: number;
  lat: number;
  drive_id: string | null;
  created_at: string;
  updated_at: string;
  user_id: string;
  user_name: string;
  user_avatar_url: string | null;
  mine: boolean;
  shared_with: { id: string; name: string; kind: "personal" | "shared" }[];
  photos: { id: string; width: number | null; height: number | null }[];
}

export const TIER_LABEL: Record<Tier, string> = { common: "Common", uncommon: "Uncommon", rare: "Rare", legendary: "Legendary" };
