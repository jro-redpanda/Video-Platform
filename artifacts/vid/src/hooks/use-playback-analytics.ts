import { useEffect, useRef, useCallback } from 'react';
import { createPlaybackEvents, PublicVideo, PlaybackEventInput, PlaybackEventBatch } from '@workspace/api-client-react';

const MAX_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 500;
const QUEUE_PREFIX = 'vid_analytics_v3_';

// Migrate safely by dropping the old unowned and aggregate queues once
try {
  localStorage.removeItem('vid_playback_analytics_queue');
  localStorage.removeItem('vid_analytics_queues_v2');
} catch (e) {
  // ignore
}

function getEventKey(videoId: string, eventId: string): string {
  return `${QUEUE_PREFIX}${videoId}_${eventId}`;
}

function getQueue(videoId: string): PlaybackEventInput[] {
  const queue: PlaybackEventInput[] = [];
  const prefix = `${QUEUE_PREFIX}${videoId}_`;

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        const item = localStorage.getItem(key);
        if (item) {
          try {
            const event = JSON.parse(item) as PlaybackEventInput;
            queue.push(event);
          } catch (e) {
            // ignore bad JSON
          }
        }
      }
    }
  } catch (e) {
    // ignore localStorage errors
  }

  // Sort by occurredAt so oldest is first
  return queue.sort((a, b) => {
    const timeA = new Date(a.occurredAt).getTime();
    const timeB = new Date(b.occurredAt).getTime();
    if (timeA === timeB) return a.eventId.localeCompare(b.eventId);
    return timeA - timeB;
  });
}

function addToQueue(videoId: string, event: PlaybackEventInput) {
  const key = getEventKey(videoId, event.eventId);
  try {
    localStorage.setItem(key, JSON.stringify(event));
  } catch (e) {
    // Quota exceeded or disabled, silently degrade
    return;
  }

  // Bound the queue to MAX_QUEUE_SIZE
  const queue = getQueue(videoId);
  if (queue.length > MAX_QUEUE_SIZE) {
    const toDelete = queue.length - MAX_QUEUE_SIZE;
    for (let i = 0; i < toDelete; i++) {
      try {
        localStorage.removeItem(getEventKey(videoId, queue[i].eventId));
      } catch (e) {
        // ignore
      }
    }
  }
}

function removeFromQueue(videoId: string, eventIds: string[]) {
  for (const eventId of eventIds) {
    try {
      localStorage.removeItem(getEventKey(videoId, eventId));
    } catch (e) {
      // ignore
    }
  }
}

interface UsePlaybackAnalyticsOptions {
  video: PublicVideo | undefined | null;
  sessionId: string;
  refetchVideo: () => void;
}

export function usePlaybackAnalytics({ video, sessionId, refetchVideo }: UsePlaybackAnalyticsOptions) {
  const flushTimeoutRef = useRef<number | null>(null);
  const isFlushingRef = useRef(false);
  const retryAfterRef = useRef<number>(0);
  const videoRef = useRef(video);
  videoRef.current = video;

  const flushQueue = useCallback(async () => {
    if (isFlushingRef.current) return;
    const currentVideo = videoRef.current;
    if (!currentVideo || !currentVideo.analyticsGrant) return;

    // Check if grant is expired
    if (currentVideo.analyticsGrantExpiresAt) {
      const expiresAt = new Date(currentVideo.analyticsGrantExpiresAt).getTime();
      if (Date.now() >= expiresAt) {
        refetchVideo();
        return; // Will flush when new video data comes in
      }
    }

    if (Date.now() < retryAfterRef.current) return;

    const queue = getQueue(currentVideo.id);
    if (queue.length === 0) return;

    const batchEvents = queue.slice(0, MAX_BATCH_SIZE);
    const batch: PlaybackEventBatch = {
      grant: currentVideo.analyticsGrant,
      events: batchEvents,
    };

    try {
      isFlushingRef.current = true;
      const response = await createPlaybackEvents(batch);
      
      removeFromQueue(currentVideo.id, batchEvents.map(e => e.eventId));
      
      const remaining = getQueue(currentVideo.id);
      if (remaining.length > 0) {
        scheduleFlush(100);
      }
    } catch (error: any) {
      if (error?.status === 429 || error?.status >= 500) {
        const retryAfterHeader = error?.headers?.get('Retry-After');
        let delay = 5000;
        if (retryAfterHeader) {
          const parsed = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsed)) {
            delay = parsed * 1000;
          } else {
            delay = new Date(retryAfterHeader).getTime() - Date.now();
          }
        }
        retryAfterRef.current = Date.now() + Math.max(delay, 1000);
      } else if (error?.status === 409) {
        // Collision is terminal, drop the whole batch.
        // Or if we can't tell which one collided, just drop all to avoid loops.
        removeFromQueue(currentVideo.id, batchEvents.map(e => e.eventId));
      } else if (error?.status === 401 || error?.status === 403) {
        // Grant might be invalid, trigger refetch
        refetchVideo();
      }
    } finally {
      isFlushingRef.current = false;
    }
  }, [refetchVideo]);

  const scheduleFlush = useCallback((delayMs = 1000) => {
    if (flushTimeoutRef.current) {
      window.clearTimeout(flushTimeoutRef.current);
    }
    flushTimeoutRef.current = window.setTimeout(flushQueue, delayMs);
  }, [flushQueue]);

  const emitEvent = useCallback((
    type: PlaybackEventInput['type'],
    options?: { positionSeconds?: number; durationSeconds?: number; errorCategory?: PlaybackEventInput['errorCategory'] }
  ) => {
    const currentVideo = videoRef.current;
    if (!currentVideo) return;

    let eventId = '';
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      eventId = crypto.randomUUID();
    } else {
      // Fallback valid UUID v4 generator
      eventId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    const event: PlaybackEventInput = {
      eventId,
      sessionId,
      type,
      occurredAt: new Date().toISOString(),
      ...(options?.positionSeconds !== undefined && { positionSeconds: Math.min(Math.max(options.positionSeconds, 0), 86400) }),
      ...(options?.durationSeconds !== undefined && { durationSeconds: Math.min(Math.max(options.durationSeconds, 0), 86400) }),
      ...(options?.errorCategory && { errorCategory: options.errorCategory }),
    };

    addToQueue(currentVideo.id, event);

    // Immediate flush for certain events
    if (type === 'pause' || type === 'ended' || type === 'error') {
      scheduleFlush(0);
    } else {
      scheduleFlush(2000);
    }
  }, [sessionId, scheduleFlush]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushQueue(); // Try to flush synchronously if possible
      }
    };

    const handlePageHide = () => {
      flushQueue(); // Try to flush
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      if (flushTimeoutRef.current) {
        window.clearTimeout(flushTimeoutRef.current);
      }
    };
  }, [flushQueue]);

  return {
    emitEvent,
    flushQueue,
  };
}
