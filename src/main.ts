import Artplayer from "artplayer";
import flvjs from "flv.js";
import { playerConfig, type StreamQuality } from "./playerConfig";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Player container #app was not found.");
}

const defaultQuality = getDefaultQuality(playerConfig.qualities);
let errorOverlay: HTMLDivElement | null = null;
let pendingErrorMessage: string | null = null;
let flvPlayer: flvjs.Player | null = null;

const art = new Artplayer({
  container: app,
  url: defaultQuality.url,
  type: "flv",
  title: playerConfig.title,
  theme: playerConfig.theme,
  autoplay: false,
  muted: false,
  volume: 0.7,
  isLive: true,
  playbackRate: false,
  setting: true,
  pip: true,
  fullscreen: true,
  fullscreenWeb: true,
  mutex: true,
  autoMini: false,
  quality: playerConfig.qualities.map((quality) => ({
    html: quality.name,
    url: quality.url,
    type: "flv",
    default: quality.url === defaultQuality.url,
  })),
  customType: {
    flv(video: HTMLVideoElement, url: string) {
      loadFlvSource(video, url);
    },
  },
} as Artplayer["option"]);

errorOverlay = createErrorOverlay(app);

if (pendingErrorMessage) {
  showPlayerError(pendingErrorMessage);
}

art.on("destroy", () => {
  destroyFlvPlayer();
});

window.addEventListener("beforeunload", () => {
  destroyFlvPlayer();
});

function getDefaultQuality(qualities: StreamQuality[]): StreamQuality {
  if (qualities.length === 0) {
    throw new Error("At least one FLV quality must be configured.");
  }

  return qualities.find((quality) => quality.default) ?? qualities[0];
}

function loadFlvSource(video: HTMLVideoElement, url: string) {
  destroyFlvPlayer();
  hidePlayerError();

  if (!flvjs.isSupported()) {
    const message = "当前浏览器不支持 FLV/MSE 播放，请更换支持 Media Source Extensions 的浏览器。";
    showPlayerError(message);
    video.removeAttribute("src");
    video.load();
    return;
  }

  flvPlayer = flvjs.createPlayer(
    {
      type: "flv",
      url,
      isLive: true,
    },
    {
      enableStashBuffer: false,
      stashInitialSize: 128,
      autoCleanupSourceBuffer: true,
    },
  );

  flvPlayer.attachMediaElement(video);
  flvPlayer.load();

  flvPlayer.on(flvjs.Events.ERROR, (errorType, errorDetail, errorInfo) => {
    console.error("FLV playback error:", errorType, errorDetail, errorInfo);
    showPlayerError(`FLV 加载失败：${String(errorDetail || errorType)}`);
  });
}

function destroyFlvPlayer() {
  if (!flvPlayer) {
    return;
  }

  flvPlayer.pause();
  flvPlayer.unload();
  flvPlayer.detachMediaElement();
  flvPlayer.destroy();
  flvPlayer = null;
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
