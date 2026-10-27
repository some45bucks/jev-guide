import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractCandidates, hrefPath, labelOf, snapshotPage, type Layout } from "../src/content/candidates";

const PAGE_URL = "http://127.0.0.1:8123/index.html";

/**
 * jsdom parses CSS but has no layout engine, so every element reports a 0×0 box. This fake
 * gives every element a box, except those whose inline style sets width: 0px, which stand
 * in for zero-size elements. Computed styles (display, opacity, cursor) come from jsdom.
 */
function fakeLayout(dom: JSDOM): Layout {
  return {
    rectOf: (el) =>
      /width:\s*0px/.test(el.getAttribute("style") ?? "")
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: 10, y: 20, width: 100, height: 24 },
    styleOf: (el) => dom.window.getComputedStyle(el),
  };
}

function scan(html: string, url = PAGE_URL) {
  const dom = new JSDOM(html, { url });
  return { dom, ...extractCandidates(dom.window.document, fakeLayout(dom)) };
}

function fixture(name: string) {
  const html = readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
  return scan(html, `http://127.0.0.1:8123/${name}`);
}

function element(html: string): Element {
  return new JSDOM(`<body>${html}</body>`, { url: PAGE_URL }).window.document.body.firstElementChild!;
}

describe("labelOf", () => {
  it("prefers aria-label over visible text", () => {
    expect(labelOf(element('<a href="/" aria-label="Streamly home">▶ Streamly</a>'))).toBe("Streamly home");
  });
  it("resolves aria-labelledby", () => {
    const dom = new JSDOM('<h2 id="t">Billing</h2><button aria-labelledby="t">›</button>');
    expect(labelOf(dom.window.document.querySelector("button")!)).toBe("Billing");
  });
  it("collapses whitespace in visible text", () => {
    expect(labelOf(element("<button>\n  Save\n   <b>profile</b> </button>"))).toBe("Save profile");
  });
  it("falls back to title, then image alt", () => {
    expect(labelOf(element('<button title="Close"></button>'))).toBe("Close");
    expect(labelOf(element('<a href="/"><img alt="Home" src="x.png"></a>'))).toBe("Home");
  });
  it("reads a submit button's caption from its value attribute", () => {
    expect(labelOf(element('<input type="submit" value="Cancel subscription">'))).toBe("Cancel subscription");
    expect(labelOf(element('<input type="submit">'))).toBe("Submit");
  });
});

describe("hrefPath", () => {
  it("drops the query string and fragment", () => {
    expect(hrefPath(element('<a href="/browse?session=abc123#top">x</a>'), PAGE_URL)).toBe("/browse");
  });
  it("resolves relative links against the page", () => {
    expect(hrefPath(element('<a href="billing.html">x</a>'), "http://127.0.0.1:8123/account.html")).toBe("/billing.html");
  });
  it("keeps the host for links to other sites", () => {
    expect(hrefPath(element('<a href="https://status.example.com/?utm_source=x">x</a>'), PAGE_URL)).toBe(
      "status.example.com/",
    );
  });
  it("returns null for links that aren't web pages", () => {
    expect(hrefPath(element('<a href="javascript:void(0)">x</a>'), PAGE_URL)).toBeNull();
    expect(hrefPath(element('<a href="mailto:alex@example.com">x</a>'), PAGE_URL)).toBeNull();
    expect(hrefPath(element("<button>x</button>"), PAGE_URL)).toBeNull();
  });
});

