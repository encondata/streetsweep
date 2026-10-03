// Every setting the server reads, in one place. Defaults match compose.yaml.
import path from "node:path";

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 80),
  databaseUrl: env.DATABASE_URL ?? "postgres://streetsweep:streetsweep@localhost:5432/streetsweep",
  timezone: env.TIMEZONE ?? "America/Chicago",
  dataDir: env.DATA_DIR ?? "/data",
  valhallaUrl: env.VALHALLA_URL ?? "",
  overpassUrl: env.OVERPASS_URL ?? "",
  osmExtractUrl: env.OSM_EXTRACT_URL ?? "",
  adminEmail: env.ADMIN_EMAIL ?? "",
  adminPassword: env.ADMIN_PASSWORD ?? "",
  // Resolved against the working directory, which is /app in the image.
  migrationsDir: path.resolve(env.MIGRATIONS_DIR ?? "migrations"),
  publicDir: path.resolve(env.PUBLIC_DIR ?? "public"),
  webDir: path.resolve(env.WEB_DIR ?? "web"),
};
