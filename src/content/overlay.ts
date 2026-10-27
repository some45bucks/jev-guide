// Draws outlines with a small tag on page elements: numbered debug badges, and the
// "Click here" suggestion. Each layer lives in its own shadow root, so the page's CSS can't
// restyle it and ours can't leak into the page, and it ignores the pointer so it never gets
// in the way of the person's clicks. Nothing here clicks, types or changes the page's own DOM.

export type Layer = "badges" | "suggestion";

/**
 * debug: numbered badge. main: the suggested element. alt: one of the top 3 when unsure.
 */
export type Tone = "debug" | "main" | "alt";

export interface Mark {
  element: Element;
  text: string;
  tone: Tone;
}

const STYLE = `
  .box {
    position: absolute;
    left: 0;
    top: 0;
    box-sizing: border-box;
    border-radius: 4px;
  }
  .tag {
    position: absolute;
    white-space: nowrap;
    color: #fff;
    border-radius: 3px;
  }

  .debug { outline: 2px solid #d9480f; }
  .debug .tag {
    /* Left of the element, on its own row, so it never covers a neighbor's text. */
    right: calc(100% + 3px);
    top: -2px;
    padding: 0 4px;
    background: #d9480f;
    font: 600 11px/16px ui-monospace, Menlo, Consolas, monospace;
  }
  /* At the window's left edge there's no room outside, so the tag covers the element's own corner. */
  .debug.edge .tag { right: auto; left: 0; top: 0; }

  .main { outline: 3px solid #1f6feb; box-shadow: 0 0 0 6px rgba(31, 111, 235, 0.25); }
  .alt { outline: 2px dashed #9a6700; }
  .main .tag, .alt .tag {
    /* Above the element; below it when the element is at the top of the window. */
    left: -3px;
    bottom: calc(100% + 6px);
    padding: 2px 8px;
    font: 600 13px/18px system-ui, sans-serif;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  .main .tag { background: #1f6feb; }
  .alt .tag { background: #9a6700; }
  .main.edge .tag, .alt.edge .tag { bottom: auto; top: calc(100% + 6px); }
`;

// Room a tag needs outside its element before it moves to the other side.
const EDGE = { debug: 32, main: 30, alt: 30 } as const;

const stopTracking = new Map<Layer, () => void>();

// Fixed ids let a fresh copy of the content script remove an overlay left behind by an
// old copy (after the extension reloads, the old script can no longer be reached).
function hostId(layer: Layer): string {
  return `jev-guide-${layer}`;
}

export function clearLayer(layer: Layer): void {
  stopTracking.get(layer)?.();
  stopTracking.delete(layer);
  document.getElementById(hostId(layer))?.remove();
}

export function showLayer(layer: Layer, marks: Mark[]): void {
  clearLayer(layer);

  const host = document.createElement("div");
  host.id = hostId(layer);
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

  const boxes = marks.map(({ element, text, tone }) => {
    const box = document.createElement("div");
    box.className = `box ${tone}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = text;
    box.append(tag);
    root.append(box);
    return { box, element, tone };
  });

  // Positions come from getBoundingClientRect, so they follow page scrolling, scrolling
  // inside panels (scroll events are captured from every element), and window resizes.
  function place(): void {
    for (const { box, element, tone } of boxes) {
      const r = element.getBoundingClientRect();
      box.style.transform = `translate(${r.x}px, ${r.y}px)`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      box.classList.toggle("edge", (tone === "debug" ? r.x : r.y) < EDGE[tone]);
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
  stopTracking.set(layer, () => {
    cancelAnimationFrame(frame);
    removeEventListener("scroll", schedule, { capture: true });
    removeEventListener("resize", schedule);
  });

  place();
  document.documentElement.append(host);
}
