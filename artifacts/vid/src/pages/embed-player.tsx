import { useEffect, useMemo } from "react"
import { useParams } from "wouter"
import { LoaderCircle, AlertCircle } from "lucide-react"
import { createPlaybackEvents, useGetPublicVideo, getGetPublicVideoQueryKey } from "@workspace/api-client-react"
import { Player } from "@/components/player"

export default function EmbedPlayer() {
  const { id } = useParams<{ id: string }>()
  const video = useGetPublicVideo(id, {
    query: {
      queryKey: getGetPublicVideoQueryKey(id),
      retry: (failureCount, error: any) => {
        if (error?.status === 404 || error?.status === 503) return false;
        return failureCount < 3;
      }
    }
  })

  const sessionId = useMemo(() => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID()
    }
    return Math.random().toString(36).substring(2, 15)
  }, [])

  useEffect(() => {
    if (!video.data) return
    void createPlaybackEvents({
      events: [{
        videoId: video.data.id,
        sessionId,
        eventType: "load",
        positionSeconds: 0,
        occurredAt: new Date().toISOString(),
      }],
    })
  }, [sessionId, video.data])

  useEffect(() => {
    if (video.data) {
      document.title = `${video.data.title} - Video Player`
    }
  }, [video.data])

  if (video.isLoading) {
    return (
      <main className="w-full h-[100dvh] bg-black flex items-center justify-center m-0 p-0 overflow-hidden" role="status" aria-live="polite">
        <LoaderCircle className="h-8 w-8 animate-spin motion-reduce:animate-none text-white/70" aria-label="Loading video" />
      </main>
    )
  }

  if (!video.data || video.isError) {
    return (
      <main className="w-full h-[100dvh] bg-black flex items-center justify-center m-0 p-0 overflow-hidden text-white" role="alert" aria-live="assertive">
        <div className="text-center p-6">
          <AlertCircle className="h-8 w-8 mx-auto mb-3 text-white/60" />
          <p>Video unavailable</p>
        </div>
      </main>
    )
  }

  const item = video.data

  const videoObjectJsonLd: any = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": item.title,
    "description": item.description,
    "duration": `PT${item.durationSeconds}S`
  }
  if (item.posterUrl) {
    videoObjectJsonLd.thumbnailUrl = item.posterUrl
  }
  if (item.sourceUrl) {
    videoObjectJsonLd.contentUrl = item.sourceUrl
  }

  const src = item.sourceUrl
    ? {
        src: item.sourceUrl,
        type: item.sourceType === 'hls' ? 'application/x-mpegurl' : 'video/mp4'
      }
    : null;

  const isPlayable = item.status === 'ready' && !!src;

  return (
    <main
      className="w-full h-[100dvh] bg-black m-0 p-0 overflow-hidden flex items-center justify-center"
      style={{
        '--video-brand': item.playerAccent,
        '--video-controls-color': item.playerControlForeground,
        '--video-controls-bg': item.playerControlBackground,
      } as React.CSSProperties}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(videoObjectJsonLd) }}
      />
      <Player
        title={item.title}
        src={isPlayable ? src : null}
        poster={item.posterUrl}
        accentColor={item.playerAccent}
        controlForegroundColor={item.playerControlForeground}
        controlBackgroundColor={item.playerControlBackground}
        posterTreatment={item.posterTreatment}
        logoInitials={item.logoUrl ? undefined : '?'}
        status={!isPlayable ? item.status : undefined}
        message={item.status === 'ready' && !src ? "Playback source is not connected." : undefined}
        load="visible"
        className="w-full h-full rounded-none border-none ring-0"
      />
    </main>
  )
}