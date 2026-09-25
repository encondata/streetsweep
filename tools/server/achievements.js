"use strict";

/**
 * What someone has managed so far.
 *
 * Two shapes, as the brief asks for. A handful of ladders carry the "do more of the
 * same" families, so eight near-identical rows become one badge with a level on it, and
 * the named ones are kept for things that actually mean something different.
 *
 * Everything here is counted from records that already exist — driven_edges, drives and
 * the areas the phones report. Nothing is stored twice, so a badge cannot drift away
 * from the thing it is describing; the only thing written down is the moment one was
 * first reached, because that is the one fact the counts cannot reconstruct.
 *
 * Deliberately absent, and why, in the note at the bottom of the file.
 */

const METERS_PER_MILE = 1609.344;

/**
 * Where "Sunday", "before 6 AM" and "after midnight" are measured. Drives are stored as
 * UTC moments; without this a Saturday-evening drive in Texas counted as Sunday.
 * TIMEZONE takes any IANA name (America/Chicago, America/Denver, ...).
 */
const TIMEZONE = /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(process.env.TIMEZONE || "")
  ? process.env.TIMEZONE : "America/Chicago";
const LOCAL = (col) => `(to_timestamp(${col}/1000) AT TIME ZONE '${TIMEZONE}')`;

/**
 * The families that are just "more of it". Thresholds from the brief, except that the
 * first street is now level I: the badge art names level I "First Sweep", which the old
 * separate First Sweep badge was, and two achievements for one street was one too many.
 *
 * Each level is its own achievement on the page, with the name and art the design sheet
 * gives it (public/ach-<art>.webp). `tier` is how hard it is to reach — Common, Uncommon,
 * Rare, Legendary, the sheet's bronze, silver, purple and gold. How many people actually
 * hold it is measured separately, as rarity.
 */
const LADDERS = [
  {
    code: "streets", name: "Street Sweeper", icon: "broom", category: "progression",
    blurb: "Streets nobody had recorded before you drove them",
    unit: "streets", levels: [1, 50, 100, 500, 1000, 2500, 5000, 10000],
    steps: [
      ["First Sweep", "first_sweep", "common"], ["Street Scout", "street_scout", "common"],
      ["Street Sweeper", "street_sweeper", "uncommon"], ["Road Warrior", "road_warrior", "uncommon"],
      ["Street Master", "street_master", "rare"], ["Urban Explorer", "urban_explorer", "rare"],
      ["Road Legend", "road_legend", "legendary"], ["Every Road Leads Somewhere", "every_road", "legendary"],
    ],
  },
  {
    code: "miles", name: "New Mileage", icon: "road", category: "progression",
    blurb: "Miles of street you were the first to cover",
    unit: "miles", levels: [1, 25, 100, 250, 500, 1000, 2500, 3000, 10000],
    steps: [
      ["First Mile", "first_mile", "common"], ["Getting Around", "getting_around", "common"],
      ["Road Tripper", "road_tripper", "uncommon"], ["Explorer", "explorer_250", "uncommon"],
      ["Long Haul", "long_haul", "rare"], ["Thousand Miler", "thousand_miler", "rare"],
      ["Serious Mileage", "serious_mileage", "legendary"], ["Coast to Coast", "coast_to_coast", "legendary"],
      ["Globe Trotter", "globe_trotter", "legendary"],
    ],
  },
  {
    code: "areas", name: "Area Collector", icon: "map", category: "areas",
    blurb: "Areas you have personally taken to 100%",
    unit: "areas", levels: [1, 2, 5, 10, 25, 50],
    steps: [
      ["First Territory", "first_territory", "uncommon"], ["Double Sweep", "double_sweep", "uncommon"],
      ["Neighborhood Hero", "neighborhood_hero", "rare"], ["Area Collector", "area_collector", "rare"],
      ["Territory Master", "territory_master", "legendary"], ["Map Conqueror", "map_conqueror", "legendary"],
    ],
  },
];

/**
 * The ones worth their own name. `test` gets the figures gathered below and says whether
 * it is earned; nothing here is a restatement of a ladder.
 */
