// Achievements, for people and for teams.
//
// People's set is v1's (tools/server/achievements.js): a few ladders for "more of the
// same" (one badge with levels) and named badges for things that mean something
// different. Teams get their own, counted from the team's coverage.
//
// Everything is counted from records that already exist (drives, segment passes, team
// coverage, area street lists), so a badge can't drift from what it describes. The one
// fact stored is when each was first reached, which the counts can't reconstruct.
import type pg from "pg";
import { config } from "../config.js";
import { COUNTS_FOR } from "../drives/coverage.js";

type Db = pg.Pool | pg.PoolClient;
export type Tier = "common" | "uncommon" | "rare" | "legendary";
const MILE = 1609.344;

interface Ladder<F> {
  code: string; name: string; icon: string; category: string; blurb: string; unit: string;
  levels: number[];
  /** [name, art, tier] per level. */
  steps: [string, string, Tier][];
  value: (f: F) => number;
}
interface Badge<F> {
  code: string; name: string; icon: string; category: string; blurb: string; art: string; tier: Tier;
  /** How far along, as [value, need]; earned when value >= need. */
  measure: (f: F) => [number, number];
  /** Extra condition beyond the measure (So Close stops counting once an area is done). */
  also?: (f: F) => boolean;
  /** A yes/no badge shows no progress bar. */
  yesNo?: boolean;
}

// ---- people ------------------------------------------------------------------------

interface PersonFigures {
  streets: number; miles: number; sundayStreets: number;
  bestDriveStreets: number; bestDriveNewMiles: number;
  drivingDays: number; nightDrives: number; earlyDrives: number;
  areasCompleted: number; areasDrivenIn: number; bestAreaPct: number;
  weekends: number; monthRun: number;
}

const PERSON_LADDERS: Ladder<PersonFigures>[] = [
  {
    code: "streets", name: "Street Sweeper", icon: "broom", category: "progression", unit: "streets",
    blurb: "Street segments you've driven for the first time",
    levels: [1, 50, 100, 500, 1000, 2500, 5000, 10000],
    steps: [
      ["First Sweep", "first_sweep", "common"], ["Street Scout", "street_scout", "common"],
      ["Street Sweeper", "street_sweeper", "uncommon"], ["Road Warrior", "road_warrior", "uncommon"],
      ["Street Master", "street_master", "rare"], ["Urban Explorer", "urban_explorer", "rare"],
      ["Road Legend", "road_legend", "legendary"], ["Every Road Leads Somewhere", "every_road", "legendary"],
    ],
    value: (f) => f.streets,
  },
  {
    code: "miles", name: "New Mileage", icon: "road", category: "progression", unit: "miles",
    blurb: "Miles of street you've covered for the first time",
    levels: [1, 25, 100, 250, 500, 1000, 2500, 3000, 10000],
    steps: [
      ["First Mile", "first_mile", "common"], ["Getting Around", "getting_around", "common"],
      ["Road Tripper", "road_tripper", "uncommon"], ["Explorer", "explorer_250", "uncommon"],
      ["Long Haul", "long_haul", "rare"], ["Thousand Miler", "thousand_miler", "rare"],
      ["Serious Mileage", "serious_mileage", "legendary"], ["Coast to Coast", "coast_to_coast", "legendary"],
      ["Globe Trotter", "globe_trotter", "legendary"],
    ],
    value: (f) => f.miles,
  },
  {
    code: "areas", name: "Area Collector", icon: "map", category: "areas", unit: "areas",
    blurb: "Areas you've personally taken to 100%",
    levels: [1, 2, 5, 10, 25, 50],
    steps: [
      ["First Territory", "first_territory", "uncommon"], ["Double Sweep", "double_sweep", "uncommon"],
      ["Neighborhood Hero", "neighborhood_hero", "rare"], ["Area Collector", "area_collector", "rare"],
      ["Territory Master", "territory_master", "legendary"], ["Map Conqueror", "map_conqueror", "legendary"],
    ],
    value: (f) => f.areasCompleted,
  },
];

