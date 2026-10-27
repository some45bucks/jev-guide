// Messages between extension pages and the background service worker. One union type
// keeps both sides of chrome.runtime.sendMessage in agreement at compile time.

import type { Settings } from "./settings";

export type Message = { type: "testConnection"; settings: Settings };

/**
 * True when a message comes from one of the extension's own pages (options, side panel).
 * Checks the sender's URL rather than sender.tab: the options page opens in a normal tab,
 * so it has sender.tab set just like a content script, but its URL is chrome-extension://.
 * A content script's sender URL is the web page's URL.
 */
export function isFromExtensionPage(senderUrl: string | undefined, extensionBaseUrl: string): boolean {
  return senderUrl !== undefined && senderUrl.startsWith(extensionBaseUrl);
}

export type TestConnectionReply =
  | { ok: true; model: string; noul: number; latencyMs: number; inputTokens: number | null }
  | { ok: false; error: string };
