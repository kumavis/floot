# Floot — Local Voice Transcription

Record your voice in the browser and get a transcript powered by [OpenAI Whisper](https://github.com/openai/whisper) running locally on your machine.

## Prerequisites

**Python 3.8+** and **ffmpeg** are required by Whisper.

```bash
# macOS
brew install ffmpeg
pip install openai-whisper

# Ubuntu/Debian
sudo apt install ffmpeg
pip install openai-whisper
```

Verify the install:

```bash
whisper --help
```

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser, click the record button, speak, and click again to stop. The audio is sent to the server, transcribed with Whisper, and the result appears on screen.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `WHISPER_MODEL` | `base` | Whisper model size (`tiny`, `base`, `small`, `medium`, `large`) |

Example:

```bash
WHISPER_MODEL=small PORT=4000 npm run dev
```

Larger models are more accurate but slower and require more RAM/VRAM.
