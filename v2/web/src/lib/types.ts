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