const BADGES = [
  { code: "clean_sweep", category: "areas", art: "clean_sweep", tier: "legendary", name: "Clean Sweep", icon: "trophy",
    blurb: "Personally drive every street in an area — not just be there at the end",
    test: (s) => s.areasCompleted >= 1 },

  { code: "quarter_sweep", category: "areas", art: "fresh_pavement", tier: "common", name: "Quarter Sweep", icon: "pie",
    blurb: "Cover a quarter of an area yourself", test: (s) => s.bestAreaPct >= 25 },
  { code: "halfway", category: "areas", art: "trailblazer", tier: "uncommon", name: "Halfway There", icon: "pie",
    blurb: "Cover half an area yourself", test: (s) => s.bestAreaPct >= 50 },
  { code: "three_quarters", category: "areas", art: "completionist", tier: "uncommon", name: "Three Quarters", icon: "pie",
    blurb: "Cover three quarters of an area yourself", test: (s) => s.bestAreaPct >= 75 },
  { code: "almost_there", category: "areas", art: "just_one_more", tier: "rare", name: "Almost There", icon: "pie",
    blurb: "Get an area to 90% on your own", test: (s) => s.bestAreaPct >= 90 },
  { code: "so_close", category: "areas", art: "cul_de_sac_king", tier: "rare", name: "So Close", icon: "pie",
    blurb: "Get an area to 99% — and find the cul-de-sac you missed",
    test: (s) => s.bestAreaPct >= 99 && s.areasCompleted === 0 },

  { code: "explorer", category: "exploration", art: "explorer", tier: "uncommon", name: "Explorer", icon: "compass",
    blurb: "Record streets in five different areas", test: (s) => s.areasDrivenIn >= 5 },
  { code: "wanderer", category: "exploration", art: "wanderer", tier: "rare", name: "Wanderer", icon: "compass",
    blurb: "Record streets in ten different areas", test: (s) => s.areasDrivenIn >= 10 },

  { code: "quick_sweep", category: "drives", art: "quick_sweep", tier: "common", name: "Quick Sweep", icon: "bolt",
    blurb: "Ten new streets in one drive", test: (s) => s.bestDriveStreets >= 10 },
  { code: "productive_drive", category: "drives", art: "productive_drive", tier: "uncommon", name: "Productive Drive", icon: "bolt",
    blurb: "Twenty-five new streets in one drive", test: (s) => s.bestDriveStreets >= 25 },
  { code: "big_sweep", category: "drives", art: "big_sweep", tier: "rare", name: "Big Sweep", icon: "bolt",
    blurb: "Fifty new streets in one drive", test: (s) => s.bestDriveStreets >= 50 },
  { code: "mega_sweep", category: "drives", art: "mega_sweep", tier: "legendary", name: "Mega Sweep", icon: "bolt",
    blurb: "A hundred new streets in one drive", test: (s) => s.bestDriveStreets >= 100 },
  { code: "century_drive", category: "drives", art: "century_drive", tier: "legendary", name: "Century Drive", icon: "bolt",
    blurb: "A hundred miles of new street in one drive",
    test: (s) => s.bestDriveNewMeters >= 100 * METERS_PER_MILE },

  { code: "sunday_driver", category: "special", art: "sunday_driver", tier: "common", name: "Sunday Driver", icon: "sun",
    blurb: "Twenty-five streets recorded on a Sunday", test: (s) => s.sundayStreets >= 25 },
  { code: "early_bird", category: "special", art: "early_bird", tier: "uncommon", name: "Early Bird",
    blurb: "Record a drive that starts between 4 and 6 AM", test: (s) => s.earlyDrives >= 1 },
  { code: "night_owl", category: "special", art: "night_owl", tier: "uncommon", name: "Night Owl",
    blurb: "Record a drive that starts after midnight, before 4 AM", test: (s) => s.nightDrives >= 1 },
  { code: "rain_or_shine", category: "special", art: "rain_or_shine", tier: "rare", name: "Rain or Shine", icon: "calendar",
    blurb: "Drive on thirty different days", test: (s) => s.drivingDays >= 30 },
  { code: "weekend_warrior", category: "special", art: "roundabout", tier: "uncommon", name: "Weekend Warrior", icon: "calendar",
    blurb: "New streets on four different weekends", test: (s) => s.weekends >= 4 },

  { code: "monthly_explorer", category: "special", art: "county_hopper", tier: "uncommon", name: "Monthly Explorer", icon: "calendar",
    blurb: "New streets in three months running", test: (s) => s.monthRun >= 3 },
  { code: "dedicated_sweeper", category: "special", art: "state_explorer", tier: "rare", name: "Dedicated Sweeper", icon: "calendar",
    blurb: "New streets in six months running", test: (s) => s.monthRun >= 6 },
  { code: "regular", category: "special", art: "world_traveler", tier: "legendary", name: "StreetSweep Regular", icon: "calendar",
    blurb: "New streets in twelve months running", test: (s) => s.monthRun >= 12 },
];

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS achievements (
      user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- A ladder stores one row per level reached, a badge one row with level 0.
      code     TEXT   NOT NULL,
      level    INT    NOT NULL DEFAULT 0,
      earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, code, level)
    );
    CREATE INDEX IF NOT EXISTS achievements_code ON achievements (code, level);
  `);
}

/**
 * Everything the tests above need, in one pass over the tables. Months and weekends are
 * worked out here rather than in SQL because the runs are easier to read as a loop than
 * as a window function, and the row counts are small.
 */
async function figuresFor(pool, userId) {
  const [edges, drives, areas, buckets] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS streets, COALESCE(sum(length_m),0) AS meters,
              count(*) FILTER (WHERE EXTRACT(DOW FROM ${LOCAL("driven_at")}) = 0)::int AS sunday
         FROM driven_edges WHERE user_id = $1`, [userId]),
    pool.query(
      `SELECT COALESCE(max(new_segments),0)::int AS best_streets,
              COALESCE(max(new_meters),0) AS best_meters,
              count(DISTINCT to_char(${LOCAL("started_at")}, 'YYYY-MM-DD'))::int AS days,
              -- Split so one drive at 1 AM is a Night Owl drive, not both.
              count(*) FILTER (WHERE distance_m > 0 AND EXTRACT(HOUR FROM ${LOCAL("started_at")}) < 4)::int AS night,
              count(*) FILTER (WHERE distance_m > 0 AND EXTRACT(HOUR FROM ${LOCAL("started_at")}) BETWEEN 4 AND 5)::int AS early
         FROM drives WHERE user_id = $1`, [userId]),
    pool.query(
      `SELECT count(*) FILTER (WHERE streets_total > 0 AND streets_done >= streets_total)::int AS completed,
              count(*) FILTER (WHERE streets_done > 0)::int AS driven_in,
              COALESCE(max(CASE WHEN streets_total > 0
                                THEN (streets_done::float / streets_total) * 100 END), 0) AS best_pct
         FROM reported_areas WHERE user_id = $1`, [userId]),
    pool.query(
      `SELECT DISTINCT to_char(${LOCAL("driven_at")}, 'IYYY-IW') AS week,
              to_char(${LOCAL("driven_at")}, 'YYYY-MM') AS month,
              EXTRACT(ISODOW FROM ${LOCAL("driven_at")})::int AS dow
         FROM driven_edges WHERE user_id = $1`, [userId]),
  ]);

  const weekends = new Set();
  const months = new Set();
  for (const r of buckets.rows) {
    months.add(r.month);
    if (r.dow === 6 || r.dow === 7) weekends.add(r.week);
  }

  return {
    streets: edges.rows[0].streets,
    meters: Number(edges.rows[0].meters),
    miles: Number(edges.rows[0].meters) / METERS_PER_MILE,
    sundayStreets: edges.rows[0].sunday,
    bestDriveStreets: drives.rows[0].best_streets,
    bestDriveNewMeters: Number(drives.rows[0].best_meters),
    drivingDays: drives.rows[0].days,
    nightDrives: drives.rows[0].night,
    earlyDrives: drives.rows[0].early,
    areasCompleted: areas.rows[0].completed,
    areasDrivenIn: areas.rows[0].driven_in,
    bestAreaPct: Number(areas.rows[0].best_pct),
    weekends: weekends.size,
    monthRun: longestRun([...months].sort()),
  };
}

