// Settings live in chrome.storage.local, not chrome.storage.sync: sync would copy the
// API key to every browser signed in to the same Google account.

export interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  baseUrl: TYPESAFE_BASE_URL,
  model: "jev-latest",
};

/**
 * Cleans up a base URL typed by a person. It throws an Error with a message for that
 * person if the URL can't be used. Plain http is allowed only for localhost, which is
 * where a development proxy (the production setup in the README) would run.
 */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("The base URL isn't a valid URL. Example: https://api.typesafe.ai");
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("The base URL must start with https:// (plain http is allowed only for localhost).");
  }
  // People often paste the full endpoint. Accept it and keep only the base.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1\/systemone$/, "");
  return url.origin + path;
}

/**
 * The host-permission pattern Chrome needs before the extension can call or script this URL.
 * Leaves out the port: a pattern without one matches every port, so http://localhost:8123
 * falls under the manifest's optional "http://localhost/*".
 */
export function originPattern(url: string): string {
  const { protocol, hostname } = new URL(url);
  return `${protocol}//${hostname}/*`;
}

/**
 * The pattern to request before scanning a page, or null for pages the extension can't
 * script. Matches optional_host_permissions in the manifest: https sites and local servers.
 */
export function pagePattern(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) return originPattern(url);
  return null;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set(settings);
}
