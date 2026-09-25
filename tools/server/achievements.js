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

/** The families that are just "more of it". Thresholds from the brief. */
const LADDERS = [
  {
    code: "streets", name: "Street Sweeper", icon: "broom",
    blurb: "Streets nobody had recorded before you drove them",
    unit: "streets", levels: [10, 50, 100, 500, 1000, 2500, 5000, 10000],
  },
  {
    code: "miles", name: "New Mileage", icon: "road",
    blurb: "Miles of street you were the first to cover",
    unit: "miles", levels: [1, 25, 100, 250, 500, 1000, 2500, 3000, 10000],
  },
  {
    code: "areas", name: "Area Collector", icon: "map",
    blurb: "Areas you have personally taken to 100%",
    unit: "areas", levels: [1, 2, 5, 10, 25, 50],
  },
];

/**
 * The ones worth their own name. `test` gets the figures gathered below and says whether
 * it is earned; nothing here is a restatement of a ladder.
 */
const BADGES = [
  { code: "first_sweep", name: "First Sweep", icon: "broom",
    blurb: "Record your first street",
    test: (s) => s.streets >= 1 },

  { code: "clean_sweep", name: "Clean Sweep", icon: "trophy",
    blurb: "Personally drive every street in an area — not just be there at the end",
    test: (s) => s.areasCompleted >= 1 },

  { code: "quarter_sweep", name: "Quarter Sweep", icon: "pie",
    blurb: "Cover a quarter of an area yourself", test: (s) => s.bestAreaPct >= 25 },
  { code: "halfway", name: "Halfway There", icon: "pie",
    blurb: "Cover half an area yourself", test: (s) => s.bestAreaPct >= 50 },
  { code: "three_quarters", name: "Three Quarters", icon: "pie",
    blurb: "Cover three quarters of an area yourself", test: (s) => s.bestAreaPct >= 75 },
  { code: "almost_there", name: "Almost There", icon: "pie",
    blurb: "Get an area to 90% on your own", test: (s) => s.bestAreaPct >= 90 },
  { code: "so_close", name: "So Close", icon: "pie",
    blurb: "Get an area to 99% — and find the cul-de-sac you missed",
    test: (s) => s.bestAreaPct >= 99 && s.areasCompleted === 0 },

  { code: "explorer", name: "Explorer", icon: "compass",
    blurb: "Record streets in five different areas", test: (s) => s.areasDrivenIn >= 5 },
  { code: "wanderer", name: "Wanderer", icon: "compass",
    blurb: "Record streets in ten different areas", test: (s) => s.areasDrivenIn >= 10 },

  { code: "quick_sweep", name: "Quick Sweep", icon: "bolt",
    blurb: "Ten new streets in one drive", test: (s) => s.bestDriveStreets >= 10 },
  { code: "productive_drive", name: "Productive Drive", icon: "bolt",
    blurb: "Twenty-five new streets in one drive", test: (s) => s.bestDriveStreets >= 25 },
  { code: "big_sweep", name: "Big Sweep", icon: "bolt",
    blurb: "Fifty new streets in one drive", test: (s) => s.bestDriveStreets >= 50 },
  { code: "mega_sweep", name: "Mega Sweep", icon: "bolt",
    blurb: "A hundred new streets in one drive", test: (s) => s.bestDriveStreets >= 100 },
  { code: "century_drive", name: "Century Drive", icon: "bolt",
    blurb: "A hundred miles of new street in one drive",
    test: (s) => s.bestDriveNewMeters >= 100 * METERS_PER_MILE },

  { code: "sunday_driver", name: "Sunday Driver", icon: "sun",
    blurb: "Twenty-five streets recorded on a Sunday", test: (s) => s.sundayStreets >= 25 },
  { code: "rain_or_shine", name: "Rain or Shine", icon: "calendar",
    blurb: "Drive on thirty different days", test: (s) => s.drivingDays >= 30 },
  { code: "weekend_warrior", name: "Weekend Warrior", icon: "calendar",
    blurb: "New streets on four different weekends", test: (s) => s.weekends >= 4 },

  { code: "monthly_explorer", name: "Monthly Explorer", icon: "calendar",
    blurb: "New streets in three months running", test: (s) => s.monthRun >= 3 },
  { code: "dedicated_sweeper", name: "Dedicated Sweeper", icon: "calendar",
    blurb: "New streets in six months running", test: (s) => s.monthRun >= 6 },
  { code: "regular", name: "StreetSweep Regular", icon: "calendar",
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
              count(*) FILTER (WHERE EXTRACT(DOW FROM to_timestamp(driven_at/1000)) = 0)::int AS sunday
         FROM driven_edges WHERE user_id = $1`, [userId]),
    pool.query(
      `SELECT COALESCE(max(new_segments),0)::int AS best_streets,
              COALESCE(max(new_meters),0) AS best_meters,
              count(DISTINCT to_char(to_timestamp(started_at/1000), 'YYYY-MM-DD'))::int AS days
         FROM drives WHERE user_id = $1`, [userId]),
    pool.query(
      `SELECT count(*) FILTER (WHERE streets_total > 0 AND streets_done >= streets_total)::int AS completed,
              count(*) FILTER (WHERE streets_done > 0)::int AS driven_in,
              COALESCE(max(CASE WHEN streets_total > 0
                                THEN (streets_done::float / streets_total) * 100 END), 0) AS best_pct
         FROM reported_areas WHERE user_id = $1`, [userId]),
    pool.query(
      `SELECT DISTINCT to_char(to_timestamp(driven_at/1000), 'IYYY-IW') AS week,
              to_char(to_timestamp(driven_at/1000), 'YYYY-MM') AS month,
              EXTRACT(ISODOW FROM to_timestamp(driven_at/1000))::int AS dow
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
  const [s, mine, counts, eligible] = await Promise.all([
    figuresFor(pool, userId),
    pool.query("SELECT code, level, earned_at FROM achievements WHERE user_id = $1", [userId]),
    pool.query(`SELECT code, level, count(*)::int AS n FROM achievements GROUP BY code, level`),
    pool.query(`SELECT count(DISTINCT user_id)::int AS n FROM driven_edges WHERE user_id IS NOT NULL`),
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
      level, top: l.levels.length, levels: l.levels,
      value: l.code === "miles" ? Math.round(value * 10) / 10 : value,
      next,
      progress: next ? Math.min(100, Math.round((value / next) * 100)) : 100,
      earnedAt: level ? earned.get(l.code + ":" + level) || 0 : 0,
      rarity: level ? share(l.code, level) : null,
    };
  });

  const badges = BADGES.map((b) => ({
    kind: "badge", code: b.code, name: b.name, icon: b.icon, blurb: b.blurb,
    earned: earned.has(b.code + ":0"),
    earnedAt: earned.get(b.code + ":0") || 0,
    rarity: share(b.code, 0),
  }));

  return {
    ladders, badges,
    earnedCount: badges.filter((b) => b.earned).length + ladders.filter((l) => l.level > 0).length,
    total: badges.length + ladders.length,
    eligible: pool_,
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
 * Early Bird and Night Owl are also absent: the brief says not to reward driving at
 * unsafe hours, and a badge for driving before six or after midnight does exactly that.
 */

module.exports = { LADDERS, BADGES, ensureSchema, evaluate, forUser, figuresFor };
