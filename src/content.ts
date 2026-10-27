// Content script, injected on demand by the side panel with chrome.scripting.executeScript.
// It reads the page and draws overlays. It never clicks, types or submits anything.
//
// It only takes orders from chrome.runtime messages, which web pages can't send, so text on
// the page is only ever data: nothing a page says can make this script act.

import { snapshotPage } from "./content/candidates";
import { clearLayer, showLayer } from "./content/overlay";
import type { ContentMessage, HighlightReply, ScanReply } from "./shared/messages";

declare global {
  // Set on the content script's isolated world, which persists across injections into the same page.
  var __jevGuideLoaded: boolean | undefined;
}

// The side panel injects this script before every scan, because it can't know whether the
// page still has it (a navigation clears it). The flag keeps a second listener from being added.
if (!globalThis.__jevGuideLoaded) {
  globalThis.__jevGuideLoaded = true;

  // Elements from the latest scan, by candidate id, so highlights point at what Jev saw.
  let byId = new Map<string, Element>();

  chrome.runtime.onMessage.addListener((message: ContentMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;

    if (message.type === "scan") {
      const started = performance.now();
      const { page, elements } = snapshotPage(document);
      const ms = Math.round(performance.now() - started);
      byId = new Map(page.candidates.map((c, i) => [c.id, elements[i]!]));
      // A new scan means any earlier suggestion may no longer match the page.
      clearLayer("suggestion");
      if (message.badges) {
        showLayer("badges", elements.map((element, i) => ({ element, text: String(i + 1), tone: "debug" })));
      } else {
        clearLayer("badges");
      }
      const reply: ScanReply = { page, ms };
      sendResponse(reply);
    } else if (message.type === "highlight") {
      const found = message.marks.flatMap((m) => {
        const element = byId.get(m.id);
        return element?.isConnected ? [{ ...m, element }] : [];
      });
      showLayer("suggestion", found);
      // Scrolling only changes the view, so it stays within "never act on the page".
      const first = found[0]?.element.getBoundingClientRect();
      if (first && (first.bottom < 0 || first.top > innerHeight)) {
        found[0]!.element.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const reply: HighlightReply = { missing: message.marks.filter((m) => !found.some((f) => f.id === m.id)).map((m) => m.id) };
      sendResponse(reply);
    } else if (message.type === "clearHighlight") {
      clearLayer("suggestion");
      sendResponse({});
    }
    return false;
  });
}
