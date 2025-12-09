# Consultant Video Introduction

## Overview

Allow consultants to upload a short (30-90 second) video introduction that appears on their profile. Humanizes the consultant and increases booking conversion rates.

### Value Proposition

- **Higher Conversion**: Video intros increase booking rates by 20-40%
- **Trust Building**: Consultees "meet" the consultant before booking
- **Differentiation**: Stand out from text-only profiles
- **Personality Showcase**: Demonstrate communication style

---

## User Stories

### Consultants

- As a consultant, I want to record or upload an intro video
- As a consultant, I want to preview how my video appears on my profile
- As a consultant, I want to update or remove my video anytime
- As a consultant, I want guidance on what to include in my intro

### Consultees

- As a consultee, I want to watch consultant videos before booking
- As a consultee, I want videos to load quickly
- As a consultee, I want to skip videos if I prefer reading

---

## Technical Architecture

### Database Schema

**Minimal change - add one field to ConsultantProfile:**

```prisma
model ConsultantProfile {
  // Existing fields...

  // NEW: Video introduction
  videoIntroUrl     String?   // URL to video file (Supabase Storage or CDN)
  videoIntroThumbnail String? // Auto-generated or custom thumbnail
  videoIntroDuration  Int?    // Duration in seconds
}
```

Alternatively, use existing JSON field if avoiding migrations:

```typescript
// Store in ConsultantProfile metadata or settings JSON
interface ConsultantSettings {
  videoIntro?: {
    url: string;
    thumbnailUrl: string;
    duration: number;
    uploadedAt: string;
  };
}
```

### Video Processing Flow

```
┌─────────────────────────────────────────────────────────┐
│              VIDEO UPLOAD FLOW                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. UPLOAD                                              │
│     ──────                                              │
│     - Consultant uploads video (max 90 seconds, 100MB) │
│     - Supported: MP4, MOV, WebM                        │
│     - Upload to Supabase Storage or S3                 │
│                                                         │
│  2. PROCESSING                                          │
│     ──────────                                          │
│     - Validate duration (30-90 seconds)                │
│     - Generate thumbnail at 0:02                       │
│     - Transcode to web-optimized format (optional)     │
│     - Generate multiple resolutions (optional)         │
│                                                         │
│  3. STORAGE                                             │
│     ───────                                             │
│     - Store in: supabase/consultant-videos/{id}/       │
│     - Update ConsultantProfile with URL                │
│     - CDN caching for fast delivery                    │
│                                                         │
│  4. DISPLAY                                             │
│     ───────                                             │
│     - Lazy load on profile page                        │
│     - Thumbnail preview, click to play                 │
│     - Autoplay option (muted)                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// lib/video/upload.ts

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_DURATION_SECONDS = 90;
const MAX_FILE_SIZE_MB = 100;
const ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

export async function uploadVideoIntro(
  consultantProfileId: string,
  file: File
): Promise<{ url: string; thumbnailUrl: string; duration: number }> {
  // 1. Validate file type
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error('Invalid file type. Please upload MP4, MOV, or WebM.');
  }

  // 2. Validate file size
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`);
  }

  // 3. Validate duration (client-side check, verify server-side)
  const duration = await getVideoDuration(file);
  if (duration > MAX_DURATION_SECONDS) {
    throw new Error(`Video too long. Maximum duration is ${MAX_DURATION_SECONDS} seconds.`);
  }

  // 4. Upload to Supabase Storage
  const fileName = `${consultantProfileId}/intro-${Date.now()}.mp4`;
  const { data, error } = await supabase.storage
    .from('consultant-videos')
    .upload(fileName, file, {
      contentType: file.type,
      upsert: true,
    });

  if (error) throw error;

  // 5. Get public URL
  const { data: urlData } = supabase.storage
    .from('consultant-videos')
    .getPublicUrl(fileName);

  // 6. Generate thumbnail (using external service or ffmpeg)
  const thumbnailUrl = await generateThumbnail(urlData.publicUrl);

  // 7. Update profile
  await prisma.consultantProfile.update({
    where: { id: consultantProfileId },
    data: {
      videoIntroUrl: urlData.publicUrl,
      videoIntroThumbnail: thumbnailUrl,
      videoIntroDuration: Math.round(duration),
    },
  });

  return {
    url: urlData.publicUrl,
    thumbnailUrl,
    duration: Math.round(duration),
  };
}

async function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration);
    };
    video.onerror = () => reject(new Error('Failed to load video'));
    video.src = URL.createObjectURL(file);
  });
}

async function generateThumbnail(videoUrl: string): Promise<string> {
  // Option 1: Use a service like Cloudinary
  // return `https://res.cloudinary.com/demo/video/upload/so_2/${videoUrl}/thumbnail.jpg`;

  // Option 2: Use FFmpeg in a serverless function
  // const thumbnail = await ffmpeg.extractThumbnail(videoUrl, 2);
  // return uploadThumbnail(thumbnail);

  // Option 3: Client-side canvas capture (during upload)
  // Return placeholder for now
  return videoUrl.replace('.mp4', '_thumb.jpg');
}
```

### API Endpoints

```
POST /api/consultants/[id]/video-intro
  Body: FormData with video file
  Action: Upload and process video
  Returns: { url, thumbnailUrl, duration }

DELETE /api/consultants/[id]/video-intro
  Action: Remove video intro
  Returns: { success: true }

GET /api/consultants/[id]/video-intro
  Returns: { url, thumbnailUrl, duration } or null
