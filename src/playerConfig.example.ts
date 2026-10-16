export type StreamFormat = "flv" | "m3u8";
export type TemplateValue = string | number;
export type TemplateVariable =
  | TemplateValue
  | TemplateValue[]
  | {
      range: [number, number];
      step?: number;
      padStart?: number;
    }
  | {
      values: TemplateValue[];
    };
export type TemplateControlPlacement = "control" | "setting";
export type TemplateControlCondition = Record<string, TemplateValue>;
export type TemplateControlConfig = {
  label?: string;
  enabled?: boolean;
  placement?: TemplateControlPlacement;
  index?: number;
  hidden?: boolean;
  hiddenWhen?: TemplateControlCondition | TemplateControlCondition[];
  values?: TemplateValue[];
  valueLabels?: Record<string, string>;
};
export type TemplateDerivedVariableConfig = {
  template: string;
  emptyWhen?: Record<string, TemplateValue>;
};

export type StreamQuality = {
  name: string;
  url: string;
  default?: boolean;
  format?: StreamFormat;
  codec?: "avc" | "hevc";
};

export type RequestHeaderConfig = {
  headers?: Record<string, string>;
  refer?: string;
  Refer?: string;
  referer?: string;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
  timeoutMs?: number;
  firstByteTimeoutMs?: number;
  segmentTimeoutMs?: number;
};

export type ComplexPlayerConfig = {
  enabled: boolean;
  urlTemplate: string;
  nameTemplate?: string;
  variables?: Record<string, TemplateVariable>;
  derivedVariables?: Record<string, TemplateDerivedVariableConfig>;
  controls?: Record<string, TemplateControlConfig>;
  defaultValues?: Record<string, TemplateValue>;
  codec?: StreamQuality["codec"];
  codecs?: Partial<Record<StreamFormat, StreamQuality["codec"]>>;
};

export type ContextmenuAction =
  | {
      // 点击后在新标签页打开链接
      type: "link";
      url: string;
      target?: "_blank" | "_self" | "_parent" | "_top";
    }
  | {
      // 点击后在播放器内弹出浮层（样式同"统计信息"面板）
      type: "dialog";
      // 浮层标题
      title?: string;
      // 浮层内容，支持 HTML 字符串
      html: string;
      // 浮层出现的位置：四角或居中，默认居中
      position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
      // 浮层宽度（px），默认随内容、上限 560px
      width?: number;
    };

export type ContextmenuItemConfig = {
  // 菜单显示文本，支持 HTML 字符串
  html: string;
  // 排序权重，正序排列（index 越小越靠前，未配置时排在所有内建项之后）。
  // 内建项固定 index：10(播放速度) < 20(画面比例) < 30(画面翻转) < 40(统计信息) < 50(版本) < 60(关闭)。
  // 区间对照：
  //   index < 10          → 排在所有内建项最前面
  //   10 ~ 19.999...      → 播放速度 与 画面比例 之间
  //   20 ~ 29.999...      → 画面比例 与 画面翻转 之间
  //   30 ~ 39.999...      → 画面翻转 与 统计信息 之间
  //   40 ~ 49.999...      → 统计信息 与 版本 之间
  //   50 ~ 59.999...      → 版本 与 关闭 之间
  //   index >= 60         → 排在"关闭"之后（最末尾）
  // 支持小数精确插入（如 40.5 排在 40 与 50 的正中间）。
  // 两个自定义项 index 相同时，内部会自动加 0.001 级别的微调，
  // 按配置数组中的书写顺序正序排列（先写的在前）。
  index?: number;
  // 满足条件时隐藏该菜单项（同 complex.controls 的 hiddenWhen）
  hiddenWhen?: TemplateControlCondition | TemplateControlCondition[];
  action?: ContextmenuAction;
};

export type PlayerConfig = {
  title: string;
  StreamName: string;
  AppName: string;
  isLive: boolean;
  theme: string;
  poster?: string;
  request?: RequestHeaderConfig;
  qualities: StreamQuality[];
  complex?: ComplexPlayerConfig;
  // 自定义右键菜单，追加到内建菜单项中
  contextmenu?: ContextmenuItemConfig[];
  autoplay: boolean;
  autoorientation: boolean;
  screenshot: boolean;
};

