import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_PORT, HOST } from "./server/config.js";

const serverOrigin = `http://${HOST}:${process.env.PORT ?? DEFAULT_PORT}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: HOST,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: serverOrigin, changeOrigin: true },
      "/ws": { target: serverOrigin, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
