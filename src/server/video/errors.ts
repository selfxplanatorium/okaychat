import { AppError } from "../errors.js";
import type { ErrorCode } from "../../shared/errors.js";
import type { VideoErrorCode } from '../../shared/video.js';
/** Deliberately contains no upstream message, URL, response body, or key. */
export class VideoError extends Error {
  constructor(readonly code: VideoErrorCode, readonly status: number = 502, readonly dispatch: 'unknown'|'rejected'|'none' = 'none', readonly retryAfterMs: number | null = null, readonly completion: {billedSeconds:number|null}|null = null) {
    super(code);
    this.name = 'VideoError';
  }
}

export function videoAppError(error:VideoError):AppError {
  return new AppError({code:(`video_${error.code}`) as ErrorCode,details:{videoCode:error.code}});
}
