import type { Level } from "./types";

/** Smallest first — the phone's ladder, in the phone's order. */
export const LEVEL_ORDER: Level[] = ["NEIGHBORHOOD", "CITY", "COUNTY", "METRO", "REGION", "STATE", "COUNTRY"];

export const LEVEL_LABEL: Record<Level, string> = {
  NEIGHBORHOOD: "Neighborhood",
  CITY: "City",
  COUNTY: "County",
  METRO: "Metro area",
  REGION: "Region",
  STATE: "State",
  COUNTRY: "Country",
};

export const LEVEL_COLOR: Record<Level, string> = {
  NEIGHBORHOOD: "#0b6b57",
  CITY: "#45607a",
  COUNTY: "#6f5aa8",
  METRO: "#b8762b",
  REGION: "#a4553d",
  STATE: "#7d4a63",
  COUNTRY: "#4f5d6b",
};

/** States and countries only group other areas: nothing is downloaded or counted for them. */
export const ORGANIZATIONAL = new Set<Level>(["STATE", "COUNTRY"]);

export const levelRank = (l: Level) => LEVEL_ORDER.indexOf(l);

/** A–Z, case ignored, "Unit 2" before "Unit 10". */
export const abc = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
