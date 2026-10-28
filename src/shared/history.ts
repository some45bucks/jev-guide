// The path so far, as a small graph: pages are nodes and moves between them are edges.
// Jev sees the latest edges as text. The code also uses the whole graph to stop suggesting
// clicks that already led nowhere, because Jev given only the history doesn't reliably avoid
// them: in tests it went back into a dead end it had been shown, sometimes even when told.

import type { Candidate, PageSnapshot } from "../content/candidates";

/** What identifies an element across visits, since candidate ids change with every scan. */
export type ElementRef = Pick<Candidate, "role" | "label" | "href">;

/**
 * A page as a node. The title and headings are part of its identity because single-page apps
 * often keep one path for many views: "Step 2 of 3" and "Step 3 of 3", or a form before and
 * after an error message, are different nodes.
 */
export interface PageRef {
  path: string;
  title: string;
  headings: string[];
}

export interface HistoryEdge {
  from: PageRef;
  /** The element clicked, or null for a move the extension saw no click for (Back, a typed URL). */
  element: ElementRef | null;
  to: PageRef;
}

/** How many recent edges go into the state. The full history is still used for dead ends. */
export const MAX_HISTORY_IN_STATE = 12;
/** Clicks on the same element that leave the page unchanged before it stops being suggested. */
export const MAX_NO_CHANGE_CLICKS = 2;

/** One compact line per element: "link: Billing → /billing.html". */
export function elementLine(e: ElementRef): string {
  return `${e.role}: ${e.label || "(no label)"}${e.href ? ` → ${e.href}` : ""}`;
}

export function pageRef(page: PageSnapshot): PageRef {
  return { path: page.path, title: page.title, headings: page.headings };
}

export function samePage(a: PageRef, b: PageRef): boolean {
  return a.path === b.path && a.title === b.title && a.headings.join("\n") === b.headings.join("\n");
}

export function sameElement(a: ElementRef, b: ElementRef): boolean {
  return a.role === b.role && a.label === b.label && a.href === b.href;
}

export function edgeText(edge: HistoryEdge): string {
  const how = edge.element ? `clicked ${elementLine(edge.element)}` : "navigated";
  const result = samePage(edge.from, edge.to) ? "the page didn't change" : `reached ${edge.to.path} (${edge.to.title})`;
  return `on ${edge.from.path}: ${how} ⇒ ${result}`;
}

/**
 * Adds the move that led to `here`, if any: the pending click, or a navigation the extension
 * didn't see a click for. Returns a new array, so a step can drop it if it turns out stale.
 */
export function recordArrival(
  history: HistoryEdge[],
  lastPage: PageRef | null,
  pendingClick: ElementRef | null,
  here: PageRef,
): HistoryEdge[] {
  if (!lastPage) return history;
  if (pendingClick) return [...history, { from: lastPage, element: pendingClick, to: here }];
  if (!samePage(lastPage, here)) return [...history, { from: lastPage, element: null, to: here }];
  return history;
}

/**
 * Elements that shouldn't be suggested again on `here`:
 * - a dead end: clicked from this page, and the person came straight back from the page it
 *   opened (Back, a breadcrumb), so that page didn't have what they needed;
 * - a retreat: clicked from this page, and it led back to a page first visited before this
 *   one, such as a "Cancel" button that cancels the flow rather than the subscription;
 * - a loop: clicked from this page MAX_NO_CHANGE_CLICKS times without the page changing.
 *
 * "Came straight back" matters on long detours. In P → Q → R → P, the click that left P was
 * fine and the one that closed the circle (R → P) was the mistake; holding back the first
 * would block the right path. One click without a change is allowed again, since retrying can
 * be right, and a visible error message changes the headings, which makes it another page.
 */
export function triedWithoutProgress(history: HistoryEdge[], here: PageRef): ElementRef[] {
  const result: ElementRef[] = [];
  const add = (e: ElementRef) => {
    if (!result.some((r) => sameElement(r, e))) result.push(e);
  };
  const order = firstVisitOrder(history);
  history.forEach((edge, i) => {
    if (!edge.element || !samePage(edge.from, here)) return;
    const opened = edge.to;
    if (samePage(opened, here)) {
      const repeats = history.filter((h) => h.element && sameElement(h.element, edge.element!) && samePage(h.from, here) && samePage(h.to, here));
      if (repeats.length >= MAX_NO_CHANGE_CLICKS) add(edge.element);
      return;
    }
    const retreat = order(opened) < order(edge.from);
    // The first move that actually left the opened page (clicks that changed nothing don't count).
    const leftBy = history.slice(i + 1).find((e) => samePage(e.from, opened) && !samePage(e.to, opened));
    if (retreat || (leftBy && samePage(leftBy.to, here))) add(edge.element);
  });
  return result;
}

/** Position of each page's first visit along the path, for telling backward moves from forward ones. */
function firstVisitOrder(history: HistoryEdge[]): (page: PageRef) => number {
  const seen: PageRef[] = [];
  for (const edge of history) {
    for (const page of [edge.from, edge.to]) {
      if (!seen.some((p) => samePage(p, page))) seen.push(page);
    }
  }
  return (page) => seen.findIndex((p) => samePage(p, page));
}

/** Splits the candidates into those Jev may choose from and those held back. Never holds back all of them. */
export function withoutTried(
  candidates: Candidate[],
  history: HistoryEdge[],
  here: PageRef,
): { usable: Candidate[]; skipped: Candidate[] } {
  const tried = triedWithoutProgress(history, here);
  const skipped = candidates.filter((c) => tried.some((t) => sameElement(t, c)));
  if (skipped.length === candidates.length) return { usable: candidates, skipped: [] };
  return { usable: candidates.filter((c) => !skipped.includes(c)), skipped };
}
