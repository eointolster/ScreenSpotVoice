# ScreenSpot Voice Desktop

ScreenSpot Voice Desktop is a standalone Electron app for a selected Linux display. It listens to questions about the current software task, captures a fresh image of the active application window or selected display, answers using the recent conversation, and can draw a temporary click-through rectangle over the actual desktop. It never clicks, types, scrolls, or controls another app.

The local path uses Whisper for speech to text, Ollama for image understanding, and Kokoro for speech output. The optional Gemini API path uses the same local Whisper and Kokoro voice pipeline, but sends the screen image and question to Gemini for visual reasoning. This desktop Gemini path uses one image request per question through the Gemini Interactions API; it is not the Chrome extension's continuous Gemini Live speech stream. Gemini 3.8 Live uses a separate streaming session and cannot be entered as the vision model here.

## Requirements

- Ubuntu/Linux with an X11 session. The overlay was checked on X11. Electron does not support always-on-top windows on Wayland.
- Node.js 22+, npm, Python 3.12, and a microphone.
- For local model mode: Ollama listening on 127.0.0.1:11434 with a vision-capable model available. Install and start Ollama separately; the app does not install or start it for you.
- For Gemini mode: your own Gemini API key entered in Settings after launch. The default guide model is gemini-3.5-flash with low thinking. You can enter gemini-3.5-flash-lite for faster, simpler locating or gemini-3.8-flash for harder tasks. The ID can be changed.

All Node and Python packages, Kokoro model files, and Whisper downloads live inside this project directory. Setup downloads about 354 MB for Kokoro plus the Whisper base.en model and Electron binary. The Kokoro ONNX runtime uses the Kokoro-82M model and avoids a full PyTorch installation. Its pinned release assets are SHA-256 verified.

## Install and run

From this directory:

    ./setup.sh
    ./launch.sh

Setup installs pinned packages, prepares the voice models, builds Electron, and creates ScreenSpot Voice.desktop in this folder. You can copy that launcher to your Desktop and open it there:

    cp "ScreenSpot Voice.desktop" ~/Desktop/
    chmod +x ~/Desktop/"ScreenSpot Voice.desktop"

On GNOME, right-click the copied launcher and choose Allow Launching if prompted. The launcher points back to this project directory, so leave the directory in place. If you move the project, run ./scripts/make-launcher.sh again and replace the old shortcut. This is a desktop shortcut, not a self-contained AppImage.

Check Remember key securely on this computer to avoid re-entering a Gemini key. Electron encrypts the key using your desktop key store and writes only ciphertext in its user-data directory with owner-only file permissions. ScreenSpot refuses to remember a key when Electron falls back to Linux basic_text storage; you can still use the key for one session. Forget saved key removes the ciphertext and in-memory copy. Preferences never contain the key. Ollama mode makes no Google API request. Gemini mode sends the selected image region, question, and up to six recent text turns to Google; microphone WAV is transcribed locally first.

## Using it

1. Select a display and capture area. Active application window is the default; use Full display for desktop icons or items across windows. Choose Local Ollama or Gemini API and enter a key if needed.
2. Click Start session and grant microphone access. The active status remains visible in the app.
3. By default, click Talk now, speak, then click Finish question. The optional hands-free checkbox can detect turns in a quiet room; use Talk now if room noise triggers it or it misses words.
4. On the first question, the control window minimizes and stays minimized until you restore it. Window mode captures only the active application window; Full display mode captures the selected display. The app speaks a next step and draws a box when a relevant target is confidently located.
5. Calibrate box shows a fixed sample outline. If outlines consistently land right or below their targets, use the 5 px alignment buttons to move them left or up; the adjustment is saved. Clear box removes an outline. End session closes the mic and overlay. Closing the control window also ends the session.
6. Optional typed questions use the same screenshot, model and spoken answer.

The outline disappears after twenty seconds and does not block mouse or keyboard input. Each question gets a new image; screen changes are not streamed continuously. Up to six recent text turns stay in memory until the session ends. The app does not save screenshots, microphone recordings, or conversation history.

The first question may be slower while Whisper, Kokoro, or the Ollama model loads. Tiny.en and small.en Whisper choices download into this project on first use. The local model must support image input. If it answers an explicit highlight request without a valid box, the app makes one structured Ollama grounding retry using the same screenshot; this can add latency and still declines to draw a box when the target is uncertain.

## Checks

    npm run typecheck
    npm test
    .venv/bin/python -m unittest discover -s tests -p 'test_*.py'
    .venv/bin/python -m pip check

The earlier local path was exercised on a disposable X11 display using synthetic Transactions and Settings pixels. The current guide, direct-window capture, key storage, and alignment updates have local contract checks; a live Gemini key request and real Blender guidance were not made by the developer. The installed Electron runtime identified the active X11 window as a capture source, and this Ubuntu session reported a gnome_libsecret key backend. Real microphone quality and placement over your own applications still need your check.

## Troubleshooting

- If the launcher does nothing, run ./launch.sh in a terminal and inspect logs/desktop.log. Run ./setup.sh again if models or packages are missing.
- If Calibrate box appears but model highlights do not, check the model's image and tool-call support. The default local model was tested here.
- If Whisper returns no words, use Talk now, speak close to the mic, and finish after the last word. Hands-free uses a simple local volume detector and can mistake loud background sound for speech.
- If the capture is black, verify you are on X11 and that the chosen display permits screen capture. Some protected surfaces cannot be captured.
- If Remember key is unavailable, unlock or configure your desktop key store; ScreenSpot will not save a key with Electron's basic_text fallback.
- If the target is on the desktop rather than inside an app window, choose Full display.
- If an outline is consistently shifted, use the alignment buttons and Reset to return to zero.
- The app does not start or stop Ollama. Start your Ollama service separately.

## Sources

- Electron screen capture: https://www.electronjs.org/docs/latest/api/desktop-capturer
- Electron overlay and minimized-window behavior: https://www.electronjs.org/docs/latest/api/browser-window
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- Whisper implementation: https://github.com/SYSTRAN/faster-whisper
- Kokoro model: https://github.com/hexgrad/kokoro
- Kokoro ONNX runtime and release assets: https://github.com/thewh1teagle/kokoro-onnx
- Ollama chat API: https://docs.ollama.com/api/chat
- Gemini Interactions API image and structured output: https://ai.google.dev/gemini-api/docs/get-started
- Gemini 3.5 Flash model: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash
- Gemini 3.5 Flash-Lite model: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- Gemini 3.8 Flash model: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- Gemini 3.8 Live model: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
