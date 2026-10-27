// Debug overlay: an outline and a number on each candidate, matching the side panel's table.
// It lives in a shadow root so the page's CSS can't restyle it and ours can't leak into the
// page, and it ignores the pointer so it never gets in the way of the person's clicks.

// A fixed id lets a fresh copy of the content script remove an overlay left behind by an
// old copy (after the extension reloads, the old script can no longer be reached).
const HOST_ID = "jev-guide-badges";

const STYLE = `
  .box {
    position: absolute;
    left: 0;
    top: 0;
    box-sizing: border-box;
    outline: 2px solid #d9480f;
    border-radius: 3px;
  }
  /* Left of the element, on its own row, so it never covers a neighbor's text. */
  .tag {
    position: absolute;
    right: calc(100% + 3px);
    top: -2px;
    padding: 0 4px;
    border-radius: 3px;
    background: #d9480f;
    color: #fff;
    font: 600 11px/16px ui-monospace, Menlo, Consolas, monospace;
  }
  /* At the window's left edge there's no room outside, so the tag covers the element's own corner. */
  .box.edge .tag {
    right: auto;
    left: 0;
    top: 0;
  }
`;

// Wide enough for a three-digit tag plus its gap.
const TAG_ROOM = 32;

let stopTracking: (() => void) | null = null;

export function hideBadges(): void {
  stopTracking?.();
  stopTracking = null;
  document.getElementById(HOST_ID)?.remove();
}

export function showBadges(items: { number: number; element: Element }[]): void {
  hideBadges();

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Inline !important beats any page rule that targets div or #id.
  for (const [prop, value] of Object.entries({
    position: "fixed",
    inset: "0",
    "pointer-events": "none",
    "z-index": "2147483647",
    overflow: "hidden",
  })) {
    host.style.setProperty(prop, value, "important");
  }
  // Closed, so page scripts can't reach in through host.shadowRoot.
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);

  const boxes = items.map(({ number, element }) => {
    const box = document.createElement("div");
    box.className = "box";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = String(number);
    box.append(tag);
    root.append(box);
    return { box, element };
  });

  // Positions come from getBoundingClientRect, so they follow page scrolling, scrolling
  // inside panels (scroll events are captured from every element), and window resizes.
  function place(): void {
    for (const { box, element } of boxes) {
      const r = element.getBoundingClientRect();
      box.style.transform = `translate(${r.x}px, ${r.y}px)`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      box.classList.toggle("edge", r.x < TAG_ROOM);
    }
  }
  let frame = 0;
  function schedule(): void {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  }
  addEventListener("scroll", schedule, { capture: true, passive: true });
  addEventListener("resize", schedule);
  stopTracking = () => {
    cancelAnimationFrame(frame);
    removeEventListener("scroll", schedule, { capture: true });
    removeEventListener("resize", schedule);
  };

  place();
  document.documentElement.append(host);
}