/** The longest run of consecutive YYYY-MM strings. */
function longestRun(months) {
  let best = 0, run = 0, previous = null;
  for (const m of months) {
    const [y, mo] = m.split("-").map(Number);
    const n = y * 12 + mo;
    run = previous !== null && n === previous + 1 ? run + 1 : 1;
    previous = n;
    if (run > best) best = run;
  }
  return best;
}

function ladderValue(ladder, s) {
  if (ladder.code === "streets") return s.streets;
  if (ladder.code === "miles") return s.miles;
  return s.areasCompleted;
}

/** How far toward a badge someone is, as { value, need } — or null where it is yes/no. */
function progressOf(code, s) {
  const m = {
    quarter_sweep: [s.bestAreaPct, 25], halfway: [s.bestAreaPct, 50],
    three_quarters: [s.bestAreaPct, 75], almost_there: [s.bestAreaPct, 90],
    so_close: [s.bestAreaPct, 99], clean_sweep: [s.areasCompleted, 1],
    explorer: [s.areasDrivenIn, 5], wanderer: [s.areasDrivenIn, 10],
    quick_sweep: [s.bestDriveStreets, 10], productive_drive: [s.bestDriveStreets, 25],
    big_sweep: [s.bestDriveStreets, 50], mega_sweep: [s.bestDriveStreets, 100],
    century_drive: [Math.round((s.bestDriveNewMeters / METERS_PER_MILE) * 10) / 10, 100],
    sunday_driver: [s.sundayStreets, 25], rain_or_shine: [s.drivingDays, 30],
    weekend_warrior: [s.weekends, 4], monthly_explorer: [s.monthRun, 3],
    dedicated_sweeper: [s.monthRun, 6], regular: [s.monthRun, 12],
  }[code];
  if (!m) return null;
  return { value: Math.min(Math.round(m[0] * 10) / 10, m[1]), need: m[1] };
}

