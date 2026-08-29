export type StreamFormat = "flv" | "m3u8";

export type StreamQuality = {
  name: string;
  url: string;
  default?: boolean;
  format?: StreamFormat;
  codec?: "avc" | "hevc";
};

export type PlayerConfig = {
  title: string;
  theme: string;
  qualities: StreamQuality[];
  autoplay: boolean;
  autoorientation: boolean;
  screenshot: boolean;
};

export type AnalyticsConfig = {
  clarityProjectId: string;
}

export const playerConfig: PlayerConfig = {
  title: "Ayumu Live",
  theme: "#00A3FF",
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
  autoplay: true,
  autoorientation: true,
  screenshot: true,
};

export const analyticsConfig: AnalyticsConfig = {
  clarityProjectId: "1a2b3c4d5e",
};
