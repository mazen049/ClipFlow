import os
import importlib.util
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

ROOT = Path(os.getenv("CLIPFLOW_DATA", "data")).resolve()
UPLOADS = ROOT / "uploads"
OUTPUTS = ROOT / "outputs"
for folder in (UPLOADS, OUTPUTS):
    folder.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="ClipFlow API", version="0.2.0", description="Local video-to-short processing API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

JOBS: dict[str, dict] = {}
LOCK = threading.Lock()
ACTIVE_JOB: Optional[str] = None
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}


class UrlJob(BaseModel):
    url: HttpUrl


def update_job(job_id: str, **values):
    with LOCK:
        JOBS[job_id].update(values)


def run(command: list[str], timeout: Optional[int] = None):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "Command failed")[-2500:])
    return result.stdout


def download_url(url: str, destination: Path) -> Path:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    allowed_hosts = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"}
    if parsed.scheme != "https" or host not in allowed_hosts:
        raise ValueError("For this first version, use a public YouTube or youtu.be HTTPS link.")
    options = {
        "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "merge_output_format": "mp4",
        "outtmpl": str(destination / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        "retries": 2,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)
        candidate = Path(ydl.prepare_filename(info))
    if not candidate.exists():
        candidate = candidate.with_suffix(".mp4")
    if not candidate.exists():
        matches = list(destination.glob("source.*"))
        if not matches:
            raise RuntimeError("The downloader did not produce a video file.")
        candidate = matches[0]
    return candidate


def video_duration(path: Path) -> float:
    output = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ], timeout=30)
    return max(0.0, float(output.strip()))