const PERSON_BADGES: Badge<PersonFigures>[] = [
  { code: "clean_sweep", category: "areas", art: "clean_sweep", tier: "legendary", name: "Clean Sweep", icon: "trophy",
    blurb: "Personally drive every street in an area, not just be there at the end", measure: (f) => [f.areasCompleted, 1], yesNo: true },
  { code: "quarter_sweep", category: "areas", art: "fresh_pavement", tier: "common", name: "Quarter Sweep", icon: "pie",
    blurb: "Cover a quarter of an area yourself", measure: (f) => [f.bestAreaPct, 25] },
  { code: "halfway", category: "areas", art: "trailblazer", tier: "uncommon", name: "Halfway There", icon: "pie",
    blurb: "Cover half an area yourself", measure: (f) => [f.bestAreaPct, 50] },
  { code: "three_quarters", category: "areas", art: "completionist", tier: "uncommon", name: "Three Quarters", icon: "pie",
    blurb: "Cover three quarters of an area yourself", measure: (f) => [f.bestAreaPct, 75] },
  { code: "almost_there", category: "areas", art: "just_one_more", tier: "rare", name: "Almost There", icon: "pie",
    blurb: "Get an area to 90% on your own", measure: (f) => [f.bestAreaPct, 90] },
  { code: "so_close", category: "areas", art: "cul_de_sac_king", tier: "rare", name: "So Close", icon: "pie",
    blurb: "Get an area to 99%, and go find the cul-de-sac you missed", measure: (f) => [f.bestAreaPct, 99], also: (f) => f.areasCompleted === 0 },

  { code: "explorer", category: "exploration", art: "explorer", tier: "uncommon", name: "Explorer", icon: "compass",
    blurb: "Drive streets in five different areas", measure: (f) => [f.areasDrivenIn, 5] },
  { code: "wanderer", category: "exploration", art: "wanderer", tier: "rare", name: "Wanderer", icon: "compass",
    blurb: "Drive streets in ten different areas", measure: (f) => [f.areasDrivenIn, 10] },

  { code: "quick_sweep", category: "drives", art: "quick_sweep", tier: "common", name: "Quick Sweep", icon: "bolt",
    blurb: "Ten new street segments in one drive", measure: (f) => [f.bestDriveStreets, 10] },
  { code: "productive_drive", category: "drives", art: "productive_drive", tier: "uncommon", name: "Productive Drive", icon: "bolt",
    blurb: "Twenty-five new street segments in one drive", measure: (f) => [f.bestDriveStreets, 25] },
  { code: "big_sweep", category: "drives", art: "big_sweep", tier: "rare", name: "Big Sweep", icon: "bolt",
    blurb: "Fifty new street segments in one drive", measure: (f) => [f.bestDriveStreets, 50] },
  { code: "mega_sweep", category: "drives", art: "mega_sweep", tier: "legendary", name: "Mega Sweep", icon: "bolt",
    blurb: "A hundred new street segments in one drive", measure: (f) => [f.bestDriveStreets, 100] },
  { code: "century_drive", category: "drives", art: "century_drive", tier: "legendary", name: "Century Drive", icon: "bolt",
    blurb: "A hundred miles of new street in one drive", measure: (f) => [round1(f.bestDriveNewMiles), 100] },

  { code: "sunday_driver", category: "special", art: "sunday_driver", tier: "common", name: "Sunday Driver", icon: "sun",
    blurb: "Twenty-five new street segments on a Sunday", measure: (f) => [f.sundayStreets, 25] },
  { code: "early_bird", category: "special", art: "early_bird", tier: "uncommon", name: "Early Bird", icon: "sun",
    blurb: "A drive that starts between 4 and 6 AM", measure: (f) => [f.earlyDrives, 1], yesNo: true },
  { code: "night_owl", category: "special", art: "night_owl", tier: "uncommon", name: "Night Owl", icon: "moon",
    blurb: "A drive that starts after midnight, before 4 AM", measure: (f) => [f.nightDrives, 1], yesNo: true },
  { code: "rain_or_shine", category: "special", art: "rain_or_shine", tier: "rare", name: "Rain or Shine", icon: "calendar",
    blurb: "Drive on thirty different days", measure: (f) => [f.drivingDays, 30] },
  { code: "weekend_warrior", category: "special", art: "roundabout", tier: "uncommon", name: "Weekend Warrior", icon: "calendar",
    blurb: "New streets on four different weekends", measure: (f) => [f.weekends, 4] },
  { code: "monthly_explorer", category: "special", art: "county_hopper", tier: "uncommon", name: "Monthly Explorer", icon: "calendar",
    blurb: "New streets in three months running", measure: (f) => [f.monthRun, 3] },
  { code: "dedicated_sweeper", category: "special", art: "state_explorer", tier: "rare", name: "Dedicated Sweeper", icon: "calendar",
    blurb: "New streets in six months running", measure: (f) => [f.monthRun, 6] },
  { code: "regular", category: "special", art: "world_traveler", tier: "legendary", name: "StreetSweep Regular", icon: "calendar",
    blurb: "New streets in twelve months running", measure: (f) => [f.monthRun, 12] },
];

