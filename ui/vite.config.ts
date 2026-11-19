import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Release builds for testers (`npm run build:release` = vite --mode release) must not
  // ship the local catalog images from ui/public (catalog/, order_thumbs/). Dev builds keep them.
  publicDir: mode === "release" ? false : "public",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true
  }
}));
