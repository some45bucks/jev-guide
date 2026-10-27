# Jev Guide

A Chrome extension that helps you reach a goal on a website, such as "cancel my subscription" or
"change my password". You type the goal, and Jev Guide highlights the next button or link to click.
**You always do the clicking**: the extension never clicks, types, or submits anything itself.

Decisions come from Jev, TypeSafe AI's System One model, which answers typed questions (choice,
yes/no, score) about a state instead of generating text.

> Status: stage 1 of 7 (skeleton: manifest, options page, connection test).

## Build and load

Requires Node.js 20 or newer and Chrome 116 or newer.

```sh
npm install
npm run build     # type-checks, then bundles into dist/
npm test          # unit tests (Vitest)
```

Load it in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `dist/` folder.
3. Pin Jev Guide from the puzzle-piece menu, then click its icon to open the side panel.
4. Click **Settings**, paste your API key, and click **Test connection**.

After changing code, run `npm run build` again and click the reload icon on the extension's card in
`chrome://extensions`. `npm run watch` rebuilds on every save. You still reload the extension yourself.

## Permissions

| Permission | Why it's needed |
|---|---|
| `storage` | Saves the API key, base URL and model (and, in later stages, the session and benchmark log) in `chrome.storage.local`. |
| `sidePanel` | The main UI. A popup would close as soon as you click the page, which is exactly when you need the suggestion. |
| `activeTab` | Temporary access to the current tab when you click the toolbar icon, so the extension can read it without asking for access to every site at install. |
| `scripting` | Injects the content script on demand with `chrome.scripting.executeScript`, instead of running it on every site you visit. |
| `tabs` | Reads the URL and title of the tab being guided, and notices when it navigates. |
| `https://api.typesafe.ai/*` | Lets the background worker call the Jev API. Without host permission, Chrome applies CORS to the request. |
| Optional: `https://*/*`, `http://localhost/*` | Never granted at install. If you set a different base URL (OpenRouter or a local proxy), the options page asks for that one origin only. |

## API key storage (prototype only)

The key is stored in `chrome.storage.local` in your browser profile. Local, not sync, so it isn't
copied to other computers through your Google account. Only the background service worker reads it,
and the content script that runs inside web pages never sees it.

Anyone who installs an extension can read the keys it contains, so a production version would not
ship a key. The extension would call a small backend that holds the key, authenticates the user, and
forwards requests to Jev. The base URL setting already allows that: point it at the backend
(`http://localhost` is accepted for local development).

## Project layout

```
static/              manifest.json, HTML and CSS, copied into dist/ as-is
src/background.ts    service worker: the only code that calls the Jev API
src/options.ts       settings page and connection test
src/sidepanel.ts     side panel (status only in stage 1)
src/shared/jev.ts    API types, response parser and fetch wrapper (pure, unit-tested)
src/shared/settings.ts  settings storage and base-URL validation
src/shared/messages.ts  message types between pages and the background worker
test/                Vitest unit tests
build.mjs            esbuild script behind `npm run build`
```
