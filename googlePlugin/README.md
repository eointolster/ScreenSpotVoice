# ScreenSpot Voice

ScreenSpot Voice is a local Chrome Manifest V3 experiment for one explicitly shared website tab at a time. It streams **microphone audio and captured tab video over one WebRTC peer connection** to a loopback Python backend. With a configured API key, the backend maintains a Gemini Live speech-to-speech session, returns Gemini audio over WebRTC, and asks the extension to draw an approximate rectangle on the original webpage. The assistant never clicks, types, scrolls, or submits anything.

This is an independent interview experiment, not a claim about any employer's architecture.

## Requirements and installation

- Google Chrome **142 or later** (the panel-close event used to stop capture was added in 142).
- Node.js 22, npm, Python 3.12, and a local microphone.
- A Gemini API key for the live voice path. **Do not put the key in Chrome or in the extension.**

From this directory:

```bash
npm ci
npm run build
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
cp .env.example .env
```

Edit only `googlePlugin/.env` and set `GEMINI_API_KEY`. The default `GEMINI_LIVE_MODEL` is `gemini-2.5-flash-native-audio-preview-12-2025`, which Google's [model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025) lists with Live API, audio/video input, audio output, and function calling. This is a preview model; verify availability for your account. You can change the ID in `.env`; the app does **not** silently substitute another model. `BACKEND_HOST` must remain `127.0.0.1`. `BACKEND_PORT` defaults to `8766`; set the same port in the side panel. `GEMINI_IMAGE_FPS` defaults to 0.8 and must be at most 1. The direct dependencies are pinned in `requirements.txt` and `package.json`; `requirements.lock.txt` and `package-lock.json` lock transitive versions.

Start the backend in a terminal:

```bash
./start-backend.sh
```

It prints a fresh **pairing code** on each run. Enter that code in the side panel; it is not the Gemini key. The backend starts without a Gemini key in **calibration mode**, allowing local overlay checks and, if tab capture works, WebRTC transport diagnostics. No live Gemini voice is available without the key. `GET http://127.0.0.1:8766/health` reports local readiness and mode; this endpoint cannot start capture or spend the key.

### Load the unpacked extension

1. Open `chrome://extensions` in Chrome 142+.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select **`/home/eoin/Project3ExperimentTools/webrtcTesting/googlePlugin/dist`**. Select `dist`, not the project root.
5. Open an ordinary `http://` or `https://` webpage and click the **ScreenSpot Voice toolbar icon**. This grants temporary access to that tab and opens the panel.
6. Enter the backend pairing code and click **Start Session**. On first use, ScreenSpot opens a full extension tab for microphone permission. Click **Allow microphone**, accept Chrome's prompt, then click **Return to webpage**. Click **Start Session** again in the panel (re-enter the pairing code if the panel was closed).

Chrome can dismiss a microphone request made inside a side panel without showing a usable prompt. The dedicated full tab requests permission for the same extension origin and stops its temporary microphone track immediately. It never sends audio to the backend. After permission is granted, the offscreen document opens the microphone only for a started session. If permission was blocked earlier, use **chrome://extensions → ScreenSpot Voice → Details → Site settings → Microphone → Allow**, then retry the setup tab. The code never requests a webcam. See the [Chromium Extensions discussion](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/V09VMCLzvWM) for the side-panel permission behavior.

If Chrome shows **Needs permission** after Start, the panel closes and the toolbar badge says **CLICK**. Click the ScreenSpot toolbar icon again on the **same tab within 30 seconds**. This fallback obtains the tab-capture stream ID directly in the action-click event, which some Chrome configurations require. The extension does not start recording before Start Session. If the second click times out, open the panel and start again.

After source changes, run `npm run build`, click **Reload** on the extension card at `chrome://extensions`, and reload the website before trying again. Reloading replaces Chrome's content-script context.

## First manual test

