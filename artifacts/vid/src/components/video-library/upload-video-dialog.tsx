import { useEffect, useRef, useState } from "react"
import { cancelVideoUpload, completeVideoUpload, initializeVideoUpload } from "@workspace/api-client-react"
import * as tus from "tus-js-client"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Plus } from "lucide-react"
import { cn } from "@/lib/utils"

export function UploadVideoDialog({ onSuccess, folderId }: { onSuccess?: () => void, folderId?: string | null }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'paused' | 'success'>('idle')

  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const [videoId, setVideoId] = useState<string | null>(null)
  const uploadRef = useRef<tus.Upload | null>(null)

  // Preserve resumable state across pause/resume transitions; abort only when
  // this dialog instance leaves the tree unexpectedly.
  useEffect(() => () => {
    void uploadRef.current?.abort(false)
  }, [])

  const resetState = () => {
    setTitle("")
    setDescription("")
    setFile(null)
    setProgress(0)
    setError(null)
    setUploadState('idle')
    setIdempotencyKey(null)
    setVideoId(null)
    uploadRef.current = null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title || !file) return
    setError(null)
    setUploadState('uploading')
    try {
      const key = idempotencyKey ?? crypto.randomUUID()
      if (!idempotencyKey) setIdempotencyKey(key)

      const initialized = await initializeVideoUpload({
        title,
        description: description || undefined,
        fileName: file.name,
        contentType: file.type,
        contentLength: file.size,
        folderId: folderId === 'root' ? null : folderId
      }, { headers: { "Idempotency-Key": key } })

      if (initialized.upload.kind !== "tus") {
        throw new Error("This upload method is not supported by this browser.")
      }

      setVideoId(initialized.videoId)

      const upload = new tus.Upload(file, {
        endpoint: initialized.upload.endpoint,
        headers: initialized.upload.headers,
        metadata: { filename: file.name, filetype: file.type },
        removeFingerprintOnSuccess: true,
        retryDelays: [0, 1000, 3000, 5000],
        onProgress: (uploaded: number, total: number) => {
          setProgress(total ? Math.round((uploaded / total) * 100) : 0)
        },
        onError: (cause: Error) => {
          setError(cause.message)
          setUploadState('paused')
        },
        onSuccess: async () => {
          setProgress(100)
          try {
            await completeVideoUpload(initialized.videoId)
            onSuccess?.()
            setUploadState('success')
            setTimeout(() => {
              setOpen(false)
              resetState()
            }, 1500)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Upload completed but processing acknowledgement failed.")
            setUploadState('paused')
          }
        },
      })

      uploadRef.current = upload
      const previous = await upload.findPreviousUploads()
      if (previous.length) {
        upload.resumeFromPreviousUpload(previous[0])
      }
      upload.start()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to initialize upload.")
      setUploadState('paused')
    }
  }

  const handleCancel = async () => {
    if (videoId) {
      try {
        if (uploadState === 'uploading') {
          if (uploadRef.current) {
            await uploadRef.current.abort(false)
          }
          setUploadState('paused')
        }

        await cancelVideoUpload(videoId)
        onSuccess?.()

        if (uploadRef.current) {
          await uploadRef.current.abort(true)
        }
        uploadRef.current = null
        resetState()
        setOpen(false)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to cancel upload. You can resume or try cancelling again.")
      }
    } else {
      if (uploadRef.current) {
        await uploadRef.current.abort(true)
      }
      uploadRef.current = null
      resetState()
      setOpen(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Prevent closing by clicking outside if upload is in progress or paused
        if (!next && (uploadState === 'uploading' || uploadState === 'paused')) return
        if (!next) resetState()
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button className="gap-2 shadow-sm" data-testid="button-upload-video">
          <Plus className="h-4 w-4" /> Upload Video
        </Button>
      </DialogTrigger>
      <DialogContent
        onInteractOutside={(e) => {
          if (uploadState === 'uploading' || uploadState === 'paused') {
            e.preventDefault()
          }
        }}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Upload New Video</DialogTitle>
          </DialogHeader>

          <div className="py-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="file">Video file</Label>
              <Input
                id="file"
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/mpeg"
                disabled={uploadState !== 'idle'}
                onChange={e => {
                  setFile(e.target.files?.[0] ?? null)
                  setError(null)
                  setIdempotencyKey(crypto.randomUUID())
                }}
                data-testid="input-file"
              />
              {file && (
                <p className="text-xs text-muted-foreground">
                  {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="title">Video Title</Label>
              <Input
                id="title"
                value={title}
                disabled={uploadState !== 'idle'}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Q3 All Hands"
                autoFocus
                data-testid="input-title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="desc">Description (optional)</Label>
              <Textarea
                id="desc"
                value={description}
                disabled={uploadState !== 'idle'}
                onChange={e => setDescription(e.target.value)}
                placeholder="What is this video about?"
                data-testid="input-description"
              />
            </div>
          </div>

          {(uploadState === 'uploading' || uploadState === 'paused' || uploadState === 'success') && (
            <div className="space-y-2 mb-4 bg-muted/50 p-3 rounded-md border">
              <div className="text-sm font-medium flex justify-between">
                <span>
                  {uploadState === 'success' ? 'Upload Complete!' :
                   uploadState === 'paused' ? 'Upload Paused' :
                   'Uploading...'}
                </span>
                <span>{progress}%</span>
              </div>
              <div
                className="h-2.5 rounded-full bg-muted overflow-hidden"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Upload progress"
              >
                <div
                  className={cn(
                    "h-full transition-all duration-300",
                    uploadState === 'success' ? "bg-green-500" :
                    uploadState === 'paused' ? "bg-amber-500" : "bg-primary"
                  )}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20" role="alert">
              {error} {uploadState === 'paused' && "You can resume to retry."}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            {uploadState === 'idle' && (
              <>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={!title || !file} data-testid="button-start-upload">
                  Upload
                </Button>
              </>
            )}

            {(uploadState === 'uploading' || uploadState === 'paused') && (
              <>
                <Button type="button" variant="destructive" onClick={handleCancel} data-testid="button-cancel-upload">
                  Cancel Upload
                </Button>

                {uploadState === 'uploading' && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      try {
                        if (uploadRef.current) {
                          await uploadRef.current.abort(false)
                        }
                        setUploadState('paused')
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Failed to pause upload.")
                      }
                    }}
                    data-testid="button-pause-upload"
                  >
                    Pause
                  </Button>
                )}

                {uploadState === 'paused' && (
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => {
                      uploadRef.current?.start()
                      setUploadState('uploading')
                      setError(null)
                    }}
                    data-testid="button-resume-upload"
                  >
                    Resume
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