```

---

## UI/UX Design

### Upload Interface (Consultant Dashboard)

```
┌─────────────────────────────────────────────────────────┐
│  Video Introduction                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Add a short video to introduce yourself to potential  │
│  clients. Profiles with videos get 30% more bookings!  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │                                                     ││
│  │                  [Current Video]                    ││
│  │                                                     ││
│  │            ┌─────────────────────┐                 ││
│  │            │                     │                 ││
│  │            │    ▶️ 0:45          │                 ││
│  │            │                     │                 ││
│  │            └─────────────────────┘                 ││
│  │                                                     ││
│  │  Uploaded: Dec 5, 2024                             ││
│  │                                                     ││
│  │  [Replace Video]  [Remove]                         ││
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  OR                                                     │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │                                                     ││
│  │         📹 Upload Your Video Introduction          ││
│  │                                                     ││
│  │         Drag & drop or click to browse             ││
│  │                                                     ││
│  │         MP4, MOV, WebM • Max 90 seconds • 100MB   ││
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  💡 Tips for a Great Intro Video                       │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ✓ Keep it 30-60 seconds                               │
│  ✓ Introduce yourself and your expertise              │
│  ✓ Mention who you help best                          │
│  ✓ Be authentic - show your personality               │
│  ✓ Good lighting and clear audio                      │
│  ✓ Look at the camera                                 │
│                                                         │
│  Example script:                                        │
│  "Hi, I'm [Name]. I help [target audience] with       │
│  [expertise]. In my sessions, we'll work on [value].  │
│  I'd love to help you [outcome]. Book a session and   │
│  let's get started!"                                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Profile Display (Public)

```
┌─────────────────────────────────────────────────────────┐
│  Priya Sharma                                           │
│  Marketing Strategist | ⭐ 4.9 (47 reviews)            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────────────────────────────────────────┐
│  │                                                      │
│  │     ┌─────────────────────────────────────┐         │
│  │     │                                     │         │
│  │     │         [Thumbnail Image]           │         │
│  │     │                                     │         │
│  │     │              ▶️                     │         │
│  │     │                                     │         │
│  │     │           0:45                      │         │
│  │     │                                     │         │
│  │     └─────────────────────────────────────┘         │
│  │                                                      │
│  │     Watch Priya's Introduction                      │
│  │                                                      │
│  └──────────────────────────────────────────────────────┘
│                                                         │
│  About                                                  │
│  ─────────────────────────────────────────────────────  │
│  [Profile description text...]                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Video Player Component

```typescript
// components/VideoIntro.tsx

'use client';

import { useState, useRef } from 'react';

interface VideoIntroProps {
  videoUrl: string;
  thumbnailUrl: string;
  duration: number;
  consultantName: string;
}

export function VideoIntro({
  videoUrl,
  thumbnailUrl,
  duration,
  consultantName,
}: VideoIntroProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handlePlay = () => {
    if (videoRef.current) {
      videoRef.current.play();
      setIsPlaying(true);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="video-intro-container">
      {!isPlaying ? (
        <div className="thumbnail-wrapper" onClick={handlePlay}>
          <img
            src={thumbnailUrl}
            alt={`${consultantName}'s introduction`}
            className="thumbnail"
          />
          <div className="play-overlay">
            <button className="play-button" aria-label="Play video">
              ▶️
            </button>
            <span className="duration">{formatDuration(duration)}</span>
          </div>
          <p className="watch-text">Watch {consultantName}'s Introduction</p>
        </div>
      ) : (
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          autoPlay
          className="video-player"
          onEnded={() => setIsPlaying(false)}
        >
          Your browser does not support video playback.
        </video>
      )}
    </div>
  );
}
```

---

## Implementation Approach

### Phase 1: Basic Upload

1. Add video upload endpoint
2. Store in Supabase Storage
3. Update ConsultantProfile with URL
4. Basic display on profile

### Phase 2: Processing & Optimization

1. Duration validation
2. Thumbnail generation
3. Video transcoding (optional, for smaller files)
4. CDN optimization

### Phase 3: UI Polish

1. Upload progress indicator
2. In-browser video preview before upload
3. Recording tips and guidance
4. Replace/remove functionality

### Phase 4: Analytics

1. Track video plays
2. Measure impact on booking conversion
3. A/B test autoplay vs click-to-play

---

## Dependencies

### Depends On

- Supabase Storage or S3
- ConsultantProfile model

### Features That Depend On This

- **Smart Matching** - Profiles with video may rank higher
- **Booking Widget** - Can show video in widget

---

## Technical Considerations

### Storage

- Supabase Storage: Easy, integrated
- Cloudinary: Better video processing, CDN
- AWS S3 + CloudFront: Scalable, cost-effective

### Video Processing (Optional)

- **Mux**: Professional video hosting with adaptive streaming
- **Cloudinary**: Automatic optimization and transformation
- **FFmpeg (self-hosted)**: Full control, cost-effective

### Performance

- Lazy load videos (don't auto-load on page)
- Use thumbnail until user clicks play
- Consider adaptive bitrate for mobile

---

## Guidelines for Consultants

### Content Recommendations

1. **Length**: 30-60 seconds ideal
2. **Introduction**: Name and expertise
3. **Target audience**: Who you help
4. **Value proposition**: What clients gain
5. **Call to action**: Encourage booking
6. **Personality**: Be authentic

### Technical Requirements

1. **Lighting**: Well-lit face
2. **Audio**: Clear, no background noise
3. **Background**: Professional or neutral
4. **Camera**: Eye level, stable
5. **Format**: Landscape preferred

### Example Script

> "Hi, I'm Priya, a marketing strategist with 10 years of experience helping D2C brands scale their customer acquisition. In our sessions, I'll help you optimize your ad spend, reduce CAC, and build a sustainable growth engine. Whether you're just starting out or looking to break through a plateau, I'd love to help you reach your next milestone. Book a session and let's get started!"