1. Start the backend and load the extension as above.
2. Open an ordinary supported website and invoke the icon on that tab.
3. Start the session, verify **received audio frames**, **received video frames**, and **return audio bytes** in Diagnostics, then ask aloud: “Where is the upload button?”
4. With a Gemini key, expect a spoken reply and an approximate rectangle on the **webpage**, not in a preview. Click or drag through the outline; it must not intercept input.
5. Speak over a response, then scroll or resize. The old voice should stop and the box should clear. Ask again.
6. Switch tabs: sharing and playback pause. Return to the shared tab and click **Resume shared tab**. To share a different tab, end the old session, invoke the icon on the new tab, and Start there.
7. Click **End Session**. Check Chrome's capture indicator disappears and media counters stop.

For drawing without a key or media, click **Calibrate box** before Start. The fixed sample rectangle is intentionally unrelated to page content and expires after eight seconds. **Clear box** removes it. This separates overlay/coordinate problems from model recognition. The optional `test-page/index.html` includes movable/resizable cards, an upload button, Lucas.jpg, duplicate Export labels, scrolling, and a canvas-drawn target. Serve it with:

```bash
python3 -m http.server 8767 --bind 127.0.0.1 --directory test-page
```

Then visit `http://127.0.0.1:8767`. The grounding implementation has no access to that page's expected answers, coordinates, labels, or DOM.

## Architecture and privacy

```text
toolbar action + side panel  ->  service worker (tab authorization/lifecycle)
                                      |
                                      v
content script (SVG overlay) <- control via worker <- offscreen document
                                      ^                    |
                                      |                    | WebSocket signalling/control
                                      |                    | WebRTC: tab video + microphone out
                                      |                    |         Gemini audio back
                                      |                    v
                              loopback FastAPI + aiortc
                                      |
                                      v
                           persistent google-genai Live session
```

The offscreen document owns tab video, a **separate microphone** track, one WebRTC peer connection, and audio playback. The worker coordinates tab permission and lifecycle; media does not depend on it staying awake. If the worker restarts, it restores non-secret session metadata from the offscreen document. Closing the side panel ends an active call. Switching away from the shared tab replaces outgoing WebRTC tracks with null, pauses playback and Gemini forwarding, and requires explicit Resume. Top-level loading/navigation ends capture. SPA route changes, scroll (including detectable nested scroll), resize, zoom, expiry, new turns, and a conservative visual-change check clear grounding. No other tab is started silently.

A WebSocket is used only for local pairing, SDP/ICE, status, and overlay commands. Media is genuinely sent over WebRTC. The backend resamples microphone audio to 16 kHz mono 16-bit PCM for Live and converts Gemini's 24 kHz mono PCM to a paced aiortc audio track with a bounded eight-second queue and a short jitter buffer. Its latest-frame buffer holds only one JPEG. Gemini video is capped at 1 image/second by the API and 0.8 by default here; local WebRTC receipt is separate. The rectangle uses a closed Shadow DOM SVG root with `pointer-events:none`, transparent fill, and an 8-second lifetime.

Gemini's `highlight_region(label, box_2d)` coordinates are `[ymin,xmin,ymax,xmax]` normalized to 0–1000 against the clean JPEG sent to Gemini. Before JPEG scaling, the backend removes centered Chrome capture bars only when dark padding on both sides or top and bottom is verified against the measured webpage viewport. It never guesses a crop from aspect ratio alone. JPEG scaling then retains the aligned frame aspect ratio. The extension maps normalized coordinates to the current CSS viewport and rejects mismatched aspect ratios, document identity, revision, width, height, device pixel ratio, or visual zoom; it does not blindly multiply by device pixel ratio. Tool results are acknowledged only after the content script confirms rendering. Incoming tool arguments, WebSocket messages, and origins are validated. Gemini never supplies the authorized tab ID or session/source IDs.

To keep our own outline out of model input, an active highlight suspends Gemini image sends while microphone audio continues. A confirmed Gemini interruption or user input transcription first requests a clear acknowledgment, waits 350 ms for page paint and media-pipeline lag, then selects a frame received after that wait. This is a bounded timing approximation, not a precise per-frame capture timestamp. Tool calls are rejected when their image stamp, revision, source, generation, aspect ratio, age, or visual signature no longer matches. The lightweight visual detector ignores the highlighted area so the outline itself does not trip it; movement wholly inside that area may escape detection until expiry or another browser event. If unsure, the app clears rather than claiming an old location. Website text in images is untrusted data, not instructions.