/** A person's first pass over each segment, from their own matched drives. */
const MY_FIRSTS = `
  SELECT DISTINCT ON (p.segment_id) p.segment_id, p.driven_at, p.drive_id, s.length_m
    FROM segment_passes p
    JOIN drives d ON d.id = p.drive_id
    JOIN street_segments s ON s.id = p.segment_id
   WHERE d.user_id = $1 AND d.deleted_at IS NULL AND d.status = 'matched'
   ORDER BY p.segment_id, p.driven_at`;

/** Areas the person's teams track (drawn or followed), with their streets listed. */
const MY_AREAS = `
  SELECT a.id, a.street_m FROM areas a
   WHERE a.deleted_at IS NULL AND a.build_status = 'built' AND a.street_m > 0 AND (
     a.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND left_at IS NULL)
     OR a.id IN (SELECT ta.area_id FROM team_areas ta JOIN team_members m ON m.team_id = ta.team_id
                  WHERE m.user_id = $1 AND m.left_at IS NULL))`;

const local = (col: string) => `(${col} AT TIME ZONE $2)`;

export async function personFigures(db: Db, userId: string): Promise<PersonFigures> {
  const tz = config.timezone;
  const [firsts, perDrive, drives, areas, buckets] = await Promise.all([
    db.query(
      `WITH f AS (${MY_FIRSTS})
       SELECT count(*)::int AS streets, coalesce(sum(length_m), 0)::float AS meters,
              count(*) FILTER (WHERE extract(dow FROM ${local("driven_at")}) = 0)::int AS sunday
         FROM f`, [userId, tz]),
    db.query(
      `WITH f AS (${MY_FIRSTS})
       SELECT coalesce(max(n), 0)::int AS best_streets, coalesce(max(m), 0)::float AS best_meters
         FROM (SELECT drive_id, count(*) AS n, sum(length_m) AS m FROM f GROUP BY drive_id) x`, [userId]),
    db.query(
      `SELECT count(DISTINCT ${local("started_at")}::date)::int AS days,
              -- Split, so one drive at 1 AM is a Night Owl drive, not both.
              count(*) FILTER (WHERE extract(hour FROM ${local("started_at")}) < 4)::int AS night,
              count(*) FILTER (WHERE extract(hour FROM ${local("started_at")}) BETWEEN 4 AND 5)::int AS early
         FROM drives WHERE user_id = $1 AND deleted_at IS NULL AND status = 'matched'`, [userId, tz]),
    // Their own share of each area: what they drove, not the team's, and not marks.
    db.query(
      `WITH f AS (${MY_FIRSTS}), my AS (${MY_AREAS}),
            got AS (SELECT s.area_id, sum(s.inside_m) AS m FROM f JOIN area_segments s ON s.segment_id = f.segment_id
                     WHERE s.area_id IN (SELECT id FROM my) GROUP BY s.area_id)
       SELECT count(*) FILTER (WHERE got.m >= my.street_m * 0.9999)::int AS completed,
              count(*)::int AS driven_in,
              coalesce(max(least(100, got.m / my.street_m * 100)), 0)::float AS best_pct
         FROM got JOIN my ON my.id = got.area_id`, [userId]),
    db.query(
      `WITH f AS (${MY_FIRSTS})
       SELECT DISTINCT to_char(${local("driven_at")}, 'IYYY-IW') AS week, to_char(${local("driven_at")}, 'YYYY-MM') AS month,
              extract(isodow FROM ${local("driven_at")})::int AS dow
         FROM f`, [userId, tz]),
  ]);
  const weekends = new Set<string>();
  const months = new Set<string>();
  for (const r of buckets.rows) {
    months.add(r.month);
    if (r.dow >= 6) weekends.add(r.week);
  }
  return {
    streets: firsts.rows[0].streets,
    miles: firsts.rows[0].meters / MILE,
    sundayStreets: firsts.rows[0].sunday,
    bestDriveStreets: perDrive.rows[0].best_streets,
    bestDriveNewMiles: perDrive.rows[0].best_meters / MILE,
    drivingDays: drives.rows[0].days,
    nightDrives: drives.rows[0].night,
    earlyDrives: drives.rows[0].early,
    areasCompleted: areas.rows[0].completed,
    areasDrivenIn: areas.rows[0].driven_in,
    bestAreaPct: areas.rows[0].best_pct,
    weekends: weekends.size,
    monthRun: longestRun([...months].sort(), monthNumber),
  };
}

