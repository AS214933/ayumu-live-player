import Artplayer from "artplayer";
import mpegts from "mpegts.js";
import { initAnalytics, trackClarityEvent } from "./analytics";
import { playerConfig, type StreamQuality } from "./playerConfig";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Player container #app was not found.");
}

initAnalytics();

const defaultQuality = getDefaultQuality(playerConfig.qualities);
let errorOverlay: HTMLDivElement | null = null;
let pendingErrorMessage: string | null = null;
let streamPlayer: mpegts.Player | null = null;
const publicAssetUrl = createPublicAssetUrlResolver(import.meta.env.BASE_URL);

const art = new Artplayer({
  container: app,
  url: defaultQuality.url,
  type: "flv",
  title: playerConfig.title,
  theme: playerConfig.theme,
  autoplay: playerConfig.autoplay,
  autoOrientation: playerConfig.autoorientation,
  muted: false,
  volume: 1,
  isLive: true,
  playbackRate: false,
  setting: false,
  pip: true,
  fullscreen: true,
  fullscreenWeb: true,
  screenshot: playerConfig.screenshot,
  mutex: true,
  autoMini: false,
  quality: playerConfig.qualities.map((quality) => ({
    html: quality.name,
    url: quality.url,
    default: quality.url === defaultQuality.url,
  })),
  customType: {
    flv(video: HTMLVideoElement, url: string) {
      loadFlvSource(video, getQualityByUrl(url));
    },
  },
  icons: {
    loading: `<img src="${publicAssetUrl("assets/ploading.gif")}">`,
    state: `<img width="150" height="150" src="${publicAssetUrl("assets/state.svg")}">`,
    indicator: `<img width="16" height="16" src="${publicAssetUrl("assets/indicator.svg")}">`,
  },
} as Artplayer["option"]);

installControlsAutoHide(art);

errorOverlay = createErrorOverlay(app);

if (pendingErrorMessage) {
  showPlayerError(pendingErrorMessage);
}

art.on("destroy", () => {
  trackClarityEvent("player_destroyed");
  destroyStreamPlayer();
});

window.addEventListener("beforeunload", () => {
  trackClarityEvent("player_destroyed");
  destroyStreamPlayer();
});

function getDefaultQuality(qualities: StreamQuality[]): StreamQuality {
  if (qualities.length === 0) {
    throw new Error("At least one FLV quality must be configured.");
  }

  return qualities.find((quality) => quality.default) ?? qualities[0];
}

function createPublicAssetUrlResolver(baseUrl: string) {
  return (path: string) => {
    const cleanBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const cleanPath = path.replace(/^\/+/, "");
    return `${cleanBase}${cleanPath}`;
  };
}

function installControlsAutoHide(player: Artplayer) {
  const hideControls = () => {
    player.controls.show = false;
  };

  const handleDocumentMouseOut = (event: MouseEvent) => {
    if (!event.relatedTarget) {
      hideControls();
    }
  };

  player.template.$player.addEventListener("pointerleave", hideControls);
  player.template.$player.addEventListener("mouseleave", hideControls);
  document.addEventListener("mouseout", handleDocumentMouseOut);
  window.addEventListener("blur", hideControls);
  document.addEventListener("visibilitychange", hideControls);

  player.on("destroy", () => {
    player.template.$player.removeEventListener("pointerleave", hideControls);
    player.template.$player.removeEventListener("mouseleave", hideControls);
    document.removeEventListener("mouseout", handleDocumentMouseOut);
    window.removeEventListener("blur", hideControls);
    document.removeEventListener("visibilitychange", hideControls);
  });
}

function getQualityByUrl(url: string): StreamQuality {
  return playerConfig.qualities.find((quality) => quality.url === url) ?? {
    name: "自定义 FLV",
    url,
    codec: "avc",
  };
}

function loadFlvSource(video: HTMLVideoElement, quality: StreamQuality) {
  destroyStreamPlayer();
  hidePlayerError();

  const features = mpegts.getFeatureList();
  trackClarityEvent("flv_source_loaded");

  if (!features.mseLivePlayback || !mpegts.isSupported()) {
    trackClarityEvent("flv_source_load_failed");
    showPlayerError("当前浏览器不支持 FLV/MSE 播放，请更换支持 Media Source Extensions 的浏览器。");
    resetVideo(video);
    return;
  }

  if (quality.codec === "hevc" && !features.mseH265Playback) {
    trackClarityEvent("flv_source_load_failed");
    showPlayerError("当前浏览器不支持 HEVC/H.265 的 MSE 播放，请切换 AVC 清晰度或使用支持 HEVC 的浏览器。");
    resetVideo(video);
    return;
  }

  streamPlayer = mpegts.createPlayer(
    {
      type: "flv",
      url: quality.url,
      isLive: true,
    },
    {
      enableStashBuffer: false,
      stashInitialSize: 128,
      autoCleanupSourceBuffer: true,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.5,
    },
  );

  streamPlayer.attachMediaElement(video);
  streamPlayer.load();

  streamPlayer.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
    console.error("FLV playback error:", errorType, errorDetail, errorInfo);
    showPlayerError(`FLV 加载失败：${String(errorDetail || errorType)}`);
  });
}

function resetVideo(video: HTMLVideoElement) {
  try {
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch (error) {
    console.error("Video reset failed:", error);
  }
}

function destroyStreamPlayer() {
  if (!streamPlayer) {
    return;
  }

  streamPlayer.pause();
  streamPlayer.unload();
  streamPlayer.detachMediaElement();
  streamPlayer.destroy();
  streamPlayer = null;
}

function createErrorOverlay(container: HTMLElement): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.className = "player-error";
  overlay.setAttribute("role", "alert");
  overlay.hidden = true;
  container.appendChild(overlay);
  return overlay;
}

function showPlayerError(message: string) {
  pendingErrorMessage = message;

  if (!errorOverlay) {
    return;
  }

  errorOverlay.textContent = message;
  errorOverlay.hidden = false;
}

function hidePlayerError() {
  pendingErrorMessage = null;

  if (!errorOverlay) {
    return;
  }

  errorOverlay.hidden = true;
  errorOverlay.textContent = "";
}
