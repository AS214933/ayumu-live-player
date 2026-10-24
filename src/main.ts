import Artplayer, { type Setting, type SettingOption } from "artplayer";
import Hls, { FetchLoader, type HlsConfig, type LoaderConfig } from "hls.js";
import mpegts from "mpegts.js";
import { initAnalytics, trackClarityEvent } from "./analytics";
import {
  playerConfig,
  type ContextmenuItemConfig,
  type RequestHeaderConfig,
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

type VideoWithReferrerPolicy = HTMLVideoElement & {
  referrerPolicy?: ReferrerPolicy;
};

type VideoFrameSnapshot = {
  decodedFrames: number | null;
  totalFrames: number | null;
};

type MpegtsRequestConfig = {
  headers?: Record<string, string>;
  referrerPolicy?: ReferrerPolicy;
};

type StreamRequestTimeouts = {
  timeoutMs?: number;
  firstByteTimeoutMs?: number;
  segmentTimeoutMs?: number;
};

const HEVC_FIRST_FRAME_TIMEOUT_MS = 10_000;
// 底部控制栏刷新按钮图标（与 ArtPlayer 内建图标同为 22px）
const REFRESH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"></path></svg>`;
const HEVC_MIME_TYPES = [
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1.1.6.L120.B0"',
  'video/mp4; codecs="hev1.1.6.L120.B0"',
  'video/mp4; codecs="hvc1.2.4.L120.B0"',
  'video/mp4; codecs="hev1.2.4.L120.B0"',
];
const FORBIDDEN_REQUEST_HEADER_NAMES = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "refer",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);

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
let pendingErrorMessage: string | null = null;
let flvPlayer: mpegts.Player | null = null;
let hlsPlayer: Hls | null = null;
let nativeHlsVideo: HTMLVideoElement | null = null;
let activeStreamUrl: string | null = null;
let currentQuality: StreamQuality = defaultQuality;
let hevcFirstFrameWatchCleanup: (() => void) | null = null;
let streamLoadTimeoutWatchCleanup: (() => void) | null = null;
let isDestroyingStream = false;
let isTransitioningStream = false;
let customContextmenuRecords: CustomContextmenuItemRecord[] | null = null;
let warnedNativeHlsRequestConfig = false;
let warnedFetchReferrerFallback = false;
const warnedForbiddenRequestHeaders = new Set<string>();
const publicAssetUrl = createPublicAssetUrlResolver(import.meta.env.BASE_URL);
const configuredPoster = resolveConfiguredPoster(playerConfig.poster);