/** (code, level) pairs that still mean something, so a retired badge does not count. */
const HELD_CODES = [
  ...LADDERS.flatMap((l) => l.levels.map((_, i) => `('${l.code}',${i + 1})`)),
  ...BADGES.map((b) => `('${b.code}',0)`),
].join(",");

/**
 * Works out what this person has earned and writes down anything new. Returns the count
 * awarded this time, so a sync can say so. Safe to run as often as you like: the primary
 * key makes a second award a no-op.
 */
async function evaluate(pool, userId) {
  const s = await figuresFor(pool, userId);
  const rows = [];

  for (const ladder of LADDERS) {
    const value = ladderValue(ladder, s);
    ladder.levels.forEach((need, i) => {
      if (value >= need) rows.push([userId, ladder.code, i + 1]);
    });
  }
  for (const badge of BADGES) {
    if (badge.test(s)) rows.push([userId, badge.code, 0]);
  }
  if (!rows.length) return 0;

  const values = rows.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(",");
  const { rowCount } = await pool.query(
    `INSERT INTO achievements (user_id, code, level) VALUES ${values}
       ON CONFLICT (user_id, code, level) DO NOTHING`,
    rows.flat());
  return rowCount;
}

/**
 * What to show on a profile: every badge and ladder, earned or not, with how far along
 * the unearned ones are and how many people have each.
 *
 * Rarity is measured against people who could plausibly have it — anyone who has
 * recorded a street — rather than every account. Counting viewers and admins who never
 * drive would make everything look rare for no reason.
 */
