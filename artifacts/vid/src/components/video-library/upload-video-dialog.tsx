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

const RECOVERY_VERSION = 1
const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000
const RECOVERY_PREFIX = "g7.video-upload-recovery"

type PendingUpload = {
  version: typeof RECOVERY_VERSION
  createdAt: number
  videoId: string | null
  idempotencyKey: string
  title: string
  description: string
  folderId: string | null
  file: { name: string; type: string; size: number; lastModified: number }
  fingerprint: string
  transferComplete: boolean
}

const recoveryKey = (workspaceId: string) => `${RECOVERY_PREFIX}.${workspaceId}`
const fingerprintFor = (workspaceId: string, idempotencyKey: string, file: PendingUpload["file"]) =>
  `g7:${workspaceId}:${idempotencyKey}:${encodeURIComponent(file.name)}:${encodeURIComponent(file.type)}:${file.size}:${file.lastModified}`
const matchesFile = (file: File, expected: PendingUpload["file"]) =>
  file.name === expected.name && file.type === expected.type && file.size === expected.size && file.lastModified === expected.lastModified

function readRecovery(workspaceId: string): PendingUpload | null {
  try {
    const raw = localStorage.getItem(recoveryKey(workspaceId))
    if (!raw) return null
    if (raw.length > 32768) {
      localStorage.removeItem(recoveryKey(workspaceId))
      return null
    }
    const record: unknown = JSON.parse(raw)
    if (!record || typeof record !== "object") throw new Error("Invalid recovery record")
    const value = record as Partial<PendingUpload>
    const valid = value.version === RECOVERY_VERSION && typeof value.createdAt === "number" &&
      value.createdAt <= Date.now() && Date.now() - value.createdAt <= RECOVERY_TTL_MS && typeof value.idempotencyKey === "string" &&
      value.idempotencyKey.length >= 16 && value.idempotencyKey.length <= 128 &&
      typeof value.title === "string" && value.title.length <= 5000 &&
      typeof value.description === "string" && value.description.length <= 20000 &&
      (value.folderId === null || (typeof value.folderId === "string" && value.folderId.length <= 512)) &&
      (value.videoId === null || (typeof value.videoId === "string" && value.videoId.length <= 512)) &&
      !!value.file && typeof value.file.name === "string" && value.file.name.length <= 1024 &&
      typeof value.file.type === "string" && value.file.type.length <= 127 &&
      typeof value.file.size === "number" && Number.isFinite(value.file.size) && value.file.size > 0 &&
      typeof value.file.lastModified === "number" && Number.isFinite(value.file.lastModified) &&
      typeof value.fingerprint === "string" && value.fingerprint.length <= 4096 &&
      typeof value.transferComplete === "boolean"
    if (!valid) throw new Error("Invalid recovery record")
    const pending = value as PendingUpload
    if (pending.fingerprint !== fingerprintFor(workspaceId, pending.idempotencyKey, pending.file)) {
      throw new Error("Invalid recovery record")
    }
    return pending
  } catch {
    localStorage.removeItem(recoveryKey(workspaceId))
    return null
  }
}

