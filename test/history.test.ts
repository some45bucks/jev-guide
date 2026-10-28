import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/content/candidates";
import {
  edgeText,
  type ElementRef,
  type HistoryEdge,
  MAX_NO_CHANGE_CLICKS,
  type PageRef,
  recordArrival,
  triedWithoutProgress,
  withoutTried,
} from "../src/shared/history";

const home: PageRef = { path: "/", title: "Shopmart", headings: ["Deals of the day"] };
const account: PageRef = { path: "/account", title: "Your account", headings: ["Profile", "Addresses"] };
const settings: PageRef = { path: "/settings", title: "Settings", headings: ["Language"] };
const accountLink: ElementRef = { role: "link", label: "Account", href: "/account" };
const settingsLink: ElementRef = { role: "link", label: "Settings", href: "/settings" };
const helpLink: ElementRef = { role: "link", label: "Help", href: "/help" };

const click = (from: PageRef, element: ElementRef, to: PageRef): HistoryEdge => ({ from, element, to });
const back = (from: PageRef, to: PageRef): HistoryEdge => ({ from, element: null, to });

function candidates(...refs: ElementRef[]): Candidate[] {
  return refs.map((r, i) => ({ id: `e${i + 1}`, ...r, rect: { x: 0, y: 0, width: 1, height: 1 } }));
}

describe("recordArrival", () => {
  it("records nothing for the first page", () => {
    expect(recordArrival([], null, null, home)).toEqual([]);
  });
  it("records the pending click as an edge", () => {
    expect(recordArrival([], home, accountLink, account)).toEqual([click(home, accountLink, account)]);
  });
  it("records a move without a click (Back, a typed URL) when the page changed", () => {
    expect(recordArrival([], account, null, home)).toEqual([back(account, home)]);
  });
  it("records nothing when there was no click and the page is the same", () => {
    expect(recordArrival([], home, null, { ...home })).toEqual([]);
  });
  it("treats the same path with different headings as a different page", () => {
    const step3 = { ...home, headings: ["Step 3 of 3"] };
    expect(recordArrival([], home, null, step3)).toHaveLength(1);
  });
  it("returns a new array, so a stale step can drop it", () => {
    const history: HistoryEdge[] = [];
    expect(recordArrival(history, home, accountLink, account)).not.toBe(history);
    expect(history).toHaveLength(0);
  });
});

describe("edgeText", () => {
  it("describes a click and where it led", () => {
    expect(edgeText(click(home, accountLink, account))).toBe("on /: clicked link: Account → /account ⇒ reached /account (Your account)");
  });
  it("says when the page didn't change", () => {
    expect(edgeText(click(home, accountLink, home))).toBe("on /: clicked link: Account → /account ⇒ the page didn't change");
  });
  it("describes a move without a click", () => {
    expect(edgeText(back(account, home))).toBe("on /account: navigated ⇒ reached / (Shopmart)");
  });
});

describe("triedWithoutProgress", () => {
  it("holds back a click the person came back from", () => {
    const history = [click(home, accountLink, account), back(account, home)];
    expect(triedWithoutProgress(history, home)).toEqual([accountLink]);
  });

  it("holds back every dead end, not only the latest", () => {
    const history = [click(home, accountLink, account), back(account, home), click(home, settingsLink, settings), back(settings, home)];
    expect(triedWithoutProgress(history, home)).toEqual([accountLink, settingsLink]);
  });

  it("holds back a click that led back to a page visited earlier, like a Cancel that cancels the flow", () => {
    const plus: PageRef = { path: "/plus", title: "Plus", headings: ["Plus"] };
    const end1: PageRef = { path: "/end-1", title: "Before you go", headings: ["Before you go"] };
    const end2: PageRef = { path: "/end-2", title: "Pause instead?", headings: ["Pause instead?"] };
    const endLink: ElementRef = { role: "link", label: "End membership", href: "/end-1" };
    const continueLink: ElementRef = { role: "link", label: "Continue to cancel", href: "/end-2" };
    const cancelFlow: ElementRef = { role: "link", label: "Cancel", href: "/plus" };
    const history = [click(plus, endLink, end1), click(end1, continueLink, end2), click(end2, cancelFlow, plus), click(plus, endLink, end1), click(end1, continueLink, end2)];
    expect(triedWithoutProgress(history, end2)).toEqual([cancelFlow]);
    // The long way round doesn't make the right links look like dead ends.
    expect(triedWithoutProgress(history, plus)).toEqual([]);
    expect(triedWithoutProgress(history, end1)).toEqual([]);
  });

  it("doesn't hold back a click on the way forward", () => {
    expect(triedWithoutProgress([click(home, accountLink, account)], account)).toEqual([]);
    expect(triedWithoutProgress([click(home, accountLink, account)], home)).toEqual([]);
  });

  it("allows one retry of a click that didn't change the page, then holds it back", () => {
    const once = [click(home, helpLink, home)];
    expect(triedWithoutProgress(once, home)).toEqual([]);
    const repeated = Array.from({ length: MAX_NO_CHANGE_CLICKS }, () => click(home, helpLink, home));
    expect(triedWithoutProgress(repeated, home)).toEqual([helpLink]);
  });

  it("doesn't count a click that changed the page in place, such as one showing an error", () => {
    const withError = { ...home, headings: ["Something went wrong. Please try again."] };
    expect(triedWithoutProgress([click(home, helpLink, withError), click(home, helpLink, withError)], home)).toEqual([]);
  });
});

describe("withoutTried", () => {
  it("splits candidates into usable and skipped", () => {
    const all = candidates(accountLink, settingsLink, helpLink);
    const { usable, skipped } = withoutTried(all, [click(home, accountLink, account), back(account, home)], home);
    expect(usable.map((c) => c.label)).toEqual(["Settings", "Help"]);
    expect(skipped.map((c) => c.label)).toEqual(["Account"]);
  });

  it("never leaves Jev with nothing to choose from", () => {
    const all = candidates(accountLink);
    const { usable, skipped } = withoutTried(all, [click(home, accountLink, account), back(account, home)], home);
    expect(usable).toEqual(all);
    expect(skipped).toEqual([]);
  });
});
