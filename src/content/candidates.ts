// Finds the elements a person could click to move toward a goal, and describes each one
// with a short label for Jev. It runs inside the web page, but takes the document and the
// layout functions as parameters so it can be unit-tested in jsdom, which has no layout.
//
// Privacy rules enforced here: input values are never read (only the caption attribute of
// submit buttons), text-entry fields are never candidates, and link query strings and
// fragments are dropped because they often carry tokens or personal data.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Candidate {
  /** "e1", "e2", … in DOM order. Becomes the Choice option key in stage 3. */
  id: string;
  role: string;
  label: string;
  /** Link target without query string or fragment; includes the host only when cross-origin. */
  href: string | null;
  /** Viewport coordinates, for badges now and screenshot rectangles in stage 5. */
  rect: Rect;
}

/** What Jev sees of a page: a little context plus the candidate table. */
export interface PageSnapshot {
  title: string;
  /** location.pathname only: the query string can carry tokens or personal data. */
  path: string;
  /** Visible h1–h3 headings, which say where on the site the person is. */
  headings: string[];
  candidates: Candidate[];
}

export interface Layout {
  rectOf(el: Element): Rect;
  styleOf(el: Element): Pick<CSSStyleDeclaration, "display" | "visibility" | "opacity" | "cursor">;
}

export const browserLayout: Layout = {
  rectOf: (el) => el.getBoundingClientRect(),
  styleOf: (el) => getComputedStyle(el),
};

/** Elements that are clickable by their HTML or ARIA semantics. */
const SEMANTIC = [
  "a[href]",
  "button",
  "summary",
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="image"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
].join(", ");

/** Elements that scripts often make clickable (a React onClick on a div). Kept only with a click signal. */
const GENERIC = "div, span, li, img";

const MAX_LABEL = 80;
/** Enough headings to place the page without sending its whole outline. */
const MAX_HEADINGS = 8;

function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** innerText skips hidden text, but jsdom doesn't implement it, so tests fall back to textContent. */
function visibleText(el: Element): string {
  return collapse((el as HTMLElement).innerText ?? el.textContent);
}

function labelledByText(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  return collapse(ids.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" "));
}

/**
 * Caption of an input button. Reads the value *attribute*, which the page author wrote as
 * the button's caption, never the value *property*, which for text fields holds what the
 * person typed.
 */
function inputCaption(el: Element): string {
  if (el.tagName !== "INPUT") return "";
  const type = el.getAttribute("type");
  if (type === "image") return collapse(el.getAttribute("alt"));
  if (type === "submit") return collapse(el.getAttribute("value")) || "Submit";
  if (type === "button") return collapse(el.getAttribute("value"));
  return "";
}

/** Fallback for icon-only links and buttons. */
function imageText(el: Element): string {
  if (el.tagName === "IMG") return collapse(el.getAttribute("alt"));
  return collapse(el.querySelector("img[alt]")?.getAttribute("alt") ?? el.querySelector("svg title")?.textContent);
}

/** The full label, untruncated. Explicit accessible names win over visible text, as in screen readers. */
export function labelOf(el: Element): string {
  return (
    collapse(el.getAttribute("aria-label")) ||
    labelledByText(el) ||
    inputCaption(el) ||
    visibleText(el) ||
    collapse(el.getAttribute("title")) ||
    imageText(el)
  );
}

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  switch (el.tagName) {
    case "A":
      return "link";
    case "BUTTON":
    case "INPUT":
      return "button";
    case "SUMMARY":
      return "summary";
    default:
      return "clickable";
  }
}

/** Where a link goes, as a path. Null for non-web links (javascript:, mailto:) and non-links. */
export function hrefPath(el: Element, pageUrl: string): string | null {
  const raw = el.getAttribute("href");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  let sameOrigin = false;
  try {
    sameOrigin = url.origin === new URL(pageUrl).origin;
  } catch {
    // pageUrl isn't a web URL (about:blank); treat every link as cross-origin.
  }
  return sameOrigin ? url.pathname : url.host + url.pathname;
}

/** Text-entry fields are never candidates, so their contents can't leak into a label. */
function isTextEntry(el: Element): boolean {
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return !["submit", "button", "image"].includes(el.getAttribute("type") ?? "");
  return (el as HTMLElement).isContentEditable === true;
}

