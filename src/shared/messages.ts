// Messages between extension pages and the background service worker. One union type
// keeps both sides of chrome.runtime.sendMessage in agreement at compile time.

import type { PageSnapshot } from "../content/candidates";
import type { Tone } from "../content/overlay";
import type { Settings } from "./settings";
import type { Suggestion } from "./suggest";

/** Extension pages to the background worker. */
export type Message =
  | { type: "testConnection"; settings: Settings }
  | { type: "suggest"; goal: string; page: PageSnapshot; previousSteps: string[] };

/**
 * Side panel to the content script. A scan also draws or clears the debug badges, so they
 * always match the table. Highlights refer to elements by the ids of the latest scan.
 */
export type ContentMessage =
  | { type: "scan"; badges: boolean }
  | { type: "highlight"; marks: { id: string; text: string; tone: Exclude<Tone, "debug"> }[] }
  | { type: "clearHighlight" };

export interface ScanReply {
  page: PageSnapshot;
  ms: number;
}

/** Ids that couldn't be highlighted because the element left the page since the scan. */
export interface HighlightReply {
  missing: string[];
}

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

export interface Usage {
  /** Jev requests made: 1, or more on pages that needed ranking first. */
  calls: number;
  inputTokens: number;
  /** Wall-clock time for all of them. */
  latencyMs: number;
}

export type SuggestReply =
  | { ok: true; model: string; suggestion: Suggestion; usage: Usage }
  | { ok: false; error: string };
