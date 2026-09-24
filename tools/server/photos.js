"use strict";

/**
 * Photos for marked places, kept as files on a volume.
 *
 * This used to be MinIO. The bucket was private, only this service held the credentials,
 * and every byte was streamed out through the routes below — so S3 bought nothing that a
 * directory does not, while costing a second container, a second set of credentials, a
 * healthcheck and an npm client. When MinIO stopped publishing images anonymously (quay,
 * Docker Hub and Bitnami all return 401 now) that cost turned into a broken install, so
 * the photos moved here.
 *
 * Keys are made by the server as "pois/<sha1>.<ext>" and never contain anything typed by
 * a person, but safe() checks anyway: a storage layer that trusts its keys is one bad
 * caller away from writing outside its own directory.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DIR = path.resolve(process.env.PHOTO_DIR || "/data/photos");

const TYPE_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

let usable = false;

/** The absolute path for a key, or null if the key is not one we would ever have made. */
function safe(key) {
  const clean = String(key || "");
  if (!clean || clean.length > 300) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(clean)) return null;
  if (clean.includes("..")) return null;
  const full = path.resolve(DIR, clean);
  // resolve() has already flattened anything clever; this is the check that matters.
  if (full !== DIR && !full.startsWith(DIR + path.sep)) return null;
  return full;
}

async function ready() {
  try {
    await fsp.mkdir(DIR, { recursive: true });
    // Prove it is writable now rather than discovering it on the first upload.
    const probe = path.join(DIR, ".writable");
    await fsp.writeFile(probe, "");
    await fsp.unlink(probe);
    usable = true;
    console.log(`Photos going to ${DIR}.`);
  } catch (err) {
    usable = false;
    console.error(`Photos are off: ${DIR} is not writable (${err.message}).`);
  }
}

function on() { return usable; }

/** Written to a temporary name first, so a half-finished upload is never served. */
async function put(key, bytes) {
  const full = safe(key);
  if (!full) throw new Error("Bad photo key");
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.part`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, full);
}

async function stat(key) {
  const full = safe(key);
  if (!full) return null;
  try {
    const s = await fsp.stat(full);
    return s.isFile() ? { size: s.size, type: typeOf(key) } : null;
  } catch {
    return null;
  }
}

function readStream(key) {
  const full = safe(key);
  if (!full) return null;
  return fs.createReadStream(full);
}

async function remove(key) {
  const full = safe(key);
  if (!full) return;
  await fsp.rm(full, { force: true });
}

/**
 * How much room the photos take. Walks the directory rather than keeping a running
 * total: this is asked for once on an admin page, and a counter that can drift is
 * worse than a walk that cannot.
 */
async function usage() {
  if (!usable) return { on: false, dir: DIR, files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || entry.name.endsWith(".part")) continue;
      try { const st = await fsp.stat(full); files++; bytes += st.size; } catch { /* gone */ }
    }
  }
  await walk(DIR);
  return { on: true, dir: DIR, files, bytes };
}

/** From the extension the server itself chose when it made the key. */
function typeOf(key) {
  return TYPE_BY_EXT[path.extname(String(key)).toLowerCase()] || "application/octet-stream";
}

module.exports = { DIR, ready, on, put, stat, readStream, remove, typeOf, safe, usage };
