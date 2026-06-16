import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// This example consumes the published @surf_liquid/core-sdk package straight from
// node_modules — there is no alias to local SDK source. It mirrors exactly what a
// developer gets after `npm install @surf_liquid/core-sdk`.
export default defineConfig({
  plugins: [react()],
  // Serve on 3000 to match the origin allowlisted by the SurfLiquid API's CORS
  // config. Auth is cookie-based (credentials: "include"), so the serving origin
  // must be on that allowlist. strictPort fails fast instead of silently falling
  // back to another (non-whitelisted) port.
  server: {
    port: 3000,
    strictPort: true,
  },
  preview: {
    port: 3000,
    strictPort: true,
  },
});
