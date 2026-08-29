import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the client runs on its own port; both the API and the socket are
    // proxied so the browser only ever talks to one origin.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
