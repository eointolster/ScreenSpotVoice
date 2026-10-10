# ScreenSpot Voice

This repository contains two local-first experiments for getting spoken help with the item visible on screen. They can use Gemini with a key you provide at runtime, or local models where supported. No API key is included in the repository.

## Choose an app

- [`googlePlugin/`](googlePlugin/) is a Chrome extension with a local Python backend. It supports a Gemini Live voice path and an optional local Ollama path. See its [setup and privacy notes](googlePlugin/README.md).
- [`electronDesktopApp/`](electronDesktopApp/) is a Linux Electron desktop app with local Ollama and optional Gemini vision. See its [setup and privacy notes](electronDesktopApp/README.md).

## Run the Chrome extension

You need Chrome 142 or newer, Node.js 22, Python 3.12, and a microphone.

From the repository root, install and build the extension and backend:

```bash
cd googlePlugin
npm ci
npm run build
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
cp .env.example .env
```

For Gemini Live, edit `.env` and set `GEMINI_API_KEY`. For local mode, install and start Ollama, set `MODEL_BACKEND=local` in `.env`, and set `OLLAMA_MODEL` to a vision-and-tools model you have installed. You can also switch providers from the extension's **Model provider** control after pairing. Local mode does not need a Gemini key. Start the backend from `googlePlugin/` and keep its terminal open:

```bash
./start-backend.sh
```

Copy the pairing code it prints. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the repository's `googlePlugin/dist` folder. Open a webpage, click the ScreenSpot Voice toolbar icon, enter the pairing code, and start a session. Grant microphone permission when Chrome asks.

In Chrome's local Ollama mode, screenshots go to your local Ollama server, but Chrome's speech recognition still sends microphone audio to Google's speech service. See the extension README for the full privacy and capture details.

## Run the desktop app

You need Linux with an X11 session, Node.js 22 or newer, Python 3.12, and a microphone. For Local Ollama mode, have Ollama running at `127.0.0.1:11434` with a vision-capable model.

From the repository root:

```bash
cd electronDesktopApp
./setup.sh
./launch.sh
```

Setup installs dependencies, downloads the voice model assets, and builds the app. In the app, select **Local Ollama** or **Gemini API**, choose the capture area, and start a session. For Gemini mode, enter your own key in Settings; the app can optionally remember it using the operating system's secure storage.

Each app has its own dependency locks and detailed usage, privacy, and troubleshooting notes in its README. Generated builds, installed dependencies, downloaded models, local `.env` files, and browser automation artifacts are excluded from Git.

## API keys

The Chrome extension reads its Gemini key from the local `googlePlugin/.env` file, which is ignored by Git. The desktop app accepts its key in Settings and can optionally store it through Electron's operating-system-backed secure storage. Never paste a key into source code, commit history, screenshots, or issue reports.