function isDisabled(el: Element): boolean {
  return el.matches(":disabled") || el.closest('[aria-disabled="true"]') !== null;
}

function isHidden(el: Element, layout: Layout): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
  // Content of a closed <details>. Chrome hides it with content-visibility, which keeps a
  // non-zero box, so the size check below doesn't catch it.
  if (el.closest("details:not([open]) > :not(summary)")) return true;
  const rect = layout.rectOf(el);
  if (rect.width === 0 || rect.height === 0) return true;
  // visibility is inherited and a child can override it, so the element's own value is enough.
  // display and opacity are not inherited, so every ancestor has to be checked.
  if (layout.styleOf(el).visibility !== "visible") return true;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = layout.styleOf(node);
    if (style.display === "none" || style.opacity === "0") return true;
  }
  return false;
}

/** A click signal on a generic element: an onclick attribute, keyboard focusability, or a pointer cursor. */
function looksClickable(el: Element, layout: Layout): boolean {
  if (el.hasAttribute("onclick")) return true;
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  // cursor is inherited, so only the element where the pointer cursor starts counts.
  const parent = el.parentElement;
  return layout.styleOf(el).cursor === "pointer" && (!parent || layout.styleOf(parent).cursor !== "pointer");
}

function truncate(text: string): string {
  return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + "…" : text;
}

export interface Extraction {
  candidates: Candidate[];
  /** elements[i] is the element for candidates[i]. Kept separate because elements can't be sent in messages. */
  elements: Element[];
}

export function extractCandidates(doc: Document, layout: Layout = browserLayout): Extraction {
  const candidates: Candidate[] = [];
  const elements: Element[] = [];
  const seen = new Set<string>();
  let lastControl: Element | null = null;

  // querySelectorAll returns elements in document order, which we keep: it roughly matches
  // reading order, and Jev slightly favors earlier options, so the order should be neutral.
  for (const el of doc.querySelectorAll(`${SEMANTIC}, ${GENERIC}`)) {
    // Part of a control already handled, such as the <span> in <button><span>Save</span></button>,
    // even if that control was skipped as disabled or duplicate. In document order a subtree
    // comes right after its root, so checking only the most recent control is enough.
    if (lastControl?.contains(el)) continue;

    const semantic = el.matches(SEMANTIC);
    if (semantic) {
      lastControl = el;
    } else {
      if (!looksClickable(el, layout)) continue;
      // A clickable card that wraps a real link: keep the link instead.
      if (el.querySelector(SEMANTIC)) continue;
    }
    if (isTextEntry(el) || isDisabled(el) || isHidden(el, layout)) continue;

    const fullLabel = labelOf(el);
    // A generic element with a long label is usually a container, not a control.
    if (!semantic && (fullLabel === "" || fullLabel.length > MAX_LABEL)) continue;
    const label = truncate(fullLabel);
    const href = hrefPath(el, doc.URL);
    // Jev can't reason about an element with neither a label nor a destination.
    if (!label && !href) continue;

    const role = roleOf(el);
    // The same control repeated (header and footer "Account" links) is one option for Jev.
    const key = `${role}|${label}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { x, y, width, height } = layout.rectOf(el);
    candidates.push({ id: `e${candidates.length + 1}`, role, label, href, rect: { x, y, width, height } });
    elements.push(el);
    lastControl = el;
  }
  return { candidates, elements };
}

export function extractHeadings(doc: Document, layout: Layout = browserLayout): string[] {
  const headings: string[] = [];
  for (const el of doc.querySelectorAll("h1, h2, h3")) {
    if (headings.length === MAX_HEADINGS) break;
    if (isHidden(el, layout)) continue;
    const text = truncate(visibleText(el));
    if (text) headings.push(text);
  }
  return headings;
}

/** Everything one suggestion needs from the page, plus the elements for highlighting. */
export function snapshotPage(doc: Document, layout: Layout = browserLayout): { page: PageSnapshot; elements: Element[] } {
  const { candidates, elements } = extractCandidates(doc, layout);
  const page: PageSnapshot = {
    title: truncate(collapse(doc.title)),
    path: new URL(doc.URL).pathname,
    headings: extractHeadings(doc, layout),
    candidates,
  };
  return { page, elements };
}
