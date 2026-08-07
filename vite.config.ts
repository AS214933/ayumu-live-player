import { defineConfig } from "vite";

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE_PATH ?? "./"),
});

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
