import type { VideoErrorCode } from '../../shared/video.js';
/** Deliberately contains no upstream message, URL, response body, or key. */
export class VideoError extends Error {
  constructor(readonly code: VideoErrorCode, readonly status: number = 502, readonly dispatch: 'unknown'|'rejected'|'none' = 'none', readonly retryAfterMs: number | null = null, readonly completion: {billedSeconds:number|null}|null = null) {
    super(code);
    this.name = 'VideoError';
  }
}
