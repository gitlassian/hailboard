import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (pnpm server:dev); Vite forwards /v1 to it. Set
// HAILBOARD_API to look at a board on another server through the page being developed, for
// example HAILBOARD_API=https://ab.froti.dev with a feed link created on that server.
const api = process.env.HAILBOARD_API ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/v1": { target: api, changeOrigin: api !== "http://localhost:8080", secure: true } },
  },
});
