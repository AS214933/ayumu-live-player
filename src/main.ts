import Artplayer, { type Setting, type SettingOption } from "artplayer";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import { initAnalytics, trackClarityEvent } from "./analytics";
import {
  playerConfig,
  type StreamFormat,
  type StreamQuality,
  type TemplateControlCondition,
  type TemplateValue,
} from "./playerConfig";
import {
  resolvePlayerSources,
  type ResolvedTemplateSource,
  type TemplateContext,
  type TemplateSelectionControl,
  type TemplateSelectionOption,
} from "./qualityTemplates";
import "./style.css";

type TemplateSelector = {
  default?: boolean;
  html: string | HTMLElement;
  value?: TemplateValue;
};

type TemplateControlOption = {
  name: string;
  position: "right";
  index?: number;
  html: string;
  tooltip: string;
  selector: TemplateSelector[];
  style?: Partial<CSSStyleDeclaration>;
  mounted?: (element: HTMLElement) => void;
  beforeUnmount?: () => void;
  onSelect: (selector: TemplateSelector) => string;
};

type MediaSourceConstructorLike = {
  isTypeSupported?: (mimeType: string) => boolean;
};

type WindowWithMediaSourceVariants = typeof window & {
  ManagedMediaSource?: MediaSourceConstructorLike;
  WebKitMediaSource?: MediaSourceConstructorLike;
};

type VideoWithLegacyFrames = HTMLVideoElement & {
  webkitDecodedFrameCount?: number;
};

type VideoFrameSnapshot = {
  decodedFrames: number | null;
  totalFrames: number | null;
};

const HEVC_FIRST_FRAME_TIMEOUT_MS = 10_000;
const HEVC_MIME_TYPES = [
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1.1.6.L120.B0"',
  'video/mp4; codecs="hev1.1.6.L120.B0"',
  'video/mp4; codecs="hvc1.2.4.L120.B0"',
  'video/mp4; codecs="hev1.2.4.L120.B0"',
];

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Player container #app was not found.");
}

initAnalytics();
applyDocumentTitle();

const playerSources = resolvePlayerSources(playerConfig);
const streamQualities = playerSources.qualities;
const templateSource = playerSources.template;
let selectedTemplateValues: TemplateContext | null = templateSource
  ? { ...templateSource.selectedValues }
  : null;
const templateControlElements = new Map<string, HTMLElement>();
const templateControlOptions = createTemplateControlOptions(templateSource);
const templateSettingOptions = createTemplateSettingOptions(templateSource);
const hasTemplateSettingControls = hasTemplateSettingControlsEnabled(templateSource);
const defaultQuality = getDefaultQuality(streamQualities);
let errorOverlay: HTMLDivElement | null = null;
let pauseFrameOverlay: HTMLDivElement | null = null;
let pendingErrorMessage: string | null = null;
let flvPlayer: mpegts.Player | null = null;
let hlsPlayer: Hls | null = null;
let nativeHlsVideo: HTMLVideoElement | null = null;
let activeStreamKind: "flv" | "m3u8" | "native-hls" | null = null;
let activeStreamUrl: string | null = null;
let currentQuality: StreamQuality = defaultQuality;
let hevcFirstFrameWatchCleanup: (() => void) | null = null;
let streamStoppedByPause = false;
let resumeAfterReload = false;
let isDestroyingStream = false;
let isTransitioningStream = false;
const publicAssetUrl = createPublicAssetUrlResolver(import.meta.env.BASE_URL);

