import { execSync } from "node:child_process";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE_PATH ?? "./"),
  plugins: [buildInfoCommentPlugin()],
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

function buildInfoCommentPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: "ayumu-build-info-comment",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return `${createBuildInfoComment(config)}\n${html}`;
      },
    },
  };
}

function createBuildInfoComment(config: ResolvedConfig) {
  const commit = readGitValue("git rev-parse HEAD") ?? "unknown";
  const branch = readGitValue("git branch --show-current") ?? "unknown";
  const buildTime = formatBuildTime(new Date());

  return [
    "<!--",
    "  Ayumu Live Player",
    "  © 2020 - 2026 Ayumu Network",
    "  Powered by Vite.js & ArtPlayer.js @ Evan You",
    "  =====",
    `  Version: ${sanitizeHtmlCommentValue(branch)} @ ${sanitizeHtmlCommentValue(commit)}`,
    `  Build: ${sanitizeHtmlCommentValue(buildTime)}`,
    `  Environment: ${sanitizeHtmlCommentValue(config.mode)}`,
    "  =====",
    "  「やり残したことなど ない」",
    "  「そう言いたいね」",
    "  「いつの日にか」",
    "  「そこまでは まだ遠いよ」",
    "  「だから僕らは がんばって挑戦だよね」",
    "  ——「勇気はどこに？君の胸に！」 / Aqours",
    "  =====",
    "  これは「ラブライブ！サンシャイン!! Aqours Finale LoveLive! ～永久stage～」の1周年を記念して捧げます。",
    "  Aqoursの勇気が、あなたを前へと導いてくれますように。",
    "-->",
  ].join("\n");
}

function formatBuildTime(date: Date) {
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());
  const seconds = padDatePart(date.getSeconds());

  return `${year}.${month}.${day} - ${hours}:${minutes}:${seconds}`;
}

function padDatePart(value: number) {
  return value.toString().padStart(2, "0");
}

function readGitValue(command: string) {
  try {
    const output = execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return output || null;
  } catch {
    return null;
  }
}

function sanitizeHtmlCommentValue(value: string) {
  return value.replace(/--/g, "- -").replace(/</g, "&lt;");
}

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
