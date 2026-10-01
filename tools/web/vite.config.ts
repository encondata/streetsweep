import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The v2 web app lives at /v2 on the same server as everything else (server.js serves
// the built files from public/v2). In development, `npm run dev` proxies the API, the
// tile cache and sign-in to a running server, so the session cookie just works.
const SERVER = process.env.STREETSWEEP_SERVER || "http://127.0.0.1:8420";

export default defineConfig({
  base: "/v2/",
  plugins: [svelte()],
  // The map's worker imports the code it shares with the page, so it is built as a module.
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      "/api": SERVER,
      "/tiles": SERVER,
      "/login": SERVER,
      "/login-art.webp": SERVER,
      "/logo-mark.png": SERVER,
    },
  },
});
