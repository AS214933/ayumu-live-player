export type StreamQuality = {
  name: string;
  url: string;
  default?: boolean;
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

export const playerConfig: PlayerConfig = {
  title: "Ayumu Live",
  theme: "#00A3FF",
  qualities: [
    {
      name: "原画",
      url: "https://example.com/live-1080p.flv",
      default: true,
    },
    {
      name: "高清",
      url: "https://example.com/live-720p.flv",
    },
    {
      name: "流畅",
      url: "https://example.com/live-480p.flv",
    },
  ],
  autoplay: true,
  autoorientation: true,
  screenshot: true,
};
