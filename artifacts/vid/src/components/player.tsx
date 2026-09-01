import { useRef, useId } from 'react';
import { MediaPlayer, MediaOutlet, MediaCommunitySkin } from '@vidstack/react';
import 'vidstack/styles/defaults.css';
import 'vidstack/styles/community-skin/video.css';
import type { MediaPlayerElement } from 'vidstack';

export interface PlayerProps {
  title: string;
  src?: string | { src: string; type: string } | null;
  poster?: string | null;
  accentColor?: string;
  controlForegroundColor?: string;
  controlBackgroundColor?: string;
  posterTreatment?: 'default' | 'darken' | 'gradient' | string;
  logoInitials?: string;
  load?: 'eager' | 'idle' | 'visible' | 'play' | 'custom';
  className?: string;
  status?: string;
  message?: string;
  autoPlay?: boolean;
}

export function Player({
  title,
  src,
  poster,
  accentColor = '#4f46e5',
  controlForegroundColor = '#ffffff',
  controlBackgroundColor = '#000000',
  posterTreatment = 'default',
  logoInitials,
  load = 'visible',
  className = '',
  status,
  message,
  autoPlay,
}: PlayerProps) {
  const playerRef = useRef<MediaPlayerElement>(null);
  const id = useId().replace(/:/g, '');

  const style = {
    '--video-brand': accentColor,
    '--video-controls-color': controlForegroundColor,
    '--video-bg': controlBackgroundColor,
  } as React.CSSProperties;

  const treatmentFilter = posterTreatment === 'darken'
    ? 'brightness(0.7)'
    : posterTreatment === 'gradient'
      ? 'contrast(0.8) saturate(1.2) hue-rotate(1.1)'
      : 'none';

  const LogoOverlay = () => {
    if (!logoInitials) return null;
    return (
      <div className="absolute top-4 left-4 z-50 pointer-events-none opacity-80" aria-hidden="true">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shadow-lg"
          style={{ backgroundColor: accentColor, color: controlForegroundColor }}
        >
          {logoInitials}
        </div>
      </div>
    );
  };

  if (!src && status) {
    return (
      <div
        className={`w-full aspect-video bg-black flex flex-col items-center justify-center relative overflow-hidden ${className}`}
        style={style}
        role={status === 'error' ? "alert" : "status"}
        aria-live={status === 'error' ? "assertive" : "polite"}
      >
        <div className="z-10 flex flex-col items-center p-6 text-center text-white" style={{ color: controlForegroundColor }}>
          {logoInitials && (
            <div
              className="w-16 h-16 rounded-full mb-4 flex items-center justify-center shadow-lg"
              style={{ backgroundColor: accentColor }}
            >
              <span className="text-xl font-bold">{logoInitials}</span>
            </div>
          )}
          <h2 className="text-xl font-semibold mb-2">{title}</h2>
          <p className="text-sm opacity-80">{message || `Video is ${status}`}</p>
        </div>
        {poster && (
          <div className="absolute inset-0 z-0 opacity-20">
            <img src={poster} alt="" className="w-full h-full object-cover" style={{ filter: treatmentFilter }} />
          </div>
        )}
      </div>
    );
  }

  if (!src) {
    return (
      <div className={`relative w-full aspect-video bg-black ${className}`}>
        <style>{`
          .player-wrapper-${id} media-poster img {
            filter: ${treatmentFilter} !important;
          }
        `}</style>
        <MediaPlayer
          className={`w-full aspect-video overflow-hidden player-wrapper-${id}`}
          style={style}
          title={title}
          poster={poster || undefined}
          viewType="video"
        >
          <MediaOutlet />
          <MediaCommunitySkin />
          <LogoOverlay />
        </MediaPlayer>
      </div>
    );
  }

  const mediaSrc = typeof src === 'string' ? src : (src as any);

  return (
    <div className={`relative w-full aspect-video bg-black ${className}`}>
      <style>{`
        .player-wrapper-${id} media-poster img {
          filter: ${treatmentFilter} !important;
        }
      `}</style>
      <MediaPlayer
        className={`w-full aspect-video overflow-hidden player-wrapper-${id}`}
        style={style}
        title={title}
        src={mediaSrc}
        poster={poster || undefined}
        crossOrigin
        playsInline
        autoPlay={autoPlay}
        load={load as any}
        ref={playerRef}
      >
        <MediaOutlet />
        <MediaCommunitySkin />
        <LogoOverlay />
      </MediaPlayer>
    </div>
  );
}