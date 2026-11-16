# ClipFlow

A creator-focused workspace for turning long videos into vertical short-form clips for YouTube Shorts, Instagram Reels, and TikTok.

## What's in this first commit

- Responsive dark dashboard with a violet visual identity
- Animated hero, cards, hover states, and reduced-motion support
- Upload picker with drag-and-drop and video-file validation
- Public video URL input
- Platform destination overview and workflow preview

## Run locally

Requirements: Node.js 18 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Important status

This repository currently contains the **frontend preview only**. Video understanding, highlight detection, transcription, animated captions, rendering, persistent project storage, and official social-platform publishing are not implemented yet. The upload and URL controls validate/select a source locally; they do not claim to process or publish a video.

These capabilities will be added in separate, testable stages. Publishing will depend on each platform's official API access and account eligibility.

## Stack

- React + Vite
- Framer Motion
- Lucide icons
- Custom responsive CSS
