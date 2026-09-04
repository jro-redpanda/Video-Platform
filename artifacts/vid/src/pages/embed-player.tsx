import { useEffect, useMemo, useRef, useCallback, useState } from "react"
import { useParams } from "wouter"
import { LoaderCircle, AlertCircle } from "lucide-react"
import { useGetPublicVideo, getGetPublicVideoQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Player } from "@/components/player"
import { usePlaybackAnalytics } from "@/hooks/use-playback-analytics"
import { serializeJsonForHtmlScript } from "@/lib/safe-json-script"
import { createPlaybackSessionId } from "@/lib/playback-session"

export default function EmbedPlayer() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()

  const video = useGetPublicVideo(id, {
    query: {
      queryKey: getGetPublicVideoQueryKey(id),
      retry: (failureCount, error: any) => {
        if (error?.status === 404 || error?.status === 503) return false;
        return failureCount < 3;
      },
      staleTime: 0,
      refetchOnMount: "always",
      refetchInterval: (query: any) => {
        const current = query.state.data
        if (!current) return false
        if (current.status !== "ready") return 5_000
        const expiresAt = current.sourceExpiresAt
          ? new Date(current.sourceExpiresAt).getTime()
          : Number.NaN
        if (!Number.isFinite(expiresAt)) return false
        return Math.max(5_000, Math.min(5 * 60_000, expiresAt - Date.now() - 30_000))
      },
    }
  })

  const sessionId = useMemo(createPlaybackSessionId, [id])

  const refetchVideo = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetPublicVideoQueryKey(id) })
  }, [queryClient, id])

  const { emitEvent, flushQueue } = usePlaybackAnalytics({
    video: video.data,
    sessionId,
    refetchVideo,
  })

  const hasEmittedLoadRef = useRef(false)
  const lastHeartbeatTimeRef = useRef(0)
  const [playbackFailed, setPlaybackFailed] = useState(false)
  const [sourceAttempt, setSourceAttempt] = useState(0)
  const [isRetrying, setIsRetrying] = useState(false)

  useEffect(() => {
    hasEmittedLoadRef.current = false
    lastHeartbeatTimeRef.current = 0
    setPlaybackFailed(false)
    setSourceAttempt(0)
  }, [id])

  useEffect(() => {
    if (!video.data || hasEmittedLoadRef.current) return
    hasEmittedLoadRef.current = true
    emitEvent("load")
  }, [video.data, emitEvent])

  useEffect(() => {
    if (video.data) {
      document.title = `${video.data.title} - Video Player`
    }
  }, [video.data])

  const getPlayerState = useCallback((event: any) => {
    let positionSeconds = 0;
    if (typeof event?.detail === 'number') {
      positionSeconds = event.detail;
    } else if (event?.target?.currentTime !== undefined) {
      positionSeconds = event.target.currentTime;
    }

    let durationSeconds = 0;
    if (event?.target?.duration !== undefined && !isNaN(event?.target?.duration)) {
      durationSeconds = event.target.duration;
    }

    if (isNaN(positionSeconds) || !isFinite(positionSeconds)) positionSeconds = 0;
    if (isNaN(durationSeconds) || !isFinite(durationSeconds)) durationSeconds = 0;

    return { positionSeconds, durationSeconds }
  }, [])

  const onPlay = useCallback((e: any) => emitEvent('play', getPlayerState(e)), [emitEvent, getPlayerState])
  const onPause = useCallback((e: any) => emitEvent('pause', getPlayerState(e)), [emitEvent, getPlayerState])
  const onEnded = useCallback((e: any) => emitEvent('ended', getPlayerState(e)), [emitEvent, getPlayerState])

  const onTimeUpdate = useCallback((e: any) => {
    const now = Date.now()
    if (now - lastHeartbeatTimeRef.current >= 10000) {
      lastHeartbeatTimeRef.current = now
      emitEvent('progress', getPlayerState(e))
    }
  }, [emitEvent, getPlayerState])

  const onError = useCallback((e: any) => {
    let errorCategory: any = 'unknown'
    if (e?.detail?.code === 1 || e?.detail?.message?.includes('network')) errorCategory = 'network'
    else if (e?.detail?.code === 3 || e?.detail?.message?.includes('decode')) errorCategory = 'decode'
    else if (e?.detail?.code === 4 || e?.detail?.message?.includes('src')) errorCategory = 'source'
    else if (e?.detail?.message?.includes('media')) errorCategory = 'media'

    emitEvent('error', { ...getPlayerState(e), errorCategory })
    setPlaybackFailed(true)
  }, [emitEvent, getPlayerState])

  const retryPlayback = useCallback(async () => {
    setIsRetrying(true)
    try {
      const result = await video.refetch()
      if (result.data?.status === "ready" && result.data.sourceUrl) {
        setSourceAttempt((attempt) => attempt + 1)
        setPlaybackFailed(false)
      }
    } finally {
      setIsRetrying(false)
    }
  }, [video])

  // Periodic flush
  useEffect(() => {
    const interval = window.setInterval(() => {
      flushQueue()
    }, 5000)
    return () => window.clearInterval(interval)
  }, [flushQueue])

  if (video.isLoading) {
    return (
      <main className="w-full h-[100dvh] bg-black flex items-center justify-center m-0 p-0 overflow-hidden" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-3 text-white/80">
          <LoaderCircle className="h-8 w-8 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <p>Loading video…</p>
        </div>
      </main>
    )
  }

  if (!video.data || video.isError) {
    const temporarilyUnavailable = (video.error as any)?.status === 503
    return (
      <main className="w-full h-[100dvh] bg-black flex items-center justify-center m-0 p-0 overflow-hidden text-white" role="alert" aria-live="assertive">
        <div className="text-center p-6">
          <AlertCircle className="h-8 w-8 mx-auto mb-3 text-white/60" aria-hidden="true" />
          <h1 className="text-lg font-semibold">
            {temporarilyUnavailable ? "Playback temporarily unavailable" : "Video unavailable"}
          </h1>
          {temporarilyUnavailable && (
            <button
              type="button"
              onClick={() => void retryPlayback()}
              disabled={isRetrying}
              className="mt-4 rounded-md bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-60"
            >
              {isRetrying ? "Retrying…" : "Try again"}
            </button>
          )}
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

  const sourceUrl = item.sourceUrl
    ? `${item.sourceUrl}${item.sourceUrl.includes("?") ? "&" : "?"}attempt=${sourceAttempt}`
    : null
  const src = sourceUrl
    ? {
        src: sourceUrl,
        type: item.sourceType === 'hls' ? 'application/x-mpegurl' : 'video/mp4'
      }
    : null;

  const isPlayable = item.status === 'ready' && !!src && !playbackFailed;

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
        dangerouslySetInnerHTML={{ __html: serializeJsonForHtmlScript(videoObjectJsonLd) }}
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
        status={playbackFailed ? "error" : !isPlayable ? item.status : undefined}
        message={playbackFailed
          ? "Playback could not be started."
          : item.status === 'ready' && !src ? "Playback source is not connected." : undefined}
        actionLabel={playbackFailed ? (isRetrying ? "Retrying…" : "Try again") : undefined}
        onAction={playbackFailed ? () => void retryPlayback() : undefined}
        actionDisabled={isRetrying}
        load="visible"
        className="w-full h-full rounded-none border-none ring-0"
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onTimeUpdate={onTimeUpdate}
        onError={onError}
      />
    </main>
  )
}
