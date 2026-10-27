// Content script, injected on demand by the side panel with chrome.scripting.executeScript.
// It reads the page and draws overlays. It never clicks, types or submits anything.
//
// It only takes orders from chrome.runtime messages, which web pages can't send, so text on
// the page is only ever data: nothing a page says can make this script act.

import { hideBadges, showBadges } from "./content/badges";
import { extractCandidates } from "./content/candidates";
import type { ContentMessage, ScanReply } from "./shared/messages";

declare global {
  // Set on the content script's isolated world, which persists across injections into the same page.
  var __jevGuideLoaded: boolean | undefined;
}

// The side panel injects this script before every scan, because it can't know whether the
// page still has it (a navigation clears it). The flag keeps a second listener from being added.
if (!globalThis.__jevGuideLoaded) {
  globalThis.__jevGuideLoaded = true;

  chrome.runtime.onMessage.addListener((message: ContentMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message.type !== "scan") return false;

    const started = performance.now();
    const { candidates, elements } = extractCandidates(document);
    const ms = Math.round(performance.now() - started);

    if (message.badges) {
      showBadges(elements.map((element, i) => ({ number: i + 1, element })));
    } else {
      hideBadges();
    }
    const reply: ScanReply = { candidates, ms };
    sendResponse(reply);
    return false;
  });
}