// ---- teams -------------------------------------------------------------------------

interface TeamFigures {
  streets: number; miles: number; areasCompleted: number; bestAreaPct: number;
  bestDayDrivers: number; bestWeekDrivers: number; bestWeekMiles: number;
  driversWithStreets: number; drivers: number; weekRun: number;
}

const TEAM_LADDERS: Ladder<TeamFigures>[] = [
  {
    code: "team_streets", name: "Team Sweep", icon: "broom", category: "progression", unit: "streets",
    blurb: "Street segments the team has swept",
    levels: [100, 1000, 5000, 25000, 100000],
    steps: [
      ["Off the Line", "team_off_the_line", "common"], ["Street Crew", "team_street_crew", "uncommon"],
      ["Sweep Squad", "team_sweep_squad", "rare"], ["Road Gang", "team_road_gang", "legendary"],
      ["City Cleaners", "team_city_cleaners", "legendary"],
    ],
    value: (f) => f.streets,
  },
  {
    code: "team_miles", name: "Team Mileage", icon: "road", category: "progression", unit: "miles",
    blurb: "Miles of street the team has swept",
    levels: [10, 100, 500, 2500, 10000],
    steps: [
      ["Ten Together", "team_ten_together", "common"], ["Hundred Club", "team_hundred_club", "uncommon"],
      ["Long Road", "team_long_road", "rare"], ["Highway Crew", "team_highway_crew", "legendary"],
      ["Ten Thousand Strong", "team_ten_thousand", "legendary"],
    ],
    value: (f) => f.miles,
  },
  {
    code: "team_areas", name: "Territory", icon: "map", category: "areas", unit: "areas",
    blurb: "Areas the team has taken to 100% (streets marked done count)",
    levels: [1, 3, 10, 25],
    steps: [
      ["Flag Planted", "team_flag_planted", "uncommon"], ["Hat Trick", "team_hat_trick", "rare"],
      ["Ten Down", "team_ten_down", "legendary"], ["Empire", "team_empire", "legendary"],
    ],
    value: (f) => f.areasCompleted,
  },
];

