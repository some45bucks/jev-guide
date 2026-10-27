// Background service worker. It is the only part of the extension that calls the Jev API.
// Keeping network access here means the API key is read in one place, and content
// scripts, which run inside untrusted pages, never handle it.

import { buildTestRequest, callJev, JevError } from "./shared/jev";
import { isFromExtensionPage, type Message, type TestConnectionReply } from "./shared/messages";
import { originPattern } from "./shared/settings";

// Clicking the toolbar icon opens the side panel. Called at startup, not only on install,
// as the chrome.sidePanel docs recommend.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  // Only the extension's own pages may trigger API calls. Content scripts (added in
  // stage 2) run inside web pages, so their sender URL is the page's, not ours.
  if (sender.id !== chrome.runtime.id || !isFromExtensionPage(sender.url, chrome.runtime.getURL(""))) {
    return false;
  }

  if (message.type === "testConnection") {
    testConnection(message).then(sendResponse);
    return true; // keeps sendResponse valid until the promise resolves
  }
  return false;
});

async function testConnection({ settings }: Extract<Message, { type: "testConnection" }>): Promise<TestConnectionReply> {
  if (!settings.apiKey.trim()) return { ok: false, error: "Enter an API key first." };

  // Without host permission for the API origin, Chrome applies CORS and the call fails
  // with an unhelpful network error. Checking first gives a message the person can act on.
  const pattern = originPattern(settings.baseUrl);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: `The extension doesn't have permission to call ${new URL(settings.baseUrl).origin} yet.` };
  }

  try {
    const result = await callJev(
      { apiKey: settings.apiKey.trim(), baseUrl: settings.baseUrl },
      buildTestRequest(settings.model),
    );
    const answer = result.answers.is_greeting;
    if (answer?.type !== "noul") return { ok: false, error: "The API answered, but without the expected noul answer." };
    return { ok: true, model: result.model, noul: answer.noul, latencyMs: result.latencyMs, inputTokens: result.inputTokens };
  } catch (err) {
    return { ok: false, error: err instanceof JevError ? err.message : `Unexpected error: ${String(err)}` };
  }
}
