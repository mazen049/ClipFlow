import os
import importlib.util
import ipaddress
import socket
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
    if (parsed.scheme != "https" or host not in allowed_hosts or
            parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError("For this version, use a public YouTube or youtu.be HTTPS link on port 443.")
    # Reduce SSRF risk: reject hostnames that resolve to private, loopback,
    # link-local, multicast, or otherwise non-public IP addresses.
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("Could not resolve the YouTube hostname.") from exc
    resolved = {item[4][0] for item in addresses}
    if not resolved or any(not ipaddress.ip_address(address).is_global for address in resolved):
        raise ValueError("The video URL resolved to a non-public network address.")
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


def choose_highlights(path: Path, duration: float, count: int, clip_seconds: int):
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(os.getenv("WHISPER_MODEL", "tiny"), device="cpu", compute_type="int8")
        segments, _ = model.transcribe(
            str(path), vad_filter=True, word_timestamps=True
        )
        transcript = []
        for seg in segments:
            text = re.sub(r"\s+", " ", seg.text).strip()
            if not text:
                continue
            words = []
            for spoken_word in (seg.words or []):
                word_text = re.sub(r"\s+", " ", (spoken_word.word or "")).strip()
                word_start = spoken_word.start
                word_end = spoken_word.end
                if word_text and word_start is not None and word_end is not None and word_end > word_start:
                    words.append({
                        "start": float(word_start),
                        "end": float(word_end),
                        "text": word_text
                    })
            # Keep captions available on Whisper versions/languages that omit word timings.
            if not words:
                tokens = re.findall(r"\S+", text)
                segment_start = float(seg.start)
                segment_end = float(seg.end)
                segment_length = max(0.1, segment_end - segment_start)
                for index, token in enumerate(tokens):
                    words.append({
                        "start": segment_start + segment_length * index / len(tokens),
                        "end": segment_start + segment_length * (index + 1) / len(tokens),
                        "text": token
                    })
            transcript.append({
                "start": float(seg.start),
                "end": float(seg.end),
                "text": text,
                "words": words
            })

        if transcript:
            candidates = []
            for item in transcript:
                text = item["text"]
                words_count = len(text.split())
                if item["end"] - item["start"] < 1.2 or words_count < 4:
                    continue
                lower = text.lower()
                score = min(words_count, 28) / 8
                score += sum(
                    1.2 for term in (
                        "why", "secret", "best", "never", "important",
                        "because", "finally", "imagine", "actually", "how"
                    ) if term in lower
                )
                score += 0.7 if "?" in text or "!" in text else 0
                center = (item["start"] + item["end"]) / 2
                start = max(0, min(max(0, duration - clip_seconds), center - clip_seconds / 2))
                clip_length = min(clip_seconds, duration - start)
                captions = []
                for spoken in transcript:
                    for word in spoken["words"]:
                        cap_start = max(start, word["start"])
                        cap_end = min(start + clip_length, word["end"])
                        if cap_end - cap_start >= 0.04:
                            captions.append({
                                "start": round(cap_start - start, 3),
                                "end": round(cap_end - start, 3),
                                "text": word["text"]
                            })
                captions.sort(key=lambda caption: caption["start"])
                candidates.append((score, start, text, captions))

            candidates.sort(key=lambda item: item[0], reverse=True)
            selected = []
            for score, start, text, captions in candidates:
                if all(abs(start - old["start"]) > clip_seconds * 0.8 for old in selected):
                    selected.append({
                        "start": start,
                        "duration": min(clip_seconds, max(1, duration - start)),
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
        start = max(0, min(max(0, duration - 1), (duration * (i + 1) / (total + 1)) - clip_seconds / 2))
        clips.append({
            "start": start,
            "duration": min(clip_seconds, duration - start),
            "title": f"Preview clip {i + 1}",
            "score": 0,
            "captions": [],
            "method": "evenly-spaced-fallback"
        })
    return clips


def choose_auto_style(text: str) -> dict:
    """Choose a deterministic caption/colour preset from the detected transcript."""
    lower = text.lower()
    energetic_terms = (
        "wow", "secret", "never", "amazing", "shocking", "insane",
        "must", "stop", "unbelievable", "finally", "why", "how"
    )
    if "!" in text or "?" in text or any(term in lower for term in energetic_terms):
        return {
            "name": "bold",
            "font_size": 64,
            "primary": "&H0000D7FF",
            "outline": 5,
            "margin_v": 175,
            "saturation": "1.08",
            "contrast": "1.05"
        }
    if len(text.split()) >= 18:
        return {
            "name": "story",
            "font_size": 54,
            "primary": "&H00D6B6FF",
            "outline": 4,
            "margin_v": 190,
            "saturation": "0.96",
            "contrast": "1.04"
        }
    return {
        "name": "clean",
        "font_size": 58,
        "primary": "&H00E6F0FF",
        "outline": 4,
        "margin_v": 165,
        "saturation": "1.02",
        "contrast": "1.03"
    }


def ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, int(round(seconds * 100)))
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{fraction:02d}"


def ass_safe_text(value: str) -> str:
    return (
        re.sub(r"\s+", " ", value)
        .replace("\\", "/")
        .replace("{", "(")
        .replace("}", ")")
        .strip()
    )


def write_word_subtitles(destination: Path, captions: list[dict], style: dict):
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,DejaVu Sans,{style['font_size']},{style['primary']},&H00FFFFFF,"
        f"&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,{style['outline']},2,2,70,70,{style['margin_v']},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    valid = []
    for caption in captions:
        text = ass_safe_text(str(caption.get("text", "")))
        start = max(0.0, float(caption.get("start", 0)))
        end = max(start + 0.04, float(caption.get("end", start + 0.12)))
        if text:
            valid.append({"text": text, "start": start, "end": end})

    events = []
    # Group a few timed words into a readable caption line. Karaoke timing
    # highlights each word in sequence while preserving the sentence context.
    for offset in range(0, len(valid), 6):
        group = valid[offset:offset + 6]
        if not group:
            continue
        pieces = []
        for word in group:
            duration_cs = max(1, int(round((word["end"] - word["start"]) * 100)))
            pieces.append(f"{{\\kf{duration_cs}}}{word['text']}")
        events.append(
            f"Dialogue: 0,{ass_timestamp(group[0]['start'])},{ass_timestamp(group[-1]['end'])},"
            f"Default,,0,0,0,,{' '.join(pieces)}"
        )
    destination.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")


def render_clip(
    source: Path,
    destination: Path,
    start: float,
    length: float,
    title: str,
    captions: list[dict],
    style: dict
):
    # Render a vertical 9:16 clip with timed, word-by-word karaoke captions.
    subtitle_file = destination.with_suffix(".ass")
    subtitle_filter = None
    if captions:
        write_word_subtitles(subtitle_file, captions, style)
        subtitle_filter = "subtitles=" + subtitle_file.as_posix()

    vf = (
        "scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,setsar=1,"
        f"eq=saturation={style['saturation']}:contrast={style['contrast']}"
    )
    if subtitle_filter:
        vf += "," + subtitle_filter

    try:
        run([
            "ffmpeg", "-y", "-ss", str(max(0, start)), "-i", str(source), "-t", str(length),
            "-vf", vf, "-r", "30", "-c:v", "libx264", "-preset", "ultrafast",
            "-crf", "25", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            str(destination)
        ], timeout=1800)
    finally:
        subtitle_file.unlink(missing_ok=True)
    return destination

def process_job(job_id: str, source: Path, workdir: Path, count: int, clip_seconds: int):
    try:
        update_job(job_id, status="processing", progress=10, message="Reading video metadata")
        duration = video_duration(source)
        if duration < 3:
            raise ValueError("The video is too short to create a clip.")
        update_job(job_id, progress=25, message="Finding candidate moments")
        highlights = choose_highlights(source, duration, count, clip_seconds)
        rendered = []
        for index, item in enumerate(highlights, start=1):
            update_job(job_id, progress=30 + int(60 * (index-1)/max(1,len(highlights))), message=f"Rendering clip {index} of {len(highlights)}")
            output = OUTPUTS / f"{job_id}-{index:02d}.mp4"
            style = choose_auto_style(item["title"])
            render_clip(source, output, item["start"], item["duration"], item["title"], item.get("captions", []), style)
            rendered.append({
                "id": f"{job_id}-{index:02d}", "title": item["title"],
                "start": round(item["start"], 2), "duration": round(item["duration"], 2),
                "method": item.get("method", "transcript-ranking"),
                "style": style["name"],
                "caption_mode": "word-by-word" if item.get("captions") else "none",
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


def create_job(source: Path, count: int, clip_seconds: int):
    global ACTIVE_JOB
    job_id = uuid.uuid4().hex
    workdir = source.parent
    with LOCK:
        if ACTIVE_JOB is not None:
            shutil.rmtree(workdir, ignore_errors=True)
            raise HTTPException(409, "ClipFlow is processing another video. Wait for it to finish, then try again.")
        ACTIVE_JOB = job_id
        JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0, "message": "Waiting to start", "clips": []}
    thread = threading.Thread(target=process_job, args=(job_id, source, workdir, count, clip_seconds), daemon=True)
    thread.start()
    return JOBS[job_id]


@app.get("/api/health")
def health():
    missing = [tool for tool in ("ffmpeg", "ffprobe") if not shutil.which(tool)]
    return {"ok": not missing, "service": "ClipFlow API", "version": app.version, "missing_tools": missing,
            "transcription_available": importlib.util.find_spec("faster_whisper") is not None}


@app.post("/api/jobs/upload")
async def upload_video(file: UploadFile = File(...), count: int = 3, clip_seconds: int = 30):
    suffix = Path(file.filename or "video.mp4").suffix.lower()
    if suffix not in VIDEO_SUFFIXES:
        raise HTTPException(400, "Unsupported video format. Use MP4, MOV, MKV or WEBM.")
    if not 1 <= count <= 8 or not 10 <= clip_seconds <= 90:
        raise HTTPException(400, "Choose 1–8 clips and a clip length from 10 to 90 seconds.")
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
    # Confirm that the uploaded bytes are a readable video before queuing work.
    try:
        video_duration(source)
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(400, "The uploaded file is not a readable video.")
    finally:
        await file.close()
    return create_job(source, count, clip_seconds)


@app.post("/api/jobs/url")
def url_job(payload: UrlJob, count: int = 3, clip_seconds: int = 30):
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
