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

export type PlayerConfig = {
  title: string;
  StreamName: string;
  AppName: string;
  theme: string;
  request?: RequestHeaderConfig;
  qualities: StreamQuality[];
  complex?: ComplexPlayerConfig;
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
  theme: "#00A3FF",
  request: {
    // 浏览器不允许前端伪造 Referer 请求头；如源站强校验 Referer，建议用代理服务补头。
    referer: "",
    referrerPolicy: "no-referrer-when-downgrade",
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
      route_id: "00",
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
};

export const analyticsConfig: AnalyticsConfig = {
  clarityProjectId: "1a2b3c4d5e",
};
