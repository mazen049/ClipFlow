# ClipFlow

ClipFlow is a self-hosted starter project for turning a long video into vertical short clips.

## Included in this version

- Responsive React dashboard with a dark violet design and Framer Motion animations.
- Video upload and public YouTube URL input.
- FastAPI processing service with upload and job-status endpoints.
- FFmpeg 9:16 vertical rendering and burned-in caption text.
- Optional local transcription using faster-whisper (tiny model by default).
- Transcript-based highlight ranking, with an explicitly labeled evenly-spaced fallback if transcription is unavailable.
- Docker Compose setup for the processing API.

## Run it on Windows

Install Docker Desktop (with its WSL 2 backend) and Node.js 18+ first.

**Terminal 1 — start the video API** (from the repository folder):

```powershell
docker compose up --build
```

The first build downloads the Python packages and the Whisper model. It can take a while. The API listens locally at http://localhost:8000. Check http://localhost:8000/api/health.

**Terminal 2 — start the dashboard** (from the same repository folder):

```powershell
npm install
npm run dev
```

Open the Vite URL shown in the terminal (normally http://localhost:5173).

To stop the API, press Ctrl+C in its terminal, then run:

```powershell
docker compose down
```

Your generated MP4 files are kept in the Docker volume named `clipflow_data`. `docker compose down` does not delete that volume.

## Current limitations — read before use

This is an early local prototype, not a finished automatic clipping product.

- Highlight selection is a simple transcript heuristic, not an advanced semantic video-understanding model. If transcription fails or no useful transcript is found, the service creates evenly spaced preview clips and labels them as such.
- Captions currently show the selected transcript excerpt as a single timed caption, not animated word-by-word subtitles.
- Jobs are held in memory; restarting the API loses their status.
- URL input currently supports public HTTPS YouTube / youtu.be links only. Some videos cannot be downloaded because of platform restrictions, age/region restrictions, or extractor changes.
- The dashboard and API run locally. There is no user account system or cloud hosting.
- Automatic publishing to YouTube, Instagram, and TikTok is not implemented. Each platform has separate API access, app-review, and account requirements.
- Only process videos you own or have permission to use, and follow the source platform's terms.

## Performance

The default Whisper model is `tiny` and runs on CPU. On older computers, transcription and 1080x1920 rendering may be slow. Start with a short test video. The first run downloads model files.

## Stack

- Frontend: React, Vite, Framer Motion, Lucide
- Backend: FastAPI, yt-dlp, faster-whisper, FFmpeg
- Local runtime: Docker Compose
