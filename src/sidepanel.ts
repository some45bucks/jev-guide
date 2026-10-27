// Side panel. In stage 1 it only shows whether the extension is set up; the goal input,
// suggestions and recorded steps arrive in later stages.

import { loadSettings, TYPESAFE_BASE_URL } from "./shared/settings";

const setup = document.querySelector<HTMLParagraphElement>("#setup")!;
const openOptions = document.querySelector<HTMLButtonElement>("#open-options")!;

async function render(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    setup.textContent = "Add your Jev API key in Settings to get started.";
    setup.dataset.kind = "error";
    return;
  }
  const where = settings.baseUrl === TYPESAFE_BASE_URL ? "TypeSafe" : new URL(settings.baseUrl).host;
  setup.textContent = `Ready: ${settings.model} via ${where}.`;
  setup.dataset.kind = "ok";
}

openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Re-render when settings are saved, so the panel doesn't need reopening.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") render();
});

render();
