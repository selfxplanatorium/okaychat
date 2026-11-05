import { createHash } from 'node:crypto';
import { getOwnConnection } from '../catalog/providers.js';
import type { Connection } from '../catalog/providers.js';
import { VIDEO_SERVICES, supportsVideo, videoService } from '../../shared/video.js';
import type { VideoParameters, VideoServiceId, VideoSettings, VideoServiceStatus } from '../../shared/video.js';
import { VideoError } from './errors.js';

export function videoCredential(userId: string, service: VideoServiceId, expectedFingerprint?: string) {
  const def = videoService(service);
  const conn = getOwnConnection(userId, def.connectionId);
  return resolveVideoCredential(service, conn, expectedFingerprint);
}
/** Pure seam used by transport/recovery tests; production always supplies an own connection. */
export function resolveVideoCredential(service: VideoServiceId, conn: Connection | undefined, expectedFingerprint?: string) {
  const def = videoService(service);
  if (!conn || conn.shared || conn.providerId !== def.connectionId || !conn.enabled || !conn.apiKey) throw new VideoError('credentials_changed',403);
  if (conn.baseURL !== undefined && conn.baseURL !== def.baseURL) throw new VideoError('unsupported_endpoint',400);
  const fingerprint = createHash('sha256').update(JSON.stringify([conn.providerId,def.baseURL,createHash('sha256').update(conn.apiKey).digest('hex')])).digest('hex');
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) throw new VideoError('credentials_changed',403);
  return {connectionId:def.connectionId, fingerprint, apiKey:conn.apiKey};
}
export function videoServiceStatuses(userId: string, settings: VideoSettings): VideoServiceStatus[] {
  return VIDEO_SERVICES.map(def => {
    const s = settings[def.id];
    const conn = getOwnConnection(userId,def.connectionId);
    const chosen = s?.model ?? def.models[0]!.id;
    const model = def.models.find(m => m.id === chosen);
    const defaults = {durationSeconds:s?.durationSeconds ?? 8,aspectRatio:s?.aspectRatio ?? '16:9',size:s?.size ?? '720p'} as const;
    const unavailableReason = !conn?.apiKey ? 'own_key_required' : !conn.enabled ? 'connection_disabled' : conn.baseURL !== undefined && conn.baseURL !== def.baseURL ? 'unsupported_endpoint' : !model || !supportsVideo(model,{...defaults,audio:true,hasReference:false}) ? 'unsupported_parameters' : null;
    return {id:def.id,name:def.name,connected:!!conn?.apiKey,enabled:s?.enabled === true && unavailableReason === null,requiresOwnKey:!conn?.apiKey,unavailableReason,model:chosen,models:def.models,defaults};
  });
}
export function assertVideoParameters(service: VideoServiceId, modelId: string, p: VideoParameters): void {
  const model = videoService(service).models.find(m => m.id === modelId);
  if (!model || !supportsVideo(model,p)) throw new VideoError('unsupported_parameters',400);
}
