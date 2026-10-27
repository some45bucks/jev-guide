import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForQuiet } from "../src/content/settle";

describe("waitForQuiet", () => {
  // jsdom's MutationObserver is real; only the timers are faked.
  const dom = new JSDOM("<body><main></main></body>");
  const doc = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function track(promise: Promise<void>) {
    const state = { done: false };
    promise.then(() => (state.done = true));
    return state;
  }

  it("resolves after the quiet period when nothing changes", async () => {
    const state = track(waitForQuiet(doc, 500, 4000));
    await vi.advanceTimersByTimeAsync(499);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
  });

  it("restarts the quiet period on every DOM change", async () => {
    const state = track(waitForQuiet(doc, 500, 4000));
    await vi.advanceTimersByTimeAsync(400);
    doc.querySelector("main")!.append(doc.createElement("p"));
    await vi.advanceTimersByTimeAsync(400);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.done).toBe(true);
  });

  it("gives up waiting on pages that never go quiet", async () => {
    const state = track(waitForQuiet(doc, 500, 2000));
    const ticker = setInterval(() => doc.querySelector("main")!.setAttribute("data-t", String(Date.now())), 100);
    await vi.advanceTimersByTimeAsync(1999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    clearInterval(ticker);
  });
});
