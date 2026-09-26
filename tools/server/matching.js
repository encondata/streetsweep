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
// Where to go while your own Valhalla is not answering — building its tiles, restarting —
// so drives are still matched. The public server unless set otherwise; "none" for nowhere.
const FALLBACK = IS_PUBLIC ? null : (() => {
  const f = (process.env.VALHALLA_FALLBACK_URL || PUBLIC).replace(/\/+$/, "");
  return f === "none" ? null : f;
})();
// The community server is fair use: one request at a time, a breath between them. Your
// own can take a few together.
const PARALLEL = IS_PUBLIC ? 1 : Number(process.env.VALHALLA_PARALLEL) || 4;
const PAUSE_MS = IS_PUBLIC ? 500 : 0;
const USER_AGENT = "StreetSweep/1.0 (self-hosted street coverage server)";

const stats = { asked: 0, remembered: 0, failed: 0, fellBack: 0, since: Date.now() };

async function post(base, bodyText) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(base + "/trace_attributes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: bodyText, signal: ctl.signal,
    });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

// The public server keeps its fair-use terms even as a fallback: one request at a time,
// with a breath between, however many your own Valhalla would take together.
let fallbackTail = Promise.resolve();
function viaFallback(bodyText) {
  const run = fallbackTail.then(async () => {
    try { return await post(FALLBACK, bodyText); }
    finally { await new Promise((r) => setTimeout(r, 500)); }
  });
  fallbackTail = run.catch(() => {});
  return run;
}

/** Not answering at all, as opposed to answering "no match": worth trying elsewhere. */
function unavailable(answer) {
  return !answer || answer.status === 502 || answer.status === 503 || answer.status === 504;
}

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
    let first = null;
    try { first = await post(BASE, bodyText); } catch (err) { first = null; }
    if (!unavailable(first) || !FALLBACK) {
      return first || { status: 502, text: JSON.stringify({ error: "The matching server could not be reached" }) };
    }
    stats.fellBack++;
    return viaFallback(bodyText);
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
  return { base: BASE, public: IS_PUBLIC, fallback: FALLBACK, parallel: PARALLEL, queued: waiting.length, ...stats };
}

module.exports = { traceAttributes, status };