const TEAM_BADGES: Badge<TeamFigures>[] = [
  { code: "team_halfway", category: "areas", art: "team_halfway", tier: "uncommon", name: "Halfway There", icon: "pie",
    blurb: "Get one of the team's areas to 50%", measure: (f) => [f.bestAreaPct, 50] },
  { code: "team_nearly", category: "areas", art: "team_nearly", tier: "rare", name: "Nearly Done", icon: "pie",
    blurb: "Get one of the team's areas to 90%", measure: (f) => [f.bestAreaPct, 90] },
  { code: "team_relay", category: "together", art: "team_relay", tier: "uncommon", name: "Relay", icon: "teams",
    blurb: "Three different drivers drive for the team on the same day", measure: (f) => [f.bestDayDrivers, 3] },
  { code: "team_full_crew", category: "together", art: "team_full_crew", tier: "rare", name: "Full Crew", icon: "teams",
    blurb: "Three different drivers add new streets in the same week", measure: (f) => [f.bestWeekDrivers, 3] },
  { code: "team_all_hands", category: "together", art: "team_all_hands", tier: "rare", name: "All Hands", icon: "teams",
    blurb: "Every driver on the team (three or more) has added new streets",
    measure: (f) => [f.driversWithStreets, Math.max(3, f.drivers)] },
  { code: "team_big_week", category: "together", art: "team_big_week", tier: "rare", name: "Big Week", icon: "bolt",
    blurb: "Fifty miles of new street in one week", measure: (f) => [round1(f.bestWeekMiles), 50] },
  { code: "team_on_a_roll", category: "together", art: "team_on_a_roll", tier: "uncommon", name: "On a Roll", icon: "calendar",
    blurb: "New streets four weeks running", measure: (f) => [f.weekRun, 4] },
  { code: "team_season", category: "together", art: "team_season", tier: "legendary", name: "All Season", icon: "calendar",
    blurb: "New streets twelve weeks running", measure: (f) => [f.weekRun, 12] },
];

/** A team's area progress, as the area list counts it (marks included). */
const TEAM_AREA_PCT = `
  SELECT a.id,
         sum(s.inside_m) FILTER (WHERE mk.kind IS DISTINCT FROM 'excluded') AS total,
         sum(s.inside_m) FILTER (WHERE mk.kind IS DISTINCT FROM 'excluded' AND (c.segment_id IS NOT NULL OR mk.kind = 'complete')) AS done
    FROM areas a
    JOIN area_segments s ON s.area_id = a.id
    LEFT JOIN team_coverage c ON c.team_id = $1 AND c.segment_id = s.segment_id
    LEFT JOIN segment_marks mk ON mk.team_id = $1 AND mk.segment_id = s.segment_id
   WHERE a.deleted_at IS NULL AND a.build_status = 'built'
     AND (NOT s.major OR coalesce((SELECT count_highways FROM teams WHERE id = $1), false))
     AND (a.team_id = $1 OR a.id IN (SELECT area_id FROM team_areas WHERE team_id = $1))
     -- A whole state is too big to sum on every drive; its progress shows, but no badge.
     AND a.segment_count < 400000
   GROUP BY a.id`;

