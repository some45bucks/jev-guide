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

/** The host-permission pattern Chrome needs before the extension can call this base URL. */
export function originPattern(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set(settings);
}