const art = new Artplayer({
  container: app,
  url: defaultQuality.url,
  poster: configuredPoster,
  title: playerConfig.title,
  theme: playerConfig.theme,
  autoplay: playerConfig.autoplay,
  autoOrientation: playerConfig.autoorientation,
  muted: false,
  volume: 1,
  isLive: playerConfig.isLive,
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

applyConfiguredVideoPoster(art.video);
installControlsAutoHide(art);
removeLiveProgressContainer(art);
installRefreshControl(art);
installCustomContextmenu(art);
refreshTemplateControlsVisibility();

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

function resolveConfiguredPoster(poster: string | undefined) {
  const normalizedPoster = poster?.trim();

  if (!normalizedPoster) {
    return "";
  }

  if (isAbsoluteAssetUrl(normalizedPoster)) {
    return normalizedPoster;
  }

  return publicAssetUrl(normalizedPoster);
}

function isAbsoluteAssetUrl(url: string) {
  return /^(?:[a-z][a-z\d+\-.]*:)?\/\//i.test(url) || url.startsWith("data:") || url.startsWith("blob:");
}

function applyConfiguredVideoPoster(video: HTMLVideoElement) {
  if (configuredPoster) {
    video.poster = configuredPoster;
    return;
  }

  video.removeAttribute("poster");
}

function getStreamRequestHeaders(
  requestConfig: RequestHeaderConfig | undefined = playerConfig.request,
): Record<string, string> | undefined {
  const headers = requestConfig?.headers;

  if (!headers) {
    return undefined;
  }

  const nextHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const headerName = name.trim();
    const headerValue = value.trim();

    if (!headerName || !headerValue) {
      continue;
    }

    if (isForbiddenRequestHeaderName(headerName)) {
      warnForbiddenRequestHeader(headerName);
      continue;
    }

    nextHeaders[headerName] = headerValue;
  }

  return Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined;
}

function getStreamReferrer(requestConfig: RequestHeaderConfig | undefined = playerConfig.request) {
  return (
    requestConfig?.referer?.trim() ||
    requestConfig?.referrer?.trim() ||
    requestConfig?.refer?.trim() ||
    requestConfig?.Refer?.trim() ||
    getHeaderValue(requestConfig?.headers, "referer") ||
    getHeaderValue(requestConfig?.headers, "refer") ||
    undefined
  );
}

function getHeaderValue(headers: Record<string, string> | undefined, name: string) {
  if (!headers) {
    return undefined;
  }

  const entry = Object.entries(headers).find(([headerName]) => headerName.trim().toLowerCase() === name);
  return entry?.[1].trim() || undefined;
}

function getStreamReferrerPolicy(requestConfig: RequestHeaderConfig | undefined = playerConfig.request) {
  return requestConfig?.referrerPolicy;
}

function getStreamRequestTimeouts(
  requestConfig: RequestHeaderConfig | undefined = playerConfig.request,
): StreamRequestTimeouts {
  return {
    timeoutMs: normalizeRequestTimeoutMs(requestConfig?.timeoutMs),
    firstByteTimeoutMs: normalizeRequestTimeoutMs(requestConfig?.firstByteTimeoutMs),
    segmentTimeoutMs: normalizeRequestTimeoutMs(requestConfig?.segmentTimeoutMs),
  };
}

function normalizeRequestTimeoutMs(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function hasStreamRequestTimeout(timeouts: StreamRequestTimeouts) {
  return Boolean(timeouts.timeoutMs || timeouts.firstByteTimeoutMs || timeouts.segmentTimeoutMs);
}

function hasCustomStreamRequestTransportOptions() {
  return Boolean(getStreamRequestHeaders() || getStreamReferrer());
}

function getHlsRequestLoaderConfig() {
  if (!getStreamReferrer() || !canUseFetchRequestLoader()) {
    return {};
  }

  return {
    loader: FetchLoader,
  };
}

function getHlsRequestTimeoutConfig(): Partial<
  Pick<HlsConfig, "manifestLoadPolicy" | "playlistLoadPolicy" | "fragLoadPolicy" | "keyLoadPolicy">
> {
  const timeouts = getStreamRequestTimeouts();

  if (!hasStreamRequestTimeout(timeouts)) {
    return {};
  }

  const playlistTimeoutMs = timeouts.timeoutMs;
  const segmentTimeoutMs = timeouts.segmentTimeoutMs ?? timeouts.timeoutMs;
  const firstByteTimeoutMs = timeouts.firstByteTimeoutMs ?? timeouts.timeoutMs;

  return {
    manifestLoadPolicy: createHlsLoadPolicy(
      Hls.DefaultConfig.manifestLoadPolicy.default,
      playlistTimeoutMs,
      firstByteTimeoutMs,
    ),
    playlistLoadPolicy: createHlsLoadPolicy(
      Hls.DefaultConfig.playlistLoadPolicy.default,
      playlistTimeoutMs,
      firstByteTimeoutMs,
    ),
    fragLoadPolicy: createHlsLoadPolicy(
      Hls.DefaultConfig.fragLoadPolicy.default,
      segmentTimeoutMs,
      firstByteTimeoutMs,
    ),
    keyLoadPolicy: createHlsLoadPolicy(
      Hls.DefaultConfig.keyLoadPolicy.default,
      segmentTimeoutMs,
      firstByteTimeoutMs,
    ),
  };
}

function createHlsLoadPolicy(
  defaultConfig: LoaderConfig,
  timeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
) {
  return {
    default: {
      ...defaultConfig,
      maxTimeToFirstByteMs: firstByteTimeoutMs ?? defaultConfig.maxTimeToFirstByteMs,
      maxLoadTimeMs: timeoutMs ?? defaultConfig.maxLoadTimeMs,
      timeoutRetry: defaultConfig.timeoutRetry ? { ...defaultConfig.timeoutRetry } : null,
      errorRetry: defaultConfig.errorRetry ? { ...defaultConfig.errorRetry } : null,
    },
  };
}

function canUseFetchRequestLoader() {
  return (
    typeof window.fetch === "function" &&
    typeof window.AbortController === "function" &&
    typeof window.ReadableStream === "function" &&
    typeof window.Request === "function"
  );
}

function isForbiddenRequestHeaderName(name: string) {
  const lowerName = name.trim().toLowerCase();

  return (
    FORBIDDEN_REQUEST_HEADER_NAMES.has(lowerName) ||
    lowerName.startsWith("proxy-") ||
    lowerName.startsWith("sec-")
  );
}

function warnForbiddenRequestHeader(name: string) {
  const lowerName = name.trim().toLowerCase();

  if (warnedForbiddenRequestHeaders.has(lowerName)) {
    return;
  }

  warnedForbiddenRequestHeaders.add(lowerName);
  console.warn(
    `浏览器不允许前端设置 ${name} 请求头；请使用 request.referer/referrerPolicy，或通过代理服务添加。`,
  );
}

function createMpegtsRequestConfig(): MpegtsRequestConfig {
  const headers = getStreamRequestHeaders();
  const referrerPolicy = getStreamReferrerPolicy();

  return {
    ...(headers ? { headers } : {}),
    ...(referrerPolicy ? { referrerPolicy } : {}),
  };
}

function applyNativeVideoRequestConfig(video: HTMLVideoElement) {
  const referrerPolicy = getStreamReferrerPolicy();

  if (referrerPolicy) {
    (video as VideoWithReferrerPolicy).referrerPolicy = referrerPolicy;
  }

  if (hasCustomStreamRequestTransportOptions()) {
    warnNativeHlsRequestConfig();
  }
}

function warnNativeHlsRequestConfig() {
  if (warnedNativeHlsRequestConfig) {
    return;
  }

  warnedNativeHlsRequestConfig = true;
  console.warn("当前使用浏览器原生 HLS 播放，自定义 headers/referer 无法保证应用到 m3u8/ts 请求。");
}

function applyRequestHeadersToXhr(xhr: XMLHttpRequest, url: string) {
  const headers = getStreamRequestHeaders();

  if (!headers) {
    return;
  }

  if (!xhr.readyState) {
    xhr.open("GET", url, true);
  }

  for (const [name, value] of Object.entries(headers)) {
    xhr.setRequestHeader(name, value);
  }
}

function createHlsFetchRequest(url: string, initParams: RequestInit) {
  const requestInit = applyRequestConfigToFetchInit(initParams);

  try {
    return new Request(url, requestInit);
  } catch (error) {
    if (!warnedFetchReferrerFallback) {
      warnedFetchReferrerFallback = true;
      console.warn("当前浏览器拒绝了自定义 referrer，已仅保留普通自定义 headers 重试。", error);
    }

    const fallbackInit = { ...requestInit };
    delete fallbackInit.referrer;
    delete fallbackInit.referrerPolicy;
    return new Request(url, fallbackInit);
  }
}

function applyRequestConfigToFetchInit(initParams: RequestInit): RequestInit {
  const headers = getStreamRequestHeaders();
  const referrer = getStreamReferrer();
  const referrerPolicy = getStreamReferrerPolicy();
  const requestInit: RequestInit = { ...initParams };

  if (headers) {
    requestInit.headers = mergeRequestHeaders(initParams.headers, headers);
  }

  if (referrer) {
    requestInit.referrer = referrer;
  }

  if (referrerPolicy) {
    requestInit.referrerPolicy = referrerPolicy;
  }

  return requestInit;
}

function mergeRequestHeaders(
  currentHeaders: HeadersInit | undefined,
  nextHeaders: Record<string, string>,
): Headers {
  const headers = new Headers(currentHeaders);

  for (const [name, value] of Object.entries(nextHeaders)) {
    headers.set(name, value);
  }

  return headers;
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

  updateCustomContextmenuVisibility();
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

  const hasMousePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? true;
  let lastTouchTimestamp = Number.NEGATIVE_INFINITY;

  const markTouchInteraction = () => {
    lastTouchTimestamp = performance.now();
  };

  const isTouchGeneratedMouseEvent = () => performance.now() - lastTouchTimestamp < 1000;

  const handlePlayerPointerLeave = (event: PointerEvent) => {
    // 触摸/触控笔抬起时指针就会被销毁并触发 pointerleave，
    // 此时用户并没有离开播放器，只有鼠标移出播放器才应该隐藏控制栏。
    if (event.pointerType !== "mouse") {
      return;
    }

    hideControls();
  };

  const handlePlayerMouseLeave = () => {
    // 触摸设备会补发 mouseleave/mouseout 兼容事件，需要忽略它们。
    if (isTouchGeneratedMouseEvent()) {
      return;
    }

    hideControls();
  };

  const handleDocumentMouseOut = (event: MouseEvent) => {
    if (!event.relatedTarget && !isTouchGeneratedMouseEvent()) {
      hideControls();
    }
  };

  player.template.$player.addEventListener("pointerleave", handlePlayerPointerLeave);
  document.addEventListener("touchstart", markTouchInteraction, { capture: true, passive: true });

  if (hasMousePointer) {
    player.template.$player.addEventListener("mouseleave", handlePlayerMouseLeave);
    document.addEventListener("mouseout", handleDocumentMouseOut);
  }

  window.addEventListener("blur", hideControls);
  document.addEventListener("visibilitychange", hideControls);

  player.on("destroy", () => {
    player.template.$player.removeEventListener("pointerleave", handlePlayerPointerLeave);
    player.template.$player.removeEventListener("mouseleave", handlePlayerMouseLeave);
    document.removeEventListener("touchstart", markTouchInteraction, { capture: true });
    document.removeEventListener("mouseout", handleDocumentMouseOut);
    window.removeEventListener("blur", hideControls);
    document.removeEventListener("visibilitychange", hideControls);
  });
}

function installRefreshControl(player: Artplayer) {
  player.controls.add({
    name: "refresh",
    position: "left",
    index: 30,
    html: REFRESH_ICON,
    tooltip: "刷新",
    click() {
      refreshPlayback(player);
    },
  } as Parameters<Artplayer["controls"]["add"]>[0]);
}

function refreshPlayback(player: Artplayer) {
  if (isDestroyingStream || isTransitioningStream) {
    return;
  }

  const shouldResume = !player.video.paused;

  trackClarityEvent("stream_source_refreshed");
  hidePlayerError();
  player.notice.show = "已刷新";

  isTransitioningStream = true;

  try {
    loadStreamSource(player.video, currentQuality);
  } finally {
    isTransitioningStream = false;
  }

  if (shouldResume) {
    player.video.play().catch((error) => {
      console.warn("Failed to resume playback after refresh:", error);
    });
  }
}

function removeLiveProgressContainer(player: Artplayer) {
  if (!player.option.isLive || !player.template.$progress.isConnected) {
    return;
  }

  player.template.$progress.remove();
}

type CustomContextmenuItemRecord = {
  config: ContextmenuItemConfig;
  order: number;
  element?: HTMLElement;
};

function installCustomContextmenu(player: Artplayer) {
  const configs = playerConfig.contextmenu ?? [];

  if (configs.length === 0) {
    return;
  }

  const dialog = createCustomContextmenuDialog(player);
  const records: CustomContextmenuItemRecord[] = configs.map((config, order) => ({ config, order }));
  customContextmenuRecords = records;

  for (const record of records) {
    const { config, order } = record;
    const itemName = `ayumu-custom-${order}`;
    player.contextmenu.add({
      name: itemName,
      index: (config.index ?? 0) + order / 1000,
      html: interpolateContextmenuHtml(config.html),
      style: isCustomContextmenuItemVisible(config) ? undefined : { display: "none" },
      mounted(element: HTMLElement) {
        record.element = element;
      },
      click(menu: unknown, event: Event) {
        // 点击后（无论打开链接还是弹窗）都应像内建菜单项一样收起右键菜单。
        (menu as { show?: boolean }).show = false;
        runCustomContextmenuAction(dialog, config, event);
      },
    } as Parameters<Artplayer["contextmenu"]["add"]>[0]);
  }

  player.on("destroy", () => {
    for (const record of customContextmenuRecords ?? []) {
      record.element = undefined;
    }
  });
}

function updateCustomContextmenuVisibility() {
  if (!customContextmenuRecords) {
    return;
  }

  for (const record of customContextmenuRecords) {
    if (!record.element) {
      continue;
    }

    record.element.style.display = isCustomContextmenuItemVisible(record.config) ? "" : "none";
  }
}

function isCustomContextmenuItemVisible(config: ContextmenuItemConfig) {
  if (!config.hiddenWhen || !selectedTemplateValues) {
    return true;
  }

  return !matchesTemplateControlCondition(config.hiddenWhen, selectedTemplateValues);
}

// 替换右键菜单 html 里的占位符：{commit} → 完整提交哈希；{commit8} → 8 位缩写
function interpolateContextmenuHtml(html: string) {
  const commit = typeof __AYUMU_COMMIT__ === "string" ? __AYUMU_COMMIT__ : "unknown";
  return html.replace(/\{commit8\}|\{commit\}/g, (placeholder) =>
    placeholder === "{commit8}" ? commit.slice(0, 8) : commit,
  );
}

type CustomContextmenuDialog = {
  root: HTMLDivElement;
  title: HTMLDivElement;
  content: HTMLDivElement;
};

function createCustomContextmenuDialog(player: Artplayer): CustomContextmenuDialog {
  const root = document.createElement("div");
  const panel = document.createElement("div");
  const title = document.createElement("div");
  const content = document.createElement("div");
  const closeButton = document.createElement("button");

  root.className = "player-contextmenu-dialog";
  root.hidden = true;
  panel.className = "player-contextmenu-dialog-panel";
  title.className = "player-contextmenu-dialog-title";
  content.className = "player-contextmenu-dialog-content";
  closeButton.className = "player-contextmenu-dialog-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "关闭");
  closeButton.textContent = "×";

  panel.append(title, content, closeButton);
  root.appendChild(panel);
  player.template.$player.appendChild(root);

  const hideDialog = () => {
    root.hidden = true;
  };

  closeButton.addEventListener("click", hideDialog);

  const handleDocumentClick = (event: MouseEvent) => {
    if (root.hidden) {
      return;
    }

    const target = event.target;

    if (target instanceof Node && !root.contains(target)) {
      hideDialog();
    }
  };

  document.addEventListener("click", handleDocumentClick);

  player.on("destroy", () => {
    document.removeEventListener("click", handleDocumentClick);
    root.remove();
  });

  return { root, title, content };
}

function showCustomContextmenuDialog(
  dialog: CustomContextmenuDialog,
  options: { title?: string; html: string; position?: string; width?: number },
) {
  const positions = ["top-left", "top-right", "bottom-left", "bottom-right", "center"];

  dialog.title.textContent = options.title ?? "";
  dialog.title.hidden = !options.title;
  dialog.content.innerHTML = options.html;

  for (const position of positions) {
    dialog.root.classList.remove(`player-contextmenu-dialog-${position}`);
  }

  dialog.root.classList.add(
    `player-contextmenu-dialog-${positions.includes(options.position ?? "") ? options.position : "center"}`,
  );
  dialog.root.style.setProperty(
    "--player-contextmenu-dialog-width",
    typeof options.width === "number" && options.width > 0 ? `${Math.round(options.width)}px` : "",
  );
  dialog.root.hidden = false;
}

function runCustomContextmenuAction(
  dialog: CustomContextmenuDialog,
  config: ContextmenuItemConfig,
  event: Event,
) {
  const action = config.action;

  if (!action) {
    return;
  }

  if (action.type === "link") {
    const url = action.url.trim();

    if (!url) {
      return;
    }

    if (action.target && action.target !== "_blank") {
      window.open(url, action.target);
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  showCustomContextmenuDialog(dialog, {
    title: action.title,
    html: action.html,
    position: action.position,
    width: action.width,
  });
  trackClarityEvent("contextmenu_dialog_opened");
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

function loadStreamSource(video: HTMLVideoElement, quality: StreamQuality) {
  const format = getStreamFormat(quality);

  if (!format) {
    trackClarityEvent("stream_source_load_failed");
    showPlayerError('无法识别播放源格式，请在配置里把 format 设成 "flv" 或 "m3u8"。');
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
    } finally {
      isTransitioningStream = false;
    }

    return;
  }

  isTransitioningStream = true;
  clearHevcFirstFrameWatch();
  clearStreamLoadTimeoutWatch();
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
    if (currentQuality.url !== sourceUrl || activeStreamUrl !== sourceUrl || video.paused) {
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

function startStreamLoadTimeoutWatch(video: HTMLVideoElement, quality: StreamQuality) {
  clearStreamLoadTimeoutWatch();

  const timeoutMs = getStreamRequestTimeouts().timeoutMs;

  if (!timeoutMs) {
    return;
  }

  const sourceUrl = quality.url;
  const handleLoadReady = () => {
    if (currentQuality.url === sourceUrl && activeStreamUrl === sourceUrl) {
      clearStreamLoadTimeoutWatch();
    }
  };
  const timeoutId = window.setTimeout(() => {
    if (currentQuality.url !== sourceUrl || activeStreamUrl !== sourceUrl || isDestroyingStream) {
      clearStreamLoadTimeoutWatch();
      return;
    }

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      clearStreamLoadTimeoutWatch();
      return;
    }

    trackClarityEvent("stream_source_load_failed");
    showPlayerError(`拉取 ${quality.name} 超时，请检查源站响应或调大 request.timeoutMs。`);
    destroyStreamPlayer(video);
  }, timeoutMs);
  const events: Array<[string, EventListener]> = [
    ["loadeddata", handleLoadReady],
    ["canplay", handleLoadReady],
    ["playing", handleLoadReady],
    ["error", handleLoadReady],
  ];

  for (const [eventName, listener] of events) {
    video.addEventListener(eventName, listener);
  }

  streamLoadTimeoutWatchCleanup = () => {
    window.clearTimeout(timeoutId);

    for (const [eventName, listener] of events) {
      video.removeEventListener(eventName, listener);
    }
  };
}

function clearStreamLoadTimeoutWatch() {
  streamLoadTimeoutWatchCleanup?.();
  streamLoadTimeoutWatchCleanup = null;
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

function shouldUseNativeHls(video: HTMLVideoElement) {
  if (!canUseNativeHls(video)) {
    return false;
  }

  return !hasCustomStreamRequestTransportOptions() || !Hls.isSupported();
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
    activeStreamUrl = null;
    return;
  }

  if (quality.codec === "hevc" && !isHevcMsePlaybackSupported(features)) {
    const message = "当前浏览器不支持 HEVC/H.265 的 MSE 播放，请切换 AVC 清晰度或使用支持 HEVC 的浏览器。";

    trackClarityEvent("flv_source_load_failed");

    if (switchToAvcFallback(video, quality, message)) {
      return;
    }

    showPlayerError(message);
    activeStreamUrl = null;
    return;
  }

  try {
    const requestConfig = createMpegtsRequestConfig();

    flvPlayer = mpegts.createPlayer(
      {
        type: "flv",
        url: quality.url,
        isLive: playerConfig.isLive,
      },
      {
        enableStashBuffer: false,
        stashInitialSize: 128,
        autoCleanupSourceBuffer: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 1.5,
        liveBufferLatencyMinRemain: 0.5,
        ...requestConfig,
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
    activeStreamUrl = quality.url;
    startStreamLoadTimeoutWatch(video, quality);
    flvPlayer.load();
    startHevcFirstFrameWatch(video, quality);
  } catch (error) {
    trackClarityEvent("flv_source_load_failed");
    showPlayerError(`FLV 加载失败：${error instanceof Error ? error.message : String(error)}`);
    activeStreamUrl = null;
    destroyStreamPlayer(video);
  }
}

function loadHlsSource(video: HTMLVideoElement, quality: StreamQuality) {
  trackClarityEvent("m3u8_source_loaded");

  if (shouldUseNativeHls(video)) {
    applyNativeVideoRequestConfig(video);
    nativeHlsVideo = video;
    activeStreamUrl = quality.url;
    startStreamLoadTimeoutWatch(video, quality);
    video.src = quality.url;
    video.load();
    startHevcFirstFrameWatch(video, quality);
    return;
  }

  if (!Hls.isSupported()) {
    trackClarityEvent("m3u8_source_load_failed");
    showPlayerError("当前浏览器不支持 HLS/M3U8 播放，请更换支持 Media Source Extensions 或原生 HLS 的浏览器。");
    activeStreamUrl = null;
    return;
  }

  try {
    hlsPlayer = new Hls({
      lowLatencyMode: true,
      backBufferLength: 30,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      ...getHlsRequestLoaderConfig(),
      ...getHlsRequestTimeoutConfig(),
      xhrSetup(xhr, url) {
        applyRequestHeadersToXhr(xhr, url);
      },
      fetchSetup(context, initParams) {
        return createHlsFetchRequest(context.url, initParams);
      },
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
        destroyStreamPlayer(video);
      }
    });

    activeStreamUrl = quality.url;
    startStreamLoadTimeoutWatch(video, quality);
    hlsPlayer.loadSource(quality.url);
    hlsPlayer.attachMedia(video);
    startHevcFirstFrameWatch(video, quality);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    trackClarityEvent("m3u8_source_load_failed");

    if (quality.codec === "hevc" && switchToAvcFallback(video, quality, `HEVC M3U8 加载失败：${detail}`)) {
      return;
    }

    showPlayerError(`M3U8 加载失败：${detail}`);
    activeStreamUrl = null;
    destroyStreamPlayer(video);
  }
}

function resetVideo(video: HTMLVideoElement) {
  try {
    video.pause();
    video.removeAttribute("src");
    applyConfiguredVideoPoster(video);
    video.load();
  } catch (error) {
    console.error("Video reset failed:", error);
  }
}

function destroyStreamPlayer(video?: HTMLVideoElement) {
  if (isDestroyingStream) {
    return;
  }

  isDestroyingStream = true;
  clearHevcFirstFrameWatch();
  clearStreamLoadTimeoutWatch();

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
    activeStreamUrl = null;
    // 旧源已被销毁，新源在真正播放前不应触发暂停截帧。

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