The backend binds **only to loopback**. WebSocket clients must present a `chrome-extension://` origin and the random pairing code. The first successful pairing binds that extension ID for the backend process; set `ALLOWED_EXTENSION_ID` in `.env` after loading if you want to require that ID from startup. No wildcard CORS or unauthenticated capture/spending endpoint is provided. The key stays in the backend's ignored `.env` and is never sent to Chrome. The extension bundle has local scripts and a restrictive MV3 CSP. Transcripts are in memory, with no saved audio, screenshots, transcript history, or screenshot gallery.

**During an active live session, selected-tab images and microphone audio are sent from the local backend to Google for Gemini processing.** This is continuous/live, unlike a click-to-analyse screenshot tool. There is no webcam, system/tab audio, hidden capture of other tabs, or desktop-app capture. End Session stops new uploads, closes tracks/connections, and clears buffers/highlights. Data already submitted to Google cannot necessarily be recalled.

### Manifest permissions

- `activeTab`: temporary grant on toolbar invocation for the selected website.
- `scripting`: inject only our overlay script into that authorized tab.
- `sidePanel`: compact controls.
- `offscreen`: maintain user media, WebRTC and audio playback outside the short-lived worker.
- `tabCapture`: obtain a one-use stream ID for that selected tab's video.
- `http://127.0.0.1/*` host permission and `ws://127.0.0.1:*` CSP connection: local backend pairing/signalling on a configurable loopback port. This does not grant access to every website.

There is no `<all_urls>`, cookies, history, debugger, clipboard, native messaging, or persistent host permission for ordinary websites. Browser-protected pages, built-in PDF views, native dialogs and desktop applications are outside scope. Chrome may display generalized capture/scripting wording in its extension details; inspect `dist/manifest.json` for the actual declared host scope.

## Diagnostics, tests, and limitations

Diagnostics distinguish connection state from received audio/video frames, returned audio bytes, dropped playback blocks, decoded frame and webpage viewport dimensions, the image-send gate, coordinate fit, Gemini image sends, the exact configured model, grounding result, and first Gemini audio **received by the backend** after a local speech-start **estimate**. That is not exact screen-capture time or client playback-start time. Mic echo cancellation and noise suppression are requested from Chrome. Gemini's automatic VAD confirms interruptions and clears old playback; local microphone energy is used only for approximate latency, since speaker echo can otherwise falsely cancel speech. When input transcription arrives for a new request, it clears an old highlight. Capture asks Chrome for at least the webpage viewport size. The backend reports `captureRequestedMinSize`, `captureTrackSize`, `decodedVideoSize`, and `videoMapping` so capture padding can be diagnosed. If aspect ratios still disagree and verified bars cannot be removed, image and microphone forwarding wait for aligned video; boxes remain rejected. Microphone audio resumes only after a current clean image has been sent, so the assistant cannot answer a screen question against a stale or unmappable frame.

Run:

```bash
npm run typecheck
npm run build
npm test
.venv/bin/python -m pytest -q tests
```

The automated tests need no Gemini key. They cover coordinate/box validation, tab lifecycle decisions, stale view and clean-frame gates, visual-change detection, bounded audio cancellation, origin/pairing/message validation, labelled Gemini event mocks, and real aiortc reception of synthetic microphone/video tracks with a return audio stream.

**Verification:** the TypeScript checks, build, and automated tests pass. In a disposable Chrome for Testing profile, the built extension loaded; the side panel and no-key SVG calibration worked on the actual test webpage, an Export button remained clickable through the outline, and scrolling cleared it. That automation profile returned `Requested device not found` when consuming the tab-capture stream ID. A later user-run Chrome session confirmed real microphone/video receipt, Gemini output, clear returned audio, and zero dropped return-audio chunks. Its highlight was rejected because the 3440×1440 decoded video did not match the 1454×1028 webpage viewport. The new capture sizing and verified padding crop pass synthetic geometry tests but still need a live retest for the rectangle.