const art = new Artplayer({
  container: app,
  url: defaultQuality.url,
  title: playerConfig.title,
  theme: playerConfig.theme,
  autoplay: playerConfig.autoplay,
  autoOrientation: playerConfig.autoorientation,
  muted: false,
  volume: 1,
  isLive: true,
  playbackRate: false,
  setting: hasTemplateSettingControls,
  pip: true,
  fullscreen: true,
  fullscreenWeb: false,
  screenshot: playerConfig.screenshot,
  mutex: true,
  autoMini: false,
  hotkey: true,
  lock: true,
  controls: templateControlOptions,
  settings: templateSettingOptions,
  quality: playerSources.isComplexMode
    ? []
    : streamQualities.map((quality) => ({
        html: quality.name,
        url: quality.url,
        default: quality.url === defaultQuality.url,
      })),
  customType: {
    flv(video: HTMLVideoElement, url: string) {
      loadStreamSource(video, getQualityByUrl(url));
    },
    m3u8(video: HTMLVideoElement, url: string) {
      loadStreamSource(video, getQualityByUrl(url));
    },
  },
  icons: {
    loading: `<img src="${publicAssetUrl("assets/ploading.gif")}">`,
    state: `<img width="150" height="150" src="${publicAssetUrl("assets/state.svg")}">`,
    indicator: `<img width="16" height="16" src="${publicAssetUrl("assets/indicator.svg")}">`,
  },
} as Artplayer["option"]);

installControlsAutoHide(art);
installPauseFetchControl(art);
removeLiveProgressContainer(art);
refreshTemplateControlsVisibility();

pauseFrameOverlay = createPauseFrameOverlay(app);
errorOverlay = createErrorOverlay(app);

if (pendingErrorMessage) {
  showPlayerError(pendingErrorMessage);
}

art.on("destroy", () => {
  trackClarityEvent("player_destroyed");
  destroyStreamPlayer(art.video);
});

window.addEventListener("beforeunload", () => {
  trackClarityEvent("player_destroyed");
  destroyStreamPlayer(art.video);
});

art.on("video:play", () => {
  startHevcFirstFrameWatch(art.video, currentQuality);
});