export function UploadVideoDialog({ onSuccess, folderId, workspaceId }: { onSuccess?: () => void, folderId?: string | null, workspaceId?: string }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [pending, setPending] = useState<PendingUpload | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'paused' | 'success'>('idle')
  const uploadRef = useRef<tus.Upload | null>(null)

  const persist = (record: PendingUpload) => {
    if (!workspaceId) return false
    try {
      const serialized = JSON.stringify(record)
      if (serialized.length > 32768) throw new Error("Upload recovery details are too large.")
      localStorage.setItem(recoveryKey(workspaceId), serialized)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save upload recovery details.")
      return false
    }
  }
  const clearRecovery = () => {
    if (workspaceId) {
      try {
        localStorage.removeItem(recoveryKey(workspaceId))
      } catch {
        // The server transition already succeeded; stale local recovery data
        // will be rejected by that terminal state on its next attempted use.
      }
    }
    setPending(null)
  }

  useEffect(() => () => {
    void uploadRef.current?.abort(false)
  }, [])

  useEffect(() => {
    if (!workspaceId) return
    void uploadRef.current?.abort(false)
    uploadRef.current = null
    setPending(null)
    setTitle("")
    setDescription("")
    setFile(null)
    setProgress(0)
    setError(null)
    setUploadState('idle')
    const recovered = readRecovery(workspaceId)
    if (!recovered) return
    setPending(recovered)
    setTitle(recovered.title)
    setDescription(recovered.description)
    setProgress(0)
    setError("An upload was interrupted. Select the exact same file to resume it.")
    setUploadState('paused')
    setOpen(true)
  }, [workspaceId])

  const resetState = () => {
    setTitle("")
    setDescription("")
    setFile(null)
    setProgress(0)
    setError(null)
    setUploadState('idle')
    uploadRef.current = null
  }

  const createPending = (selectedFile: File): PendingUpload | null => {
    if (!workspaceId) {
      setError("Workspace information is still loading. Please try again.")
      return null
    }
    const metadata = { name: selectedFile.name, type: selectedFile.type, size: selectedFile.size, lastModified: selectedFile.lastModified }
    const idempotencyKey = crypto.randomUUID()
    return {
      version: RECOVERY_VERSION, createdAt: Date.now(), videoId: null, idempotencyKey,
      title, description, folderId: folderId === "root" ? null : folderId ?? null, file: metadata,
      fingerprint: fingerprintFor(workspaceId, idempotencyKey, metadata), transferComplete: false,
    }
  }

  const startUpload = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!file && !pending?.transferComplete) {
      setError("Select the exact same file before resuming this upload.")
      return
    }
    if (!title) return
    let record = pending ?? createPending(file!)
    if (!record) return
    if (!record.transferComplete && !matchesFile(file!, record.file)) {
      setError("That file does not match the interrupted upload. Select the exact same file (name, type, size, and modified time).")
      return
    }
    setError(null)
    setUploadState('uploading')
    setPending(record)
    if (!persist(record)) {
      setUploadState('paused')
      return
    }
    try {
      if (record.transferComplete && record.videoId) {
        await completeVideoUpload(record.videoId, { idempotencyKey: record.idempotencyKey })
        clearRecovery()
        onSuccess?.()
        setUploadState('success')
        setTimeout(() => { setOpen(false); resetState() }, 1500)
        return
      }
      if (!file) throw new Error("Select the exact same file before resuming this upload.")
      const uploadFile = file
      const initialized = await initializeVideoUpload({
        title: record.title, description: record.description || undefined, fileName: record.file.name,
        contentType: record.file.type, contentLength: record.file.size, folderId: record.folderId
      }, { headers: { "Idempotency-Key": record.idempotencyKey } })
      if (initialized.upload.kind !== "tus") throw new Error("This upload method is not supported by this browser.")

      record = { ...record, videoId: initialized.videoId }
      setPending(record)
      if (!persist(record)) throw new Error("Could not save upload recovery details.")
      const activeRecord = record
      const upload = new tus.Upload(uploadFile, {
        endpoint: initialized.upload.endpoint,
        headers: initialized.upload.headers,
        metadata: { filename: activeRecord.file.name, filetype: activeRecord.file.type },
        fingerprint: async () => activeRecord.fingerprint,
        removeFingerprintOnSuccess: true,
        retryDelays: [0, 1000, 3000, 5000],
        onProgress: (uploaded, total) => setProgress(total ? Math.round((uploaded / total) * 100) : 0),
        onError: (cause) => { setError(cause.message); setUploadState('paused') },
        onSuccess: async () => {
          setProgress(100)
          const completedRecord = { ...activeRecord, transferComplete: true }
          setPending(completedRecord)
          persist(completedRecord)
          try {
            await completeVideoUpload(completedRecord.videoId!, { idempotencyKey: completedRecord.idempotencyKey })
            clearRecovery()
            onSuccess?.()
            setUploadState('success')
            setTimeout(() => { setOpen(false); resetState() }, 1500)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Upload completed but processing acknowledgement failed.")
            setUploadState('paused')
          }
        },
      })
      uploadRef.current = upload
      const previous = await upload.findPreviousUploads()
      if (previous.length) upload.resumeFromPreviousUpload(previous[0])
      upload.start()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to initialize upload.")
      setUploadState('paused')
    }
  }

  const handleCancel = async () => {
    const record = pending
    if (!record?.videoId) {
      setError("This upload has not been confirmed by the server yet. Select the exact same file and resume before cancelling.")
      return
    }
    try {
      await uploadRef.current?.abort(false)
      setUploadState('paused')
      await cancelVideoUpload(record.videoId, { idempotencyKey: record.idempotencyKey })
      await uploadRef.current?.abort(true)
      clearRecovery()
      onSuccess?.()
      resetState()
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to cancel upload. You can resume or try cancelling again.")
    }
  }

  const needsRecoveredFile = !!pending && !pending.transferComplete && !file
  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next && (uploadState === 'uploading' || uploadState === 'paused')) return
      if (!next) resetState()
      setOpen(next)
    }}>
      <DialogTrigger asChild><Button className="gap-2 shadow-sm" data-testid="button-upload-video"><Plus className="h-4 w-4" /> Upload Video</Button></DialogTrigger>
      <DialogContent onInteractOutside={(e) => { if (uploadState === 'uploading' || uploadState === 'paused') e.preventDefault() }}>
        <form onSubmit={startUpload}>
          <DialogHeader><DialogTitle>Upload New Video</DialogTitle></DialogHeader>
          <div className="py-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="file">Video file</Label>
              <Input id="file" type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/mpeg"
                disabled={uploadState !== 'idle' && !needsRecoveredFile}
                onChange={e => {
                  const selected = e.target.files?.[0] ?? null
                  if (pending && selected && !matchesFile(selected, pending.file)) {
                    setFile(null)
                    setError("That file does not match the interrupted upload. Select the exact same file.")
                    e.currentTarget.value = ""
                    return
                  }
                  setFile(selected); setError(null)
                }} data-testid="input-file" />
              {file && <p className="text-xs text-muted-foreground">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
            </div>
            <div className="space-y-2"><Label htmlFor="title">Video Title</Label><Input id="title" value={title} disabled={uploadState !== 'idle'} onChange={e => setTitle(e.target.value)} placeholder="e.g. Q3 All Hands" autoFocus data-testid="input-title" /></div>
            <div className="space-y-2"><Label htmlFor="desc">Description (optional)</Label><Textarea id="desc" value={description} disabled={uploadState !== 'idle'} onChange={e => setDescription(e.target.value)} placeholder="What is this video about?" data-testid="input-description" /></div>
          </div>
          {(uploadState === 'uploading' || uploadState === 'paused' || uploadState === 'success') && <div className="space-y-2 mb-4 bg-muted/50 p-3 rounded-md border"><div className="text-sm font-medium flex justify-between"><span>{uploadState === 'success' ? 'Upload Complete!' : uploadState === 'paused' ? 'Upload Paused' : 'Uploading...'}</span><span>{progress}%</span></div><div className="h-2.5 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress"><div className={cn("h-full transition-all duration-300", uploadState === 'success' ? "bg-green-500" : uploadState === 'paused' ? "bg-amber-500" : "bg-primary")} style={{ width: `${progress}%` }} /></div></div>}
          {error && <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm border border-destructive/20" role="alert">{error} {uploadState === 'paused' && !needsRecoveredFile && "You can resume to retry."}</div>}
          <DialogFooter className="gap-2 sm:gap-0">
            {uploadState === 'idle' && <><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={!title || !file} data-testid="button-start-upload">Upload</Button></>}
            {(uploadState === 'uploading' || uploadState === 'paused') && <><Button type="button" variant="destructive" onClick={handleCancel} data-testid="button-cancel-upload">Cancel Upload</Button>
              {uploadState === 'uploading' && <Button type="button" variant="outline" onClick={async () => { try { await uploadRef.current?.abort(false); setUploadState('paused') } catch (cause) { setError(cause instanceof Error ? cause.message : "Failed to pause upload.") } }} data-testid="button-pause-upload">Pause</Button>}
              {uploadState === 'paused' && <Button type="button" onClick={() => void startUpload()} disabled={!file && !pending?.transferComplete} data-testid="button-resume-upload">Resume</Button>}</>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}