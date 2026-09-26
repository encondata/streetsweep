"use strict";

/**
 * Matching drives to streets (Valhalla's trace_attributes), through this server rather
 * than from each phone to the public Valhalla server directly.
 *
 * On its own that does not make fewer requests — every drive still has to be matched —
 * but it puts them all in one place: one queue that is gentle with the free community
 * server, answers remembered so a phone retrying a batch after a dropped connection does
 * not ask twice, and one setting (VALHALLA_URL) that moves every phone at once to a
 * Valhalla of your own, such as the optional one in docker-compose, after which nothing
 * goes to the public server at all.
 */

const crypto = require("crypto");

const PUBLIC = "https://valhalla1.openstreetmap.de";
const BASE = (process.env.VALHALLA_URL || PUBLIC).replace(/\/+$/, "");
const IS_PUBLIC = /openstreetmap\.de/.test(BASE);
// The community server is fair use: one request at a time, a breath between them. Your
// own can take a few together.
const PARALLEL = IS_PUBLIC ? 1 : Number(process.env.VALHALLA_PARALLEL) || 4;
const PAUSE_MS = IS_PUBLIC ? 500 : 0;
const USER_AGENT = "StreetSweep/1.0 (self-hosted street coverage server)";

const stats = { asked: 0, remembered: 0, failed: 0, since: Date.now() };

// Recent answers by the exact request, so a retried batch is answered from here.
const answers = new Map();
const ANSWERS_KEPT = 300;

let running = 0;
const waiting = [];
function limited(job) {
  return new Promise((resolve, reject) => {
    const go = () => {
      running++;
      job().then(resolve, reject).finally(async () => {
        if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
        running--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (running < PARALLEL) go(); else waiting.push(go);
  });
}

/** POST /api/match/trace_attributes: the phone's request, passed on; Valhalla's answer, passed back. */
async function traceAttributes(bodyText) {
  const key = crypto.createHash("sha1").update(bodyText).digest("hex");
  if (answers.has(key)) {
    stats.remembered++;
    return answers.get(key);
  }
  const answer = await limited(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await fetch(BASE + "/trace_attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: bodyText, signal: ctl.signal,
      });
      return { status: r.status, text: await r.text() };
    } finally {
      clearTimeout(timer);
    }
  });
  stats.asked++;
  // Only good answers are remembered; a failure should be asked again.
  if (answer.status >= 200 && answer.status < 300) {
    answers.set(key, answer);
    while (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
  } else {
    stats.failed++;
  }
  return answer;
}

function status() {
  return { base: BASE, public: IS_PUBLIC, parallel: PARALLEL, queued: waiting.length, ...stats };
}

module.exports = { traceAttributes, status };
