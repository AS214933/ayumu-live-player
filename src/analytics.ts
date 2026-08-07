import Clarity from "@microsoft/clarity";
import { analyticsConfig } from "./playerConfig";

declare global {
  interface Window {
    clarity?: (...args: unknown[]) => void;
  }
}

const placeholderProjectIds = new Set(["", "yourProjectId", "1a2b3c4d5e"]);
let clarityReady = false;

export function initAnalytics() {
  const projectId = analyticsConfig.clarityProjectId.trim();

  if (!shouldEnableClarity(projectId)) {
    return false;
  }

  Clarity.init(projectId);
  clarityReady = typeof window.clarity === "function";
  return clarityReady;
}

export function trackClarityEvent(eventName: string) {
  if (!clarityReady || !eventName.trim()) {
    return;
  }

  try {
    Clarity.event(eventName);
  } catch (error) {
    console.warn("Failed to send Clarity event:", eventName, error);
  }
}

function shouldEnableClarity(projectId: string) {
  if (placeholderProjectIds.has(projectId)) {
    return false;
  }

  return import.meta.env.PROD || import.meta.env.VITE_ENABLE_CLARITY === "true";
}
