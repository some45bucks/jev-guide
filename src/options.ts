// Options page: API key, base URL and model, plus a button that tests them.

import type { Message, TestConnectionReply } from "./shared/messages";
import { loadSettings, normalizeBaseUrl, originPattern, saveSettings, type Settings } from "./shared/settings";

const form = document.querySelector<HTMLFormElement>("#settings")!;
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key")!;
const baseUrlInput = document.querySelector<HTMLInputElement>("#base-url")!;
const modelInput = document.querySelector<HTMLInputElement>("#model")!;
const testButton = document.querySelector<HTMLButtonElement>("#test")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

function showStatus(text: string, kind: "ok" | "error" | "info"): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

/** Reads the form. Throws with a readable message if the base URL is unusable. */
function readForm(): Settings {
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  baseUrlInput.value = baseUrl;
  return { apiKey: apiKeyInput.value.trim(), baseUrl, model: modelInput.value.trim() || "jev-latest" };
}

/**
 * Asks Chrome for access to the API's origin. The TypeSafe origin is granted at install;
 * any other base URL (OpenRouter, a local proxy) is requested only when someone sets it,
 * so the extension never holds broad host access up front.
 *
 * This must be the first await in a click handler: Chrome only shows the permission
 * prompt while the click still counts as a user gesture.
 */
async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [originPattern(baseUrl)] });
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  apiKeyInput.value = settings.apiKey;
  baseUrlInput.value = settings.baseUrl;
  modelInput.value = settings.model;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  let settings: Settings;
  try {
    settings = readForm();
  } catch (err) {
    return showStatus((err as Error).message, "error");
  }
  if (!(await ensureHostPermission(settings.baseUrl))) {
    return showStatus("Not saved: Chrome permission to call that URL was declined.", "error");
  }
  await saveSettings(settings);
  showStatus("Saved.", "ok");
});

// Tests the values in the form, saved or not, so a key can be checked before saving it.
testButton.addEventListener("click", async () => {
  let settings: Settings;
  try {
    settings = readForm();
  } catch (err) {
    return showStatus((err as Error).message, "error");
  }
  if (!(await ensureHostPermission(settings.baseUrl))) {
    return showStatus("Chrome permission to call that URL was declined.", "error");
  }
  testButton.disabled = true;
  showStatus("Sending a test request…", "info");
  const message: Message = { type: "testConnection", settings };
  let reply: TestConnectionReply | undefined;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch (err) {
    // Without this, a failed message leaves the page stuck on "Sending…" with no clue why.
    return showStatus(`The background worker didn't respond: ${(err as Error).message}`, "error");
  } finally {
    testButton.disabled = false;
  }
  if (!reply) {
    showStatus("The background worker didn't respond. Reload the extension in chrome://extensions.", "error");
  } else if (reply.ok) {
    const tokens = reply.inputTokens === null ? "" : `, ${reply.inputTokens} input tokens`;
    showStatus(
      `Connected. ${reply.model} answered in ${reply.latencyMs} ms (greeting probability ${reply.noul.toFixed(2)}${tokens}).`,
      "ok",
    );
  } else {
    showStatus(reply.error, "error");
  }
});

init();