export async function teamFigures(db: Db, teamId: string): Promise<TeamFigures> {
  const tz = config.timezone;
  const [cov, areas, days, weeks, members] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS streets, coalesce(sum(s.length_m), 0)::float AS meters
         FROM team_coverage c JOIN street_segments s ON s.id = c.segment_id JOIN street_ways w ON w.way_id = s.way_id
        WHERE c.team_id = $1 AND (w.highway NOT IN ('trunk', 'motorway') OR coalesce((SELECT count_highways FROM teams WHERE id = $1), false))`, [teamId]),
    db.query(
      `SELECT count(*) FILTER (WHERE total > 0 AND done >= total * 0.9999)::int AS completed,
              coalesce(max(CASE WHEN total > 0 THEN least(100, coalesce(done, 0) / total * 100) END), 0)::float AS best_pct
         FROM (${TEAM_AREA_PCT}) x`, [teamId]),
    // Drivers per day, over the drives that count for the team.
    db.query(
      `SELECT coalesce(max(n), 0)::int AS best FROM (
         SELECT (d.started_at AT TIME ZONE $2)::date, count(DISTINCT d.user_id) AS n
           FROM drives d
          WHERE d.user_id IS NOT NULL AND d.deleted_at IS NULL AND d.status = 'matched' AND ${COUNTS_FOR("$1::uuid")}
          GROUP BY 1) x`, [teamId, tz]),
    db.query(
      `SELECT to_char(c.first_driven_at AT TIME ZONE $2, 'IYYY-IW') AS week,
              count(DISTINCT d.user_id)::int AS drivers, sum(s.length_m)::float AS meters
         FROM team_coverage c JOIN street_segments s ON s.id = c.segment_id
         LEFT JOIN drives d ON d.id = c.first_drive_id
        WHERE c.team_id = $1 GROUP BY 1 ORDER BY 1`, [teamId, tz]),
    db.query(
      `SELECT count(*) FILTER (WHERE m.role <> 'viewer')::int AS drivers,
              count(*) FILTER (WHERE m.role <> 'viewer' AND EXISTS (
                SELECT 1 FROM team_coverage c JOIN drives d ON d.id = c.first_drive_id
                 WHERE c.team_id = $1 AND d.user_id = m.user_id))::int AS with_streets
         FROM team_members m WHERE m.team_id = $1 AND m.left_at IS NULL`, [teamId]),
  ]);
  return {
    streets: cov.rows[0].streets,
    miles: cov.rows[0].meters / MILE,
    areasCompleted: areas.rows[0].completed,
    bestAreaPct: areas.rows[0].best_pct,
    bestDayDrivers: days.rows[0].best,
    bestWeekDrivers: Math.max(0, ...weeks.rows.map((r) => r.drivers)),
    bestWeekMiles: Math.max(0, ...weeks.rows.map((r) => r.meters / MILE)),
    driversWithStreets: members.rows[0].with_streets,
    drivers: members.rows[0].drivers,
    weekRun: longestRun(weeks.rows.map((r) => r.week), weekNumber),
  };
}

// ---- shared ------------------------------------------------------------------------

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
const monthNumber = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return y * 12 + mo;
};
/** ISO "IYYY-IW" to a running week number (53-week years are rare enough to ignore a gap). */
const weekNumber = (w: string) => {
  const [y, wk] = w.split("-").map(Number);
  // Weeks since 2000-01-03 (a Monday), worked out from the ISO year's first Thursday.
  const jan4 = Date.UTC(y, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  return Math.round((monday - Date.UTC(2000, 0, 3)) / (7 * 86_400_000)) + wk - 1;
};
/** The longest run of consecutive periods, given each one's running number. */
function longestRun(keys: string[], num: (k: string) => number) {
  let best = 0, run = 0, prev: number | null = null;
  for (const n of keys.map(num).sort((a, b) => a - b)) {
    run = prev !== null && n === prev + 1 ? run + 1 : prev === n ? run : 1;
    prev = n;
    best = Math.max(best, run);
  }
  return best;
}

interface Set_<F> { ladders: Ladder<F>[]; badges: Badge<F>[] }
const PEOPLE: Set_<PersonFigures> = { ladders: PERSON_LADDERS, badges: PERSON_BADGES };
const TEAMS: Set_<TeamFigures> = { ladders: TEAM_LADDERS, badges: TEAM_BADGES };

function earnedNow<F>(set: Set_<F>, f: F): [string, number][] {
  const out: [string, number][] = [];
  for (const l of set.ladders) l.levels.forEach((need, i) => { if (l.value(f) >= need) out.push([l.code, i + 1]); });
  for (const b of set.badges) {
    const [v, need] = b.measure(f);
    if (v >= need && (!b.also || b.also(f))) out.push([b.code, 0]);
  }
  return out;
}

async function record(db: Db, table: "user_achievements" | "team_achievements", col: "user_id" | "team_id", id: string, rows: [string, number][]) {
  if (!rows.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO ${table} (${col}, code, level)
     SELECT $1, x.code, x.level FROM jsonb_to_recordset($2::jsonb) AS x(code text, level int)
     ON CONFLICT DO NOTHING`,
    [id, JSON.stringify(rows.map(([code, level]) => ({ code, level })))],
  );
  return rowCount ?? 0;
}

/** Work out what a person has reached and write down anything new. Safe to repeat. */
export async function evaluatePerson(db: Db, userId: string): Promise<number> {
  return record(db, "user_achievements", "user_id", userId, earnedNow(PEOPLE, await personFigures(db, userId)));
}

/** The same for a team. Personal teams don't get team achievements: that's the person's. */
export async function evaluateTeam(db: Db, teamId: string): Promise<number> {
  const { rows } = await db.query(`SELECT kind FROM teams WHERE id = $1 AND deleted_at IS NULL`, [teamId]);
  if (rows[0]?.kind !== "shared") return 0;
  return record(db, "team_achievements", "team_id", teamId, earnedNow(TEAMS, await teamFigures(db, teamId)));
}

