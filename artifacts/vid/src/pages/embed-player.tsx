import { useEffect, useMemo } from "react"
import { useParams } from "wouter"
import { AlertCircle, LoaderCircle, Play } from "lucide-react"
import { createPlaybackEvents, useGetPublicVideo } from "@workspace/api-client-react"

// PRELIMINARY SCAFFOLDING: replace this file at Step 11; do not patch it forward.
// MOCK: replaced at step 11
export default function EmbedPlayer() {
  const { id } = useParams<{ id: string }>()
  const video = useGetPublicVideo(id)
  const sessionId = useMemo(() => crypto.randomUUID(), [])

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

  if (video.isLoading) {
    return (
      <main className="min-h-screen bg-black text-white grid place-items-center">
        <LoaderCircle className="h-8 w-8 animate-spin text-white/70" aria-label="Loading video" />
      </main>
    )
  }

  if (!video.data || video.isError) {
    return (
      <main className="min-h-screen bg-black text-white grid place-items-center p-6 text-center">
        <div><AlertCircle className="h-8 w-8 mx-auto mb-3 text-white/60" /><p>Video unavailable</p></div>
      </main>
    )
  }

  const item = video.data
  return (
    <main
      className="min-h-screen bg-black text-white grid place-items-center p-4"
      style={{ background: `radial-gradient(circle at 35% 30%, ${item.thumbnailColor}, #080808 70%)` }}
    >
      <section className="w-full max-w-5xl aspect-video relative overflow-hidden rounded-md border border-white/10 bg-black/30 shadow-2xl">
        <div className="absolute inset-0 grid place-items-center text-center p-8">
          <div>
            <button
              type="button"
              disabled
              className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full bg-white/15 backdrop-blur text-white"
              aria-label="Playback source unavailable"
            >
              <Play className="h-7 w-7 ml-1" />
            </button>
            <h1 className="text-xl font-semibold">{item.title}</h1>
            <p className="mt-2 text-sm text-white/65">
              {item.status === "ready" ? "Playback source is not connected." : `Video is ${item.status}.`}
            </p>
          </div>
        </div>
        <div className="absolute bottom-0 inset-x-0 h-1 bg-white/15">
          <div className="h-full w-0" style={{ backgroundColor: item.playerAccent }} />
        </div>
      </section>
    </main>
  )
}