describe("extractCandidates", () => {
  it("collects every kind of control, in DOM order", () => {
    const { candidates } = scan(`
      <a href="/a">Link</a>
      <button>Button</button>
      <span role="menuitem">Menu item</span>
      <div role="tab">Tab</div>
      <details><summary>Summary</summary></details>
      <input type="submit" value="Submit form">
      <input type="image" alt="Image button" src="x.png">
    `);
    expect(candidates.map((c) => [c.id, c.role, c.label])).toEqual([
      ["e1", "link", "Link"],
      ["e2", "button", "Button"],
      ["e3", "menuitem", "Menu item"],
      ["e4", "tab", "Tab"],
      ["e5", "summary", "Summary"],
      ["e6", "button", "Submit form"],
      ["e7", "button", "Image button"],
    ]);
  });

  it("returns each candidate's element at the same index", () => {
    const { candidates, elements } = scan('<a href="/a">A</a><button>B</button>');
    expect(elements.map((el) => el.textContent)).toEqual(candidates.map((c) => c.label));
  });

  it("counts a nested control once, as the outer one", () => {
    const { candidates } = scan('<a href="/go"><button><span>Go</span></button></a>');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ role: "link", label: "Go", href: "/go" });
  });

  it("merges repeated controls with the same role, label and link", () => {
    const { candidates } = scan('<a href="/account">Account</a><p>…</p><a href="/account">Account</a>');
    expect(candidates).toHaveLength(1);
  });

  it("keeps generic elements only when they look clickable and have a short label", () => {
    const { candidates } = scan(`
      <div onclick="play()">Play episode</div>
      <span tabindex="0">Focusable</span>
      <span style="cursor: pointer">Pointer</span>
      <div style="cursor: pointer"><span>Inner text</span></div>
      <div>Plain text</div>
      <span tabindex="-1">Not focusable</span>
      <div onclick="x()">${"Long paragraph text ".repeat(10)}</div>
      <div onclick="x()"><a href="/real">Real link</a></div>
    `);
    expect(candidates.map((c) => c.label)).toEqual(["Play episode", "Focusable", "Pointer", "Inner text", "Real link"]);
    expect(candidates[0]?.role).toBe("clickable");
  });

  it("skips hidden, zero-size and disabled controls", () => {
    const { candidates } = fixture("index.html");
    const labels = candidates.map((c) => c.label);
    for (const skipped of [
      "Hidden link",
      "Link inside a closed menu",
      "Invisible link",
      "Fully transparent link",
      "Zero-size link",
      "Upgrade (unavailable)",
      "Gift a subscription (unavailable)",
      "Decorative link",
    ]) {
      expect(labels).not.toContain(skipped);
    }
  });

  it("skips links inside a closed <details>, but keeps them once it's open", () => {
    const html = '<details><summary>More</summary><a href="/all">See everything</a></details>';
    expect(scan(html).candidates.map((c) => c.label)).toEqual(["More"]);
    expect(scan(html.replace("<details>", "<details open>")).candidates.map((c) => c.label)).toEqual([
      "More",
      "See everything",
    ]);
  });

  it("finds the expected controls on the fixture home page", () => {
    const { candidates } = fixture("index.html");
    expect(candidates.map((c) => [c.label, c.href])).toEqual([
      ["Streamly home", "/index.html"],
      ["Browse", "/browse.html"],
      ["Pricing", "/pricing.html"],
      ["Account", "/account.html"],
      ["The Long Road · Episode 4", null],
      ["Night Shift · Episode 2", "/watch.html"],
      ["More recommendations", null],
      ["Help", "/help.html"],
      ["Service status", "status.example.com/"],
      ["English ▾", null],
    ]);
  });

  it("finds the cancel link on the billing page and the final button on the cancel page", () => {
    expect(fixture("billing.html").candidates).toContainEqual(
      expect.objectContaining({ role: "link", label: "Cancel subscription", href: "/cancel.html" }),
    );
    expect(fixture("cancel.html").candidates).toContainEqual(
      expect.objectContaining({ role: "button", label: "Cancel subscription", href: null }),
    );
  });

  it("never includes text fields, password fields or anything typed into them", () => {
    const { dom, candidates } = fixture("account.html");
    // Simulate typing, which sets the value property without touching the attribute.
    const doc = dom.window.document;
    doc.querySelector<HTMLInputElement>('input[name="new"]')!.value = "typed-new-password";
    const again = extractCandidates(doc, fakeLayout(dom)).candidates;

    for (const result of [candidates, again]) {
      const json = JSON.stringify(result);
      expect(json).not.toContain("hunter2-secret");
      expect(json).not.toContain("typed-new-password");
      expect(json).not.toContain("Alex Example");
      expect(json).not.toContain("alex@example.com");
    }
    expect(candidates.map((c) => c.label)).toEqual([
      "Streamly home",
      "Browse",
      "Pricing",
      "Account",
      "Profile",
      "Billing",
      "Security",
      "Save profile",
      "Update password",
      "Delete account",
      "Help",
    ]);
  });

  it("truncates long labels of real controls", () => {
    const { candidates } = scan(`<a href="/x">${"word ".repeat(40)}</a>`);
    expect(candidates[0]?.label).toHaveLength(80);
    expect(candidates[0]?.label.endsWith("…")).toBe(true);
  });
});

describe("snapshotPage", () => {
  it("adds the title, path without query, and visible headings", () => {
    const dom = new JSDOM(
      `<title>Streamly – Billing</title>
       <h1>Account</h1><h2 style="display: none">Hidden heading</h2><h2>Your plan</h2><h4>Too deep</h4>
       <a href="/cancel.html">Cancel subscription</a>`,
      { url: "http://127.0.0.1:8123/billing.html?session=abc" },
    );
    const { page, elements } = snapshotPage(dom.window.document, fakeLayout(dom));
    expect(page).toMatchObject({ title: "Streamly – Billing", path: "/billing.html", headings: ["Account", "Your plan"] });
    expect(page.candidates).toHaveLength(1);
    expect(elements).toHaveLength(1);
  });
});
