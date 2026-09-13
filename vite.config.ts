import { defineConfig } from "vite";

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE_PATH ?? "./"),
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }

          if (id.includes("node_modules/artplayer")) {
            return "vendor-artplayer";
          }

          if (id.includes("node_modules/hls.js")) {
            return "vendor-hls";
          }

          if (id.includes("node_modules/mpegts.js")) {
            return "vendor-mpegts";
          }

          if (id.includes("node_modules/@microsoft/clarity")) {
            return "vendor-clarity";
          }

          return "vendor";
        },
      },
    },
  },
});

function normalizeBase(basePath: string) {
  const trimmed = basePath.trim();

  if (!trimmed || trimmed === "." || trimmed === "./") {
    return "./";
  }

  if (trimmed === "/") {
    return "/";
  }

  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) {
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }

  const cleanPath = trimmed.replace(/^\/+|\/+$/g, "");
  return `/${cleanPath}/`;
}
