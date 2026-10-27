// Content script, injected on demand by the side panel with chrome.scripting.executeScript.
// It reads the page, draws overlays, and reports the person's clicks. It never clicks, types
// or submits anything, and it never stops a click from going through.
//
// It only takes orders from chrome.runtime messages, which web pages can't send, so text on
// the page is only ever data: nothing a page says can make this script act.

import { type Candidate, snapshotPage } from "./content/candidates";
import { clearLayer, showLayer } from "./content/overlay";
import { waitForQuiet } from "./content/settle";
import type { ContentMessage, HighlightReply, PageEvent, ScanReply } from "./shared/messages";

declare global {
  // Set on the content script's isolated world, which persists across injections into the same page.
  var __jevGuideLoaded: boolean | undefined;
}

// The side panel injects this script before every scan, because it can't know whether the
// page still has it (a navigation clears it). The flag keeps listeners from being added twice.
if (!globalThis.__jevGuideLoaded) {
  globalThis.__jevGuideLoaded = true;

  // Elements and labels from the latest scan, by candidate id, so highlights and recorded
  // clicks refer to exactly what Jev saw.
  let byId = new Map<string, { element: Element; candidate: Candidate }>();

  chrome.runtime.onMessage.addListener((message: ContentMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;

    if (message.type === "scan") {
      const started = performance.now();
      const { page, elements } = snapshotPage(document);
      const ms = Math.round(performance.now() - started);
      byId = new Map(page.candidates.map((c, i) => [c.id, { element: elements[i]!, candidate: c }]));
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
        const element = byId.get(m.id)?.element;
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
    } else if (message.type === "waitForQuiet") {
      waitForQuiet(document).then(() => sendResponse({}));
      return true; // answers asynchronously
    }
    return false;
  });

  // Capture phase, so the click is seen even if the page stops it from bubbling. Passive: it
  // only observes, and never calls preventDefault, so the page always gets the click.
  document.addEventListener(
    "click",
    (event) => {
      // Synthetic clicks from page scripts (element.click()) have isTrusted false.
      if (!event.isTrusted || !(event.target instanceof Node)) return;
      for (const { element, candidate } of byId.values()) {
        if (element.contains(event.target)) {
          // The highlight described the page before the click; it's stale now.
          clearLayer("suggestion");
          const { role, label, href } = candidate;
          const report: PageEvent = { type: "clicked", element: { role, label, href } };
          // No receiver (the panel was closed) is fine; the click simply isn't recorded.
          chrome.runtime.sendMessage(report).catch(() => {});
          return;
        }
      }
    },
    { capture: true, passive: true },
  );
}
