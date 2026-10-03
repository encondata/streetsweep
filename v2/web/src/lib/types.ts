export type Role = "owner" | "admin" | "driver" | "viewer";

export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_site_admin: boolean;
  created_at: string;
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
