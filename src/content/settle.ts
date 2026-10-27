// Decides when a page has settled after a click that didn't navigate: a single-page app
// swapping views, a tab panel opening. Full navigations are seen by the side panel through
// chrome.tabs instead, since they replace this script along with the page.

/** Quiet time that counts as settled. Most views finish rendering well within it. */
export const QUIET_MS = 500;
/** Upper bound, for pages that never go quiet (clocks, carousels, live feeds). */
export const MAX_WAIT_MS = 4000;

/** Resolves once `root` has had no DOM changes for quietMs, or after maxMs at the latest. */
export function waitForQuiet(root: Node, quietMs = QUIET_MS, maxMs = MAX_WAIT_MS): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = setTimeout(done, quietMs);
    const capTimer = setTimeout(done, maxMs);
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });

    function done(): void {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      resolve();
    }
  });
}