def choose_highlights(path: Path, duration: float, count: int, clip_seconds: int, video_type: str = "auto"):
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(os.getenv("WHISPER_MODEL", "tiny"), device="cpu", compute_type="int8")
        segments, _ = model.transcribe(str(path), vad_filter=True, word_timestamps=False)
        transcript = []
        for seg in segments:
            text = re.sub(r"\s+", " ", seg.text).strip()
            if text:
                transcript.append({"start": float(seg.start), "end": float(seg.end), "text": text})
        if transcript:
            candidates = []
            for item in transcript:
                text = item["text"]
                words = len(text.split())
                if item["end"] - item["start"] < 1.2 or words < 4:
                    continue
                lower = text.lower()
                score = min(words, 28) / 8
                score += sum(1.2 for term in ("why", "secret", "best", "never", "important", "because", "finally", "imagine", "actually", "how") if term in lower)
                score += 0.7 if "?" in text or "!" in text else 0
                type_terms = {"podcast": ("think", "opinion", "question", "experience", "story"), "gaming": ("game", "level", "player", "win", "match", "boss"), "educational": ("learn", "explain", "because", "example", "step", "how"), "motivation": ("goal", "success", "努力", "believe", "never give up", "努力"), "story": ("then", "suddenly", "one day", "story", "finally", "after")}
                score += sum(0.8 for term in type_terms.get(video_type, ()) if term in lower)
                center = (item["start"] + item["end"]) / 2
                start = max(0, min(max(0, duration - clip_seconds), center - clip_seconds / 2))
                clip_length = min(clip_seconds, duration - start)
                captions = []
                for spoken in transcript:
                    cap_start = max(start, spoken["start"])
                    cap_end = min(start + clip_length, spoken["end"])
                    if cap_end - cap_start >= 0.35:
                        captions.append({
                            "start": round(cap_start - start, 3),
                            "end": round(cap_end - start, 3),
                            "text": spoken["text"]
                        })
                candidates.append((score, start, text, captions))
            candidates.sort(key=lambda item: item[0], reverse=True)
            selected = []
            for score, start, text, captions in candidates:
                if all(abs(start - old["start"]) > clip_seconds * 0.8 for old in selected):
                    selected.append({
                        "start": start,
                        "duration": min(clip_seconds, max(1, duration-start)),
                        "title": text[:90],
                        "score": round(score, 2),
                        "captions": captions,
                        "method": "transcript-ranking"
                    })
                if len(selected) >= count:
                    break
            if selected:
                return selected
    except Exception as exc:
        print(f"Transcription/highlight fallback: {exc}")
    # Fallback: evenly spaced preview clips. Clearly labeled as non-AI fallback.
    if duration <= 0:
        raise RuntimeError("Could not read the video duration.")
    total = min(count, max(1, int(duration // max(clip_seconds, 1))))
    clips = []
    for i in range(total):
        start = max(0, min(max(0, duration-1), (duration * (i+1)/(total+1)) - clip_seconds/2))
        clips.append({
            "start": start,
            "duration": min(clip_seconds, duration-start),
            "title": f"Preview clip {i+1}",
            "score": 0,
            "captions": [],
            "method": "evenly-spaced-fallback"
        })
    return clips

def render_clip(source: Path, destination: Path, start: float, length: float, title: str, captions: list[dict], aspect_ratio: str = "9:16", captions_enabled: bool = True):
    # Render the selected output ratio and optionally burn transcript captions.
    srt = destination.with_suffix(".srt")
    subtitle_filter = None
    if captions_enabled and captions:
        entries = []
        for index, caption in enumerate(captions, start=1):
            start_ms = max(0, int(caption["start"] * 1000))
            end_ms = max(start_ms + 250, int(caption["end"] * 1000))
            def stamp(value):
                hours, remainder = divmod(value, 3600000)
                minutes, remainder = divmod(remainder, 60000)
                seconds, millis = divmod(remainder, 1000)
                return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"
            text = re.sub(r"\s+", " ", caption["text"]).strip().replace("-->", "→")
            entries.append(f"{index}\n{stamp(start_ms)} --> {stamp(end_ms)}\n{text}\n")
        srt.write_text("\n".join(entries), encoding="utf-8")
        style = "FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=150"
        subtitle_filter = "subtitles=" + str(srt) + ":force_style='" + style + "'"
    dimensions = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}
    width, height = dimensions.get(aspect_ratio, (1080, 1920))
    vf = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"
    if subtitle_filter:
        vf += "," + subtitle_filter
    run([
        "ffmpeg", "-y", "-ss", str(max(0, start)), "-i", str(source), "-t", str(length),
        "-vf", vf, "-r", "30", "-c:v", "libx264", "-preset", "ultrafast",
        "-crf", "26", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        str(destination)
    ], timeout=1800)
    srt.unlink(missing_ok=True)
    return destination

def process_job(job_id: str, source: Path, workdir: Path, count: int, clip_seconds: int, aspect_ratio: str, captions_enabled: bool, video_type: str):
    try:
        update_job(job_id, status="processing", progress=10, message="Reading video metadata")
        duration = video_duration(source)
        if duration < 3:
            raise ValueError("The video is too short to create a clip.")
        update_job(job_id, progress=25, message="Finding candidate moments")
        highlights = choose_highlights(source, duration, count, clip_seconds, video_type)
        rendered = []
        for index, item in enumerate(highlights, start=1):
            update_job(job_id, progress=30 + int(60 * (index-1)/max(1,len(highlights))), message=f"Rendering clip {index} of {len(highlights)}")
            output = OUTPUTS / f"{job_id}-{index:02d}.mp4"
            render_clip(source, output, item["start"], item["duration"], item["title"], item.get("captions", []), aspect_ratio, captions_enabled)
            rendered.append({
                "id": f"{job_id}-{index:02d}", "title": item["title"],
                "start": round(item["start"], 2), "duration": round(item["duration"], 2),
                "method": item.get("method", "transcript-ranking"),
                "url": f"/api/clips/{output.name}"
            })
        update_job(job_id, status="completed", progress=100, message="Clips are ready", clips=rendered)
    except Exception as exc:
        update_job(job_id, status="failed", progress=100, message=str(exc)[:1200])
    finally:
        global ACTIVE_JOB
        with LOCK:
            if ACTIVE_JOB == job_id:
                ACTIVE_JOB = None
        shutil.rmtree(workdir, ignore_errors=True)


def create_job(source: Path, count: int, clip_seconds: int, aspect_ratio: str, captions_enabled: bool, video_type: str):
    global ACTIVE_JOB
    job_id = uuid.uuid4().hex[:12]
    workdir = source.parent
    with LOCK:
        if ACTIVE_JOB is not None:
            shutil.rmtree(workdir, ignore_errors=True)
            raise HTTPException(409, "ClipFlow is processing another video. Wait for it to finish, then try again.")
        ACTIVE_JOB = job_id
        JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0, "message": "Waiting to start", "clips": []}
    thread = threading.Thread(target=process_job, args=(job_id, source, workdir, count, clip_seconds, aspect_ratio, captions_enabled, video_type), daemon=True)
    thread.start()
    return JOBS[job_id]


@app.get("/api/health")
def health():
    missing = [tool for tool in ("ffmpeg", "ffprobe") if not shutil.which(tool)]
    return {"ok": not missing, "service": "ClipFlow API", "version": app.version, "missing_tools": missing,
            "transcription_available": importlib.util.find_spec("faster_whisper") is not None}


@app.post("/api/jobs/upload")
async def upload_video(file: UploadFile = File(...), count: int = 3, clip_seconds: int = 30, aspect_ratio: str = "9:16", captions: bool = True, video_type: str = "auto"):
    suffix = Path(file.filename or "video.mp4").suffix.lower()
    if suffix not in VIDEO_SUFFIXES:
        raise HTTPException(400, "Unsupported video format. Use MP4, MOV, MKV or WEBM.")
    if not 1 <= count <= 8 or not 10 <= clip_seconds <= 90:
        raise HTTPException(400, "Choose 1–8 clips and a clip length from 10 to 90 seconds.")
    if aspect_ratio not in {"9:16", "16:9", "1:1"}:
        raise HTTPException(400, "Choose 9:16, 16:9 or 1:1 aspect ratio.")
    if video_type not in {"auto", "podcast", "gaming", "educational", "motivation", "story"}:
        raise HTTPException(400, "Choose a supported video type or Auto detect.")
    workdir = UPLOADS / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=True)
    source = workdir / f"source{suffix}"
    size = 0
    try:
        with source.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > 2 * 1024 * 1024 * 1024:
                    raise HTTPException(413, "Video exceeds the 2 GB upload limit.")
                target.write(chunk)
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    if size == 0:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(400, "The uploaded file is empty.")
    return create_job(source, count, clip_seconds, aspect_ratio, captions, video_type)


@app.post("/api/jobs/url")
def url_job(payload: UrlJob, count: int = 3, clip_seconds: int = 30, aspect_ratio: str = "9:16", captions: bool = True, video_type: str = "auto"):
    if not 1 <= count <= 8 or not 10 <= clip_seconds <= 90:
        raise HTTPException(400, "Choose 1–8 clips and a clip length from 10 to 90 seconds.")
    workdir = UPLOADS / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        source = download_url(str(payload.url), workdir)
    except Exception as exc:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(400, f"Could not download this URL: {str(exc)[:500]}")
    return create_job(source, count, clip_seconds)


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found. Jobs are stored in memory for this preview server.")
    return job


@app.get("/api/clips/{filename}")
def get_clip(filename: str):
    if Path(filename).name != filename or not filename.endswith(".mp4"):
        raise HTTPException(400, "Invalid clip name.")
    path = OUTPUTS / filename
    if not path.is_file():
        raise HTTPException(404, "Clip not found.")
    from fastapi.responses import FileResponse
    return FileResponse(path, media_type="video/mp4", filename=filename)
