import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  // `npm run dev` against a running stack: the api on :8430 serves /api and /login.
  server: { proxy: { "/api": "http://localhost:8430", "/login": "http://localhost:8430" } },
});