Google's [Live capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities) documents 16 kHz PCM input, 24 kHz PCM output, video frames at no more than 1 FPS, automatic VAD, interruption events, and a current two-minute audio-plus-video session limit without extension techniques. This app reports session expiry/disconnect and never performs an uncontrolled paid reconnect. The local model-frame association is deliberately conservative because Live tool calls do not carry an application-issued frame ID. Tight pixel-perfect boxes and guaranteed sub-two-second replies are not promised.

## Local model backend (no Gemini key)

`MODEL_BACKEND=local` in `.env` replaces Gemini with a vision+tools model on your own machine, served by [Ollama](https://ollama.com). Chrome transcribes the microphone, the model is asked one question against one clean frame, and the reply is spoken by the browser's own synthesiser. No API key, no quota, and no Gemini session-time limit.

```bash
ollama pull qwen3.8:27b        # any vision+tools model with Ollama works
# .env
MODEL_BACKEND=local
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.8:27b
```

Start the backend as usual. The terminal prints `mode=LOCAL (qwen3.8:27b via …)`; `GET /health` reports `{"mode":"local","model":"local:qwen3.8:27b"}`. Everything else — pairing, overlay, grounding staleness, box validation — is unchanged. Setting `MODEL_BACKEND=gemini` restores the original live path exactly; the Gemini key is not required and is not read on the local path.

If you started without a `MODEL_BACKEND` line the backend stays on Gemini, and with no key it can only calibrate: it will now say so on startup and tell you the one-line fix. The side panel always shows the model and mode actually in use, and shows a "no live model is configured" notice in calibration mode, so the active provider is never a guess.

`OLLAMA_KEEP_ALIVE` keeps the model resident between questions. Ollama otherwise unloads after about five minutes idle, and reloading a 17 GB model costs roughly 20 seconds. Use Ollama's duration syntax (`30m`, `2h`) or bare seconds; `0` or empty leaves Ollama's default. With `30m` the first question still pays the load and later ones measured ~1 s.

**What is and is not local.** Screenshots are encoded on your machine and sent only to your local Ollama server, so page content never reaches Google on this path. **Microphone audio is not local:** Chrome's `SpeechRecognition` is a cloud service and sends audio to a Google speech endpoint, so the existing audio disclosure in *Architecture and privacy* still applies. There is no webcam, tab audio, or capture of any other tab.

Measured on an RTX 5090 against `test-page/index.html` (box measured from the live DOM): `qwen3.8:27b` returned `[172,30,210,120]` against a ground truth of `[171,31,205,122]`. A warm turn including a real WebRTC frame took ~1.6 s; the first call after the model is unloaded spends ~20 s loading it, so set `OLLAMA_KEEP_ALIVE`.

**Differences from the Gemini path, all deliberate:**

- Turn-based, not duplex. One question produces one answer; speaking over a reply cancels it locally, but there is no server-side VAD and no mid-sentence barge-in.
- One image per question rather than a continuous 0.8 fps feed, so image sends stop while a highlight is visible and resume after it clears.
- Replies are text plus `speechSynthesis` audio, not Gemini's 24 kHz return track, so `backend/audio.py` and the WebRTC return path are unused here.
- No microphone audio is sent over WebRTC; the peer connection carries tab video only.
- Tool arguments are normalised before validation because the local model emits `box_2d` as the string `"[172, 30, 205, 122]"` rather than a number array. Malformed values are still rejected by the same `HighlightArgs` checks.
- The local model frequently calls `highlight_region` and then returns no text at all. When that happens the reply describes what actually happened ("I put a box around it.") rather than claiming nothing was found.
- Recognition is suspended for the whole spoken reply and for a short settle window afterwards, and any final result that reuses most of the assistant's own wording is discarded. The reply is spoken by the same machine that is listening, so without this the microphone transcribes the assistant's reply and sends it back as a new question. If the guard ever fails, listening stops and the panel says so instead of looping. Headphones avoid the problem entirely.
- The `gemma4` model is fast and transcribes audio well, but measured 0/4 on normalised box grounding, so it is not the default; any model you substitute must be checked against a real page before you trust its rectangles.