function getDefaultQuality(qualities: StreamQuality[]): StreamQuality {
  if (qualities.length === 0) {
    throw new Error("至少要配置一个清晰度源。");
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

function applyDocumentTitle() {
  const streamName = normalizeDocumentTitlePart(playerConfig.StreamName);
  const appName = normalizeDocumentTitlePart(playerConfig.AppName);

  if (streamName && appName) {
    document.title = `${streamName} - ${appName}`;
    return;
  }

  if (appName) {
    document.title = appName;
    return;
  }

  if (streamName) {
    document.title = streamName;
  }
}

function normalizeDocumentTitlePart(value: string) {
  return value.trim();
}

function createTemplateControlOptions(source: ResolvedTemplateSource | undefined): TemplateControlOption[] {
  if (!source) {
    return [];
  }

  return source.controls
    .filter((control) => control.placement === "control")
    .map(createTemplateControlOption);
}

function createTemplateControlOption(control: TemplateSelectionControl): TemplateControlOption {
  return {
    name: `template-${control.name}`,
    position: "right" as const,
    index: control.index,
    html: renderTemplateControlHtml(control),
    tooltip: control.label,
    selector: control.options.map((option) => ({
      html: option.label,
      value: option.value,
      default: isSelectedTemplateOption(control, option),
    })),
    style: getTemplateControlVisibilityStyle(control),
    mounted(element: HTMLElement) {
      templateControlElements.set(control.name, element);
      updateTemplateControlVisibility(control);
    },
    beforeUnmount() {
      templateControlElements.delete(control.name);
    },
    onSelect(selector: TemplateSelector) {
      selectTemplateVariable(control.name, getTemplateOptionValue(control, selector.value));
      return renderTemplateControlHtml(control);
    },
  };
}

function createTemplateSettingOptions(source: ResolvedTemplateSource | undefined): Setting[] {
  if (!source) {
    return [];
  }

  return source.controls
    .filter((control) => control.placement === "setting" && isTemplateControlVisible(control))
    .map(createTemplateSettingOption);
}

function hasTemplateSettingControlsEnabled(source: ResolvedTemplateSource | undefined) {
  return Boolean(source?.controls.some((control) => control.placement === "setting"));
}

function createTemplateSettingOption(control: TemplateSelectionControl): Setting {
  return {
    name: getTemplateSettingOptionName(control),
    html: control.label,
    tooltip: getSelectedTemplateValueLabel(control),
    selector: control.options.map((option) => ({
      name: `template-${control.name}-${String(option.value)}`,
      html: option.label,
      value: option.value,
      default: isSelectedTemplateOption(control, option),
    })),
    onSelect(item: SettingOption) {
      const value = getTemplateOptionValue(control, item.value);
      selectTemplateVariable(control.name, value);
      return getSelectedTemplateValueLabel(control);
    },
  };
}

function selectTemplateVariable(name: string, value: TemplateValue) {
  if (!templateSource || !selectedTemplateValues) {
    return;
  }

  if (isSameTemplateValue(selectedTemplateValues[name], value)) {
    return;
  }

  selectedTemplateValues = {
    ...selectedTemplateValues,
    [name]: value,
  };
  refreshTemplateControlsVisibility();

  const nextQuality = getTemplateQuality(selectedTemplateValues);
  currentQuality = nextQuality;
  trackClarityEvent("template_variable_changed");

  if (art.video.paused || streamStoppedByPause) {
    if (hasActiveStreamSource() && !streamStoppedByPause) {
      stopStreamFetching();
    }

    streamStoppedByPause = true;
    art.notice.show = nextQuality.name;
    return;
  }

  isTransitioningStream = true;

  void art
    .switchQuality(nextQuality.url)
    .catch((error) => {
      console.warn("Failed to switch template source:", error);
    })
    .finally(() => {
      isTransitioningStream = false;
    });
}

function getTemplateQuality(values: TemplateContext): StreamQuality {
  if (!templateSource) {
    return currentQuality;
  }

  const nextQuality = templateSource.createQuality(values);
  return streamQualities.find((quality) => quality.url === nextQuality.url) ?? nextQuality;
}

function refreshTemplateControlsVisibility() {
  if (!templateSource) {
    return;
  }

  for (const control of templateSource.controls) {
    updateTemplateControlVisibility(control);
    updateTemplateSettingVisibility(control);
  }
}

function refreshTemplateOptionSelection(name: string) {
  if (!templateSource) {
    return;
  }

  const control = templateSource.controls.find((item) => item.name === name);

  if (!control) {
    return;
  }

  if (control.placement === "control") {
    art.controls.update(createTemplateControlOption(control));
    return;
  }

  updateTemplateSettingVisibility(control);

  if (isTemplateControlVisible(control)) {
    art.setting.update(createTemplateSettingOption(control));
  }
}

function updateTemplateControlVisibility(control: TemplateSelectionControl) {
  if (control.placement !== "control") {
    return;
  }

  const element = templateControlElements.get(control.name);

  if (!element) {
    return;
  }

  element.style.display = isTemplateControlVisible(control) ? "" : "none";
}

function updateTemplateSettingVisibility(control: TemplateSelectionControl) {
  if (control.placement !== "setting") {
    return;
  }

  const optionName = getTemplateSettingOptionName(control);
  const settingOption = art.setting.find(optionName);
  const visible = isTemplateControlVisible(control);

  if (visible && !settingOption) {
    art.setting.add(createTemplateSettingOption(control));
    return;
  }

  if (!visible && settingOption) {
    art.setting.remove(optionName);
  }
}

function getTemplateSettingOptionName(control: TemplateSelectionControl) {
  return `template-${control.name}`;
}

function getTemplateControlVisibilityStyle(
  control: TemplateSelectionControl,
): Partial<CSSStyleDeclaration> | undefined {
  return isTemplateControlVisible(control) ? undefined : { display: "none" };
}

function isTemplateControlVisible(control: TemplateSelectionControl) {
  if (!control.hiddenWhen || !selectedTemplateValues) {
    return true;
  }

  return !matchesTemplateControlCondition(control.hiddenWhen, selectedTemplateValues);
}

function matchesTemplateControlCondition(
  condition: TemplateControlCondition | TemplateControlCondition[],
  values: TemplateContext,
) {
  const conditions = Array.isArray(condition) ? condition : [condition];

  return conditions.some((item) => {
    const entries = Object.entries(item);

    return entries.length > 0 && entries.every(
      ([name, value]) => isSameTemplateValue(values[name], value),
    );
  });
}

function renderTemplateControlHtml(control: TemplateSelectionControl) {
  return `<span class="player-template-control"><span class="player-template-control-label">${escapeHtml(
    control.label,
  )}</span><span class="player-template-control-value">${escapeHtml(
    getSelectedTemplateValueLabel(control),
  )}</span></span>`;
}

function getSelectedTemplateValueLabel(control: TemplateSelectionControl) {
  const selectedValue = selectedTemplateValues?.[control.name] ?? control.selectedValue;
  const selectedOption = control.options.find((option) => isSameTemplateValue(option.value, selectedValue));

  return selectedOption?.label ?? String(selectedValue);
}

function isSelectedTemplateOption(control: TemplateSelectionControl, option: TemplateSelectionOption) {
  const selectedValue = selectedTemplateValues?.[control.name] ?? control.selectedValue;
  return isSameTemplateValue(option.value, selectedValue);
}

function getTemplateOptionValue(control: TemplateSelectionControl, value: TemplateSelector["value"]): TemplateValue {
  return control.options.find((option) => isSameTemplateValue(option.value, value))?.value ?? String(value ?? "");
}

function isSameTemplateValue(left: TemplateValue | undefined, right: TemplateValue | undefined) {
  return String(left) === String(right);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
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

function installPauseFetchControl(player: Artplayer) {
  const hidePauseFrameOnPlayback = () => {
    hidePauseFrame(player.video);
  };

  const stopFetchingOnPause = () => {
    if (
      !hasActiveStreamSource() ||
      isDestroyingStream ||
      isTransitioningStream ||
      player.video.ended
    ) {
      return;
    }

    showPauseFrame(player.video);
    stopStreamFetching();
  };

  const restartFetchingOnPlay = () => {
    if (!streamStoppedByPause || resumeAfterReload) {
      return;
    }

    resumeAfterReload = true;

    try {
      restartStreamFetching(player.video);
    } catch (error) {
      streamStoppedByPause = true;
      console.warn("Failed to restart stream fetching:", error);
    } finally {
      resumeAfterReload = false;
    }
  };

  player.on("video:pause", stopFetchingOnPause);
  player.on("play", restartFetchingOnPlay);
  player.on("video:play", restartFetchingOnPlay);
  player.video.addEventListener("loadeddata", hidePauseFrameOnPlayback);
  player.video.addEventListener("playing", hidePauseFrameOnPlayback);

  player.on("destroy", () => {
    player.video.removeEventListener("loadeddata", hidePauseFrameOnPlayback);
    player.video.removeEventListener("playing", hidePauseFrameOnPlayback);
    hidePauseFrame(player.video);
    streamStoppedByPause = false;
    resumeAfterReload = false;
  });
}

function removeLiveProgressContainer(player: Artplayer) {
  if (!player.option.isLive || !player.template.$progress.isConnected) {
    return;
  }

  player.template.$progress.remove();
}

function getQualityByUrl(url: string): StreamQuality {
  const format = inferStreamFormat(url);

  return (
    streamQualities.find((quality) => quality.url === url) ?? {
      name:
        format === "m3u8"
          ? "自定义 M3U8"
          : format === "flv"
            ? "自定义 FLV"
            : "自定义源",
      url,
      format: format ?? "flv",
      codec: "avc",
    }
  );
}

function getStreamFormat(quality: StreamQuality): StreamFormat | null {
  return quality.format ?? inferStreamFormat(quality.url);
}

function inferStreamFormat(url: string): StreamFormat | null {
  const normalizedUrl = url.split("?")[0].split("#")[0].toLowerCase();

  if (normalizedUrl.endsWith(".m3u8")) {
    return "m3u8";
  }

  if (normalizedUrl.endsWith(".flv")) {
    return "flv";
  }

  return null;
}

function hasActiveStreamSource() {
  return Boolean(flvPlayer || hlsPlayer || nativeHlsVideo);
}

function stopStreamFetching() {
  streamStoppedByPause = true;
  isTransitioningStream = true;

  try {
    if (activeStreamKind === "flv" && flvPlayer) {
      flvPlayer.unload();
      return;
    }

    if (activeStreamKind === "m3u8" && hlsPlayer) {
      hlsPlayer.stopLoad();
      return;
    }
  } finally {
    isTransitioningStream = false;
  }
}

function restartStreamFetching(video: HTMLVideoElement) {
  isTransitioningStream = true;

  try {
    if (activeStreamUrl !== currentQuality.url) {
      loadStreamSource(video, currentQuality);
      streamStoppedByPause = false;
      return;
    }

    if (activeStreamKind === "flv" && flvPlayer) {
      flvPlayer.load();
      streamStoppedByPause = false;
      return;
    }

    if (activeStreamKind === "m3u8" && hlsPlayer) {
      hlsPlayer.startLoad();
      streamStoppedByPause = false;
      return;
    }

    if (activeStreamKind === "native-hls" && nativeHlsVideo === video) {
      streamStoppedByPause = false;
      return;
    }

    loadStreamSource(video, currentQuality);
    streamStoppedByPause = false;
  } finally {
    isTransitioningStream = false;
  }
}

function loadStreamSource(video: HTMLVideoElement, quality: StreamQuality) {
  const format = getStreamFormat(quality);

  if (!format) {
    trackClarityEvent("stream_source_load_failed");
    showPlayerError('无法识别播放源格式，请在配置里把 format 设成 "flv" 或 "m3u8"。');
    resumeAfterReload = false;
    return;
  }

  currentQuality = quality;
  const unsupportedHevcMessage = getUnsupportedHevcPlaybackMessage(video, quality, format);

  if (unsupportedHevcMessage) {
    trackClarityEvent("hevc_source_load_failed");

    if (switchToAvcFallback(video, quality, unsupportedHevcMessage)) {
      return;
    }

    isTransitioningStream = true;

    try {
      destroyStreamPlayer(video);
      hidePlayerError();
      showPlayerError(unsupportedHevcMessage);
      resumeAfterReload = false;
    } finally {
      isTransitioningStream = false;
    }

    return;
  }

  isTransitioningStream = true;
  clearHevcFirstFrameWatch();
  destroyStreamPlayer(video);
  hidePlayerError();

  try {
    if (format === "flv") {
      loadFlvSource(video, quality);
      return;
    }

    loadHlsSource(video, quality);
  } finally {
    isTransitioningStream = false;
  }
}

function getUnsupportedHevcPlaybackMessage(
  video: HTMLVideoElement,
  quality: StreamQuality,
  format: StreamFormat,
): string | null {
  if (quality.codec !== "hevc") {
    return null;
  }

  if (format === "flv") {
    return isHevcMsePlaybackSupported()
      ? null
      : "当前浏览器/系统不支持通过 MSE 播放 HEVC/H.265 FLV，已无法显示这个编码。";
  }

  if (canUseNativeHls(video) && isHevcNativePlaybackSupported(video)) {
    return null;
  }

  if (Hls.isSupported() && isHevcMsePlaybackSupported()) {
    return null;
  }

  return "当前浏览器/系统不支持播放 HEVC/H.265 的 M3U8，已无法显示这个编码。";
}

function switchToAvcFallback(
  video: HTMLVideoElement,
  failedQuality: StreamQuality,
  reason: string,
) {
  if (failedQuality.codec !== "hevc") {
    return false;
  }

  const fallbackQuality = getAvcFallbackQuality(failedQuality);

  if (
    !fallbackQuality ||
    fallbackQuality.codec !== "avc" ||
    fallbackQuality.url === failedQuality.url
  ) {
    return false;
  }

  applyAvcFallbackSelection();
  console.warn(reason);
  art.notice.show = "HEVC 当前无法显示，已自动切换 AVC。";
  loadStreamSource(video, fallbackQuality);
  return true;
}

function getAvcFallbackQuality(failedQuality: StreamQuality): StreamQuality | null {
  if (templateSource && selectedTemplateValues && hasOwnTemplateValue(selectedTemplateValues, "codec")) {
    return getTemplateQuality({
      ...selectedTemplateValues,
      codec: "avc",
    });
  }

  const failedFormat = getStreamFormat(failedQuality);
  return (
    streamQualities.find(
      (quality) =>
        quality.codec === "avc" &&
        quality.url !== failedQuality.url &&
        getStreamFormat(quality) === failedFormat,
    ) ??
    streamQualities.find(
      (quality) => quality.codec === "avc" && quality.url !== failedQuality.url,
    ) ??
    null
  );
}

function applyAvcFallbackSelection() {
  if (!templateSource || !selectedTemplateValues || !hasOwnTemplateValue(selectedTemplateValues, "codec")) {
    return;
  }

  if (isSameTemplateValue(selectedTemplateValues.codec, "avc")) {
    return;
  }

  selectedTemplateValues = {
    ...selectedTemplateValues,
    codec: "avc",
  };
  refreshTemplateControlsVisibility();
  refreshTemplateOptionSelection("codec");
}

function hasOwnTemplateValue(values: TemplateContext, name: string) {
  return Object.prototype.hasOwnProperty.call(values, name);
}

function startHevcFirstFrameWatch(video: HTMLVideoElement, quality: StreamQuality) {
  clearHevcFirstFrameWatch();

  if (quality.codec !== "hevc") {
    return;
  }

  const sourceUrl = quality.url;
  const startedFrame = getVideoFrameSnapshot(video);

  const handleFrameReady = () => {
    if (currentQuality.url === sourceUrl && hasVideoFrameAdvanced(video, startedFrame)) {
      clearHevcFirstFrameWatch();
    }
  };

  const handleVideoError = () => {
    if (currentQuality.url === sourceUrl) {
      handleHevcPlaybackFailure(video, quality, "HEVC 播放失败，当前环境无法显示这个编码。");
    }
  };

  const timeoutId = window.setTimeout(() => {
    if (
      currentQuality.url !== sourceUrl ||
      activeStreamUrl !== sourceUrl ||
      streamStoppedByPause ||
      video.paused
    ) {
      clearHevcFirstFrameWatch();
      return;
    }

    if (!hasVideoFrameAdvanced(video, startedFrame)) {
      handleHevcPlaybackFailure(video, quality, "HEVC 已开始加载，但没有输出可显示的画面。");
    }
  }, HEVC_FIRST_FRAME_TIMEOUT_MS);
  const events: Array<[string, EventListener]> = [
    ["loadeddata", handleFrameReady],
    ["playing", handleFrameReady],
    ["timeupdate", handleFrameReady],
    ["resize", handleFrameReady],
    ["error", handleVideoError],
  ];

  for (const [eventName, listener] of events) {
    video.addEventListener(eventName, listener);
  }

  hevcFirstFrameWatchCleanup = () => {
    window.clearTimeout(timeoutId);

    for (const [eventName, listener] of events) {
      video.removeEventListener(eventName, listener);
    }
  };
}

function clearHevcFirstFrameWatch() {
  hevcFirstFrameWatchCleanup?.();
  hevcFirstFrameWatchCleanup = null;
}

function handleHevcPlaybackFailure(
  video: HTMLVideoElement,
  failedQuality: StreamQuality,
  reason: string,
) {
  clearHevcFirstFrameWatch();

  if (currentQuality.url !== failedQuality.url || activeStreamUrl !== failedQuality.url) {
    return;
  }

  trackClarityEvent("hevc_source_load_failed");
  console.warn(reason);

  if (switchToAvcFallback(video, failedQuality, reason)) {
    return;
  }

  showPlayerError(`${reason} 请切换 AVC 或换用支持 HEVC/H.265 的浏览器。`);
  resumeAfterReload = false;
}

function getVideoFrameSnapshot(video: HTMLVideoElement): VideoFrameSnapshot {
  const playbackQuality = video.getVideoPlaybackQuality?.();
  const legacyVideo = video as VideoWithLegacyFrames;

  return {
    decodedFrames:
      typeof legacyVideo.webkitDecodedFrameCount === "number"
        ? legacyVideo.webkitDecodedFrameCount
        : null,
    totalFrames: playbackQuality?.totalVideoFrames ?? null,
  };
}

function hasVideoFrameAdvanced(video: HTMLVideoElement, startedFrame: VideoFrameSnapshot) {
  const currentFrame = getVideoFrameSnapshot(video);

  if (startedFrame.totalFrames !== null && currentFrame.totalFrames !== null) {
    return currentFrame.totalFrames > startedFrame.totalFrames;
  }

  if (startedFrame.decodedFrames !== null && currentFrame.decodedFrames !== null) {
    return currentFrame.decodedFrames > startedFrame.decodedFrames;
  }

  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0;
}

function isHevcMsePlaybackSupported(features?: ReturnType<typeof mpegts.getFeatureList>) {
  return Boolean(
    features?.mseH265Playback ||
      getMediaSourceVariants().some((mediaSource) =>
        HEVC_MIME_TYPES.some((mimeType) => mediaSource.isTypeSupported?.(mimeType)),
      ),
  );
}

function getMediaSourceVariants(): MediaSourceConstructorLike[] {
  const currentWindow = window as WindowWithMediaSourceVariants;

  return [currentWindow.MediaSource, currentWindow.ManagedMediaSource, currentWindow.WebKitMediaSource]
    .filter((mediaSource): mediaSource is MediaSourceConstructorLike => Boolean(mediaSource));
}

function canUseNativeHls(video: HTMLVideoElement) {
  return canPlayType(video, "application/vnd.apple.mpegurl") || canPlayType(video, "application/x-mpegURL");
}

function isHevcNativePlaybackSupported(video: HTMLVideoElement) {
  return HEVC_MIME_TYPES.some((mimeType) => canPlayType(video, mimeType));
}

function canPlayType(video: HTMLVideoElement, mimeType: string) {
  const result = video.canPlayType(mimeType);
  return result === "probably" || result === "maybe";
}


function loadFlvSource(video: HTMLVideoElement, quality: StreamQuality) {
  const features = mpegts.getFeatureList();
  trackClarityEvent("flv_source_loaded");

  if (!features.mseLivePlayback || !mpegts.isSupported()) {
    trackClarityEvent("flv_source_load_failed");
    showPlayerError("当前浏览器不支持 FLV/MSE 播放，请更换支持 Media Source Extensions 的浏览器。");
    activeStreamKind = null;
    activeStreamUrl = null;
    resumeAfterReload = false;
    return;
  }

  if (quality.codec === "hevc" && !isHevcMsePlaybackSupported(features)) {
    const message = "当前浏览器不支持 HEVC/H.265 的 MSE 播放，请切换 AVC 清晰度或使用支持 HEVC 的浏览器。";

    trackClarityEvent("flv_source_load_failed");

    if (switchToAvcFallback(video, quality, message)) {
      return;
    }

    showPlayerError(message);
    activeStreamKind = null;
    activeStreamUrl = null;
    resumeAfterReload = false;
    return;
  }

  try {
    flvPlayer = mpegts.createPlayer(
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

    flvPlayer.on(mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
      const detail = String(errorDetail || errorType);

      console.error("FLV playback error:", errorType, errorDetail, errorInfo);

      if (quality.codec === "hevc" && switchToAvcFallback(video, quality, `HEVC FLV 加载失败：${detail}`)) {
        return;
      }

      showPlayerError(`FLV 加载失败：${detail}`);
    });

    flvPlayer.attachMediaElement(video);
    flvPlayer.load();
    activeStreamKind = "flv";
    activeStreamUrl = quality.url;
    streamStoppedByPause = false;
    startHevcFirstFrameWatch(video, quality);
  } catch (error) {
    trackClarityEvent("flv_source_load_failed");
    showPlayerError(`FLV 加载失败：${error instanceof Error ? error.message : String(error)}`);
    activeStreamKind = null;
    activeStreamUrl = null;
    resumeAfterReload = false;
    destroyStreamPlayer(video);
  }
}

function loadHlsSource(video: HTMLVideoElement, quality: StreamQuality) {
  trackClarityEvent("m3u8_source_loaded");

  if (canUseNativeHls(video)) {
    nativeHlsVideo = video;
    video.src = quality.url;
    video.load();
    activeStreamKind = "native-hls";
    activeStreamUrl = quality.url;
    streamStoppedByPause = false;
    startHevcFirstFrameWatch(video, quality);
    return;
  }

  if (!Hls.isSupported()) {
    trackClarityEvent("m3u8_source_load_failed");
    showPlayerError("当前浏览器不支持 HLS/M3U8 播放，请更换支持 Media Source Extensions 或原生 HLS 的浏览器。");
    activeStreamKind = null;
    activeStreamUrl = null;
    resumeAfterReload = false;
    return;
  }

  try {
    hlsPlayer = new Hls({
      lowLatencyMode: true,
      backBufferLength: 30,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
    });

    hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
      console.error("HLS playback error:", data);

      if (data.fatal) {
        const detail = String(data.details || data.type);

        trackClarityEvent("m3u8_source_load_failed");

        if (quality.codec === "hevc" && switchToAvcFallback(video, quality, `HEVC M3U8 加载失败：${detail}`)) {
          return;
        }

        showPlayerError(`M3U8 加载失败：${detail}`);
        activeStreamKind = null;
        resumeAfterReload = false;
        destroyStreamPlayer(video);
      }
    });

    hlsPlayer.loadSource(quality.url);
    hlsPlayer.attachMedia(video);
    activeStreamKind = "m3u8";
    activeStreamUrl = quality.url;
    streamStoppedByPause = false;
    startHevcFirstFrameWatch(video, quality);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    trackClarityEvent("m3u8_source_load_failed");

    if (quality.codec === "hevc" && switchToAvcFallback(video, quality, `HEVC M3U8 加载失败：${detail}`)) {
      return;
    }

    showPlayerError(`M3U8 加载失败：${detail}`);
    activeStreamKind = null;
    activeStreamUrl = null;
    resumeAfterReload = false;
    destroyStreamPlayer(video);
  }
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

function createPauseFrameOverlay(container: HTMLElement): HTMLDivElement {
  const overlay = document.createElement("div");
  const image = document.createElement("img");

  overlay.className = "player-pause-frame";
  overlay.hidden = true;
  image.alt = "";
  image.decoding = "async";

  overlay.appendChild(image);
  container.appendChild(overlay);
  return overlay;
}

function showPauseFrame(video: HTMLVideoElement): boolean {
  const frameUrl = captureVideoFrame(video);

  if (!pauseFrameOverlay || !frameUrl) {
    return false;
  }

  const image = pauseFrameOverlay.querySelector<HTMLImageElement>("img");

  if (!image) {
    return false;
  }

  image.src = frameUrl;
  pauseFrameOverlay.hidden = false;
  video.poster = frameUrl;
  return true;
}

function hidePauseFrame(video: HTMLVideoElement) {
  if (pauseFrameOverlay) {
    const image = pauseFrameOverlay.querySelector<HTMLImageElement>("img");

    pauseFrameOverlay.hidden = true;
    image?.removeAttribute("src");
  }

  video.removeAttribute("poster");
}

function captureVideoFrame(video: HTMLVideoElement): string | null {
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }

  const maxFramePixels = 1920 * 1080;
  const sourcePixels = video.videoWidth * video.videoHeight;
  const scale = Math.min(1, Math.sqrt(maxFramePixels / sourcePixels));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  canvas.width = width;
  canvas.height = height;
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  try {
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch (error) {
    console.warn("Failed to capture pause frame:", error);
    return null;
  }
}

function destroyStreamPlayer(video?: HTMLVideoElement) {
  if (isDestroyingStream) {
    return;
  }

  isDestroyingStream = true;
  clearHevcFirstFrameWatch();

  try {
    const shouldResetVideo = hasActiveStreamSource();
    const resetTarget = video ?? nativeHlsVideo ?? undefined;

    if (flvPlayer) {
      try {
        flvPlayer.pause();
        flvPlayer.unload();
        flvPlayer.detachMediaElement();
        flvPlayer.destroy();
      } finally {
        flvPlayer = null;
      }
    }

    if (hlsPlayer) {
      try {
        hlsPlayer.stopLoad();
        hlsPlayer.destroy();
      } finally {
        hlsPlayer = null;
      }
    }

    nativeHlsVideo = null;
    activeStreamKind = null;
    activeStreamUrl = null;

    if (shouldResetVideo && resetTarget) {
      resetVideo(resetTarget);
    }
  } finally {
    isDestroyingStream = false;
  }
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