async function forUser(pool, userId) {
  const [s, mine, counts, eligible, standings] = await Promise.all([
    figuresFor(pool, userId),
    pool.query("SELECT code, level, earned_at FROM achievements WHERE user_id = $1", [userId]),
    pool.query(`SELECT code, level, count(*)::int AS n FROM achievements GROUP BY code, level`),
    pool.query(`SELECT count(DISTINCT user_id)::int AS n FROM driven_edges WHERE user_id IS NOT NULL`),
    // Everyone's count of achievements held, ladder levels counted one by one, for a rank.
    pool.query(`SELECT user_id, count(*)::int AS n FROM achievements
                 WHERE (code, level) IN (${HELD_CODES}) GROUP BY user_id`),
  ]);

  const earned = new Map(mine.rows.map((r) => [r.code + ":" + r.level, new Date(r.earned_at).getTime()]));
  const held = new Map(counts.rows.map((r) => [r.code + ":" + r.level, r.n]));
  const pool_ = Math.max(1, eligible.rows[0].n);
  const share = (code, level) => Math.round(((held.get(code + ":" + level) || 0) / pool_) * 1000) / 10;

  const ladders = LADDERS.map((l) => {
    const value = ladderValue(l, s);
    let level = 0;
    l.levels.forEach((need, i) => { if (value >= need) level = i + 1; });
    const next = l.levels[level] != null ? l.levels[level] : null;
    return {
      kind: "ladder", code: l.code, name: l.name, icon: l.icon, blurb: l.blurb, unit: l.unit,
      category: l.category,
      level, top: l.levels.length, levels: l.levels,
      steps: l.steps.map(([name, art, tier], i) => ({
        level: i + 1, name, art, tier, need: l.levels[i],
        earned: level > i,
        earnedAt: earned.get(l.code + ":" + (i + 1)) || 0,
        rarity: share(l.code, i + 1),
      })),
      value: l.code === "miles" ? Math.round(value * 10) / 10 : value,
      next,
      progress: next ? Math.min(100, Math.round((value / next) * 100)) : 100,
      earnedAt: level ? earned.get(l.code + ":" + level) || 0 : 0,
      rarity: level ? share(l.code, level) : null,
    };
  });

  const badges = BADGES.map((b) => ({
    kind: "badge", code: b.code, name: b.name, icon: b.icon, blurb: b.blurb,
    category: b.category, art: b.art, tier: b.tier,
    // How far along an unearned one is, where there is a single number to measure.
    progress: progressOf(b.code, s),
    earned: earned.has(b.code + ":0"),
    earnedAt: earned.get(b.code + ":0") || 0,
    rarity: share(b.code, 0),
  }));

  // Every level counts as one achievement, as the page shows it.
  const heldCount = badges.filter((b) => b.earned).length +
    ladders.reduce((n, l) => n + l.level, 0);
  const others = standings.rows.filter((r) => Number(r.user_id) !== Number(userId));
  return {
    ladders, badges,
    earnedCount: heldCount,
    total: badges.length + ladders.reduce((n, l) => n + l.levels.length, 0),
    eligible: pool_,
    rank: 1 + others.filter((r) => r.n > heldCount).length,
    ranked: Math.max(others.length + 1, 1),
  };
}

/*
 * Left out on purpose, because the data to decide them does not exist:
 *
 *   Trailblazer, Fresh Pavement, Uncharted Territory — a segment is stored once, under
 *     whoever swept it first, so "streets nobody else recorded" is the same number as
 *     "streets you recorded". The ladder already says it.
 *   Wrong Turn? — repeat passes are not kept; the row is updated, not added to.
 *   Cul-de-Sac King, Roundabout — nothing classifies a segment as either.
 *   County Hopper, State Explorer, Cross Country, World Traveler — segments carry no
 *     administrative boundary, and working one out per street means geocoding.
 *   No Street Left Behind, The Last Mile, Cleanup Crew, Perfect Run, Just One More,
 *     Completionist — each needs the history of an area's percentage over time, or a
 *     drive's total segments against its new ones. Only the latest figure is stored.
 *
 * First Sweep is no longer a badge of its own: it is level I of Street Sweeper.
 *
 * Some of these have art on the design sheet, and that art is used for the nearest badge
 * that can be decided (Trailblazer's for Halfway There, Cul-de-Sac King's for So Close,
 * and so on — see the art fields above).
 *
 * Early Bird and Night Owl are in: they were left out once on the grounds of unsafe
 * hours, which was not this code's call. Their hours are the drive's start, in TIMEZONE.
 */

module.exports = { LADDERS, BADGES, ensureSchema, evaluate, forUser, figuresFor };