export type AnalyticsConfig = {
  clarityProjectId: string;
};

export const playerConfig: PlayerConfig = {
  title: "Ayumu Live",
  // 浏览器标签页标题：StreamName 为空时只显示 AppName；两者都为空时保留 index.html 的默认标题。
  StreamName: "",
  AppName: "",
  isLive: true,
  theme: "#00A3FF",
  poster: "",
  request: {
    // 浏览器不允许前端伪造 Referer 请求头；如源站强校验 Referer，建议用代理服务补头。
    referer: "",
    referrerPolicy: "no-referrer-when-downgrade",
    timeoutMs: 60_000,
    firstByteTimeoutMs: 30_000,
    segmentTimeoutMs: 120_000,
    headers: {
      // "X-Custom-Header": "value",
    },
  },
  qualities: [
    {
      name: "原画 (M3U8)",
      url: "https://example.com/live-1080p.m3u8",
      format: "m3u8",
      codec: "avc",
      default: true,
    },
    {
      name: "高清 (FLV)",
      url: "https://example.com/live-720p.flv",
      format: "flv",
      codec: "avc",
    },
    {
      name: "流畅 (FLV)",
      url: "https://example.com/live-480p.flv",
      format: "flv",
      codec: "avc",
    },
  ],
  complex: {
    enabled: false,
    // URL 模板只写变量名；可选值从 controls.<变量>.valueLabels 的 key 读取。
    // variant 是派生后缀：Auto 时为空，否则生成 _wb{quality}{codec}。
    urlTemplate:
      "https://live{route_id}.example.com/{live_id}{variant}.{stream_format}",
    nameTemplate: "{route_id_label} {quality_label} {codec_label} ({stream_format_label})",
    variables: {
      live_id: "example1234567890",
    },
    derivedVariables: {
      variant: {
        template: "{quality}{codec}",
        emptyWhen: {
          quality: "",
        },
      },
    },
    controls: {
      route_id: {
        label: "线路",
        enabled: true,
        placement: "control",
        values: ["01", "02", "03"],
        valueLabels: {
          "01": "线路 1",
          "02": "线路 2",
          "03": "线路 3",
        },
      },
      quality: {
        label: "清晰度",
        enabled: true,
        placement: "control",
        valueLabels: {
          "": "Auto",
          "1080": "1080P",
          "720": "720P",
        },
      },
      codec: {
        label: "编码",
        enabled: true,
        placement: "control",
        hiddenWhen: [
          {
            quality: "",
          },
          {
            stream_format: "m3u8",
          },
        ],
        valueLabels: {
          avc: "AVC",
          hevc: "HEVC",
        },
      },
      stream_format: {
        label: "格式",
        enabled: true,
        placement: "setting",
        valueLabels: {
          m3u8: "HLS",
          flv: "FLV",
        },
      },
    },
    defaultValues: {
      route_id: "01",
      quality: "",
      codec: "avc",
      stream_format: "m3u8",
    },
    codecs: {
      m3u8: "avc",
      flv: "avc",
    },
  },
  autoplay: true,
  autoorientation: true,
  screenshot: true,
  // 自定义右键菜单示例（不需要时删除或留空数组）
  // 排序规则：index 正序（越小越靠前）；内建项固定为 10/20/30/40/50/60，
  // 区间对照见上方 ContextmenuItemConfig.index 注释。
  contextmenu: [
    {
      html: "官方网站",
      index: 5, // 5 < 10 → 排在所有内建项最前面
      action: {
        type: "link",
        url: "https://example.com",
        target: "_blank",
      },
    },
    {
      html: "直播间信息",
      index: 45, // 40 ≤ 45 < 50 → 排在"统计信息"与"版本"之间
      action: {
        type: "dialog",
        title: "直播间信息",
        html: "<p>这里可以填写直播间的介绍、主播信息等内容，支持 HTML。</p>",
        position: "center",
      },
    },
    {
      html: "关注主播",
      index: 70, // 70 ≥ 60 → 排在"关闭"之后（最末尾）
      action: {
        type: "dialog",
        html: "<p>扫码或点击链接关注主播。</p>",
        position: "bottom-right",
        width: 320,
      },
    },
  ],
};

export const analyticsConfig: AnalyticsConfig = {
  clarityProjectId: "1a2b3c4d5e",
};