/** Every ladder and badge, earned or not, with progress and how many others hold it. */
function describe<F>(set: Set_<F>, f: F, earned: Map<string, Date>, held: Map<string, number>, pool: number) {
  const share = (code: string, level: number) => Math.round(((held.get(`${code}:${level}`) ?? 0) / Math.max(1, pool)) * 1000) / 10;
  const ladders = set.ladders.map((l) => {
    const value = l.value(f);
    const level = l.levels.filter((need) => value >= need).length;
    const next = l.levels[level] ?? null;
    return {
      kind: "ladder" as const, code: l.code, name: l.name, icon: l.icon, blurb: l.blurb, unit: l.unit, category: l.category,
      level, top: l.levels.length, value: l.unit === "miles" ? round1(value) : value, next,
      progress: next ? Math.min(100, Math.round((value / next) * 100)) : 100,
      earned_at: level ? earned.get(`${l.code}:${level}`) ?? null : null,
      steps: l.steps.map(([name, art, tier], i) => ({
        level: i + 1, name, art, tier, need: l.levels[i], earned: level > i,
        earned_at: earned.get(`${l.code}:${i + 1}`) ?? null, rarity: share(l.code, i + 1),
      })),
    };
  });
  const badges = set.badges.map((b) => {
    const [v, need] = b.measure(f);
    return {
      kind: "badge" as const, code: b.code, name: b.name, icon: b.icon, blurb: b.blurb, category: b.category,
      art: b.art, tier: b.tier, earned: earned.has(`${b.code}:0`), earned_at: earned.get(`${b.code}:0`) ?? null,
      progress: b.yesNo ? null : { value: Math.min(round1(v), need), need },
      rarity: share(b.code, 0),
    };
  });
  const count = badges.filter((b) => b.earned).length + ladders.reduce((n, l) => n + l.level, 0);
  const total = badges.length + ladders.reduce((n, l) => n + l.top, 0);
  return { ladders, badges, earned_count: count, total, eligible: pool };
}

export async function forPerson(db: Db, userId: string) {
  await evaluatePerson(db, userId);
  const [f, mine, counts, eligible] = await Promise.all([
    personFigures(db, userId),
    db.query(`SELECT code, level, earned_at FROM user_achievements WHERE user_id = $1`, [userId]),
    db.query(`SELECT code, level, count(*)::int AS n FROM user_achievements GROUP BY code, level`),
    // Rarity among people who drive at all, not every account.
    db.query(`SELECT count(DISTINCT user_id)::int AS n FROM drives WHERE status = 'matched' AND deleted_at IS NULL`),
  ]);
  return describe(PEOPLE, f,
    new Map(mine.rows.map((r) => [`${r.code}:${r.level}`, r.earned_at])),
    new Map(counts.rows.map((r) => [`${r.code}:${r.level}`, r.n])), eligible.rows[0].n);
}

export async function forTeam(db: Db, teamId: string) {
  await evaluateTeam(db, teamId);
  const [f, mine, counts, eligible] = await Promise.all([
    teamFigures(db, teamId),
    db.query(`SELECT code, level, earned_at FROM team_achievements WHERE team_id = $1`, [teamId]),
    db.query(`SELECT code, level, count(*)::int AS n FROM team_achievements GROUP BY code, level`),
    db.query(`SELECT count(DISTINCT c.team_id)::int AS n FROM team_coverage c JOIN teams t ON t.id = c.team_id WHERE t.kind = 'shared'`),
  ]);
  return describe(TEAMS, f,
    new Map(mine.rows.map((r) => [`${r.code}:${r.level}`, r.earned_at])),
    new Map(counts.rows.map((r) => [`${r.code}:${r.level}`, r.n])), eligible.rows[0].n);
}

/** Art for each achievement (ladder steps and badges), for docs and the web's preload. */
export const ART = [
  ...[...PERSON_LADDERS, ...TEAM_LADDERS].flatMap((l) => l.steps.map((s) => s[1])),
  ...[...PERSON_BADGES, ...TEAM_BADGES].map((b) => b.art),
];
