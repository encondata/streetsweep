// Every setting the server reads, in one place. Defaults match compose.yaml.
import path from "node:path";

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 80),
  databaseUrl: env.DATABASE_URL ?? "postgres://streetsweep:streetsweep@localhost:5432/streetsweep",
  timezone: env.TIMEZONE ?? "America/Chicago",
  dataDir: env.DATA_DIR ?? "/data",
  valhallaUrl: env.VALHALLA_URL ?? "http://valhalla:8002",
  overpassUrl: env.OVERPASS_URL ?? "",
  // Address search (Nominatim). The public one by default; any Nominatim works.
  geocoderUrl: env.GEOCODER_URL || "https://nominatim.openstreetmap.org",
  // The region the server imports streets and boundaries for (a Geofabrik extract).
  osmExtractUrl: env.OSM_EXTRACT_URL || "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf",
  // Basemap tiles come from these, through the server's cache. Override for a private tile server.
  tileUrlOsm: env.TILE_URL_OSM || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileTtlDays: Number(env.TILE_TTL_DAYS ?? 30),
  contactEmail: env.CONTACT_EMAIL || env.ADMIN_EMAIL || "",
  // Outgoing mail. compose.yaml points this at Mailpit for development; set a real
  // server (and SMTP_USER/SMTP_PASS) in production.
  smtpHost: env.SMTP_HOST ?? "mailpit",
  smtpPort: Number(env.SMTP_PORT ?? 1025),
  smtpSecure: env.SMTP_SECURE === "true",
  smtpUser: env.SMTP_USER ?? "",
  smtpPass: env.SMTP_PASS ?? "",
  mailFrom: env.MAIL_FROM ?? "StreetSweep <no-reply@streetsweep.local>",
  adminEmail: env.ADMIN_EMAIL ?? "",
  adminPassword: env.ADMIN_PASSWORD ?? "",
  // Resolved against the working directory, which is /app in the image.
  migrationsDir: path.resolve(env.MIGRATIONS_DIR ?? "migrations"),
  publicDir: path.resolve(env.PUBLIC_DIR ?? "public"),
  webDir: path.resolve(env.WEB_DIR ?? "web"),
};
