import { describe, expect, it } from "vitest";
import { isFromExtensionPage } from "../src/shared/messages";

describe("isFromExtensionPage", () => {
  const base = "chrome-extension://abcdefghijklmnop/";

  it("accepts the options page, even though it opens in a tab", () => {
    expect(isFromExtensionPage(base + "options.html", base)).toBe(true);
  });
  it("accepts the side panel", () => {
    expect(isFromExtensionPage(base + "sidepanel.html", base)).toBe(true);
  });
  it("rejects a content script, whose sender URL is the web page", () => {
    expect(isFromExtensionPage("https://example.com/account", base)).toBe(false);
  });
  it("rejects a page that only mentions the extension URL", () => {
    expect(isFromExtensionPage("https://evil.example/?chrome-extension://abcdefghijklmnop/", base)).toBe(false);
  });
  it("rejects a missing URL", () => {
    expect(isFromExtensionPage(undefined, base)).toBe(false);
  });
});
