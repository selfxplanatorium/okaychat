/** Private generated-video contracts; no vendor URLs or credentials in public DTOs. */
export type VideoServiceId = 'xai' | 'replicate';
export type VideoSize = '720p' | '1080p';
export type VideoAspect = '16:9' | '9:16';
export type VideoDuration = 4 | 6 | 8;
export type VideoJobState = 'queued' | 'submitting' | 'polling' | 'downloading' |
  'validating' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' |
  'timed_out' | 'submission_unknown';
export type VideoErrorCode = 'invalid_reference' | 'reference_aspect_mismatch' |
  'unsupported_parameters' | 'unsupported_endpoint' | 'service_unavailable' |
  'video_busy' | 'video_rate_limit' | 'credentials_changed' | 'provider_auth' |
  'provider_rate_limit' | 'provider_unavailable' | 'provider_rejected' |
  'provider_protocol' | 'provider_moderation' | 'provider_failed' |
  'provider_output_expired' | 'output_host_rejected' | 'output_too_large' |
  'output_invalid' | 'download_failed' | 'storage_failed' |
  'job_timeout' | 'submission_unknown' | 'cancelled';
export interface VideoOutput {
  id: string; mime: 'video/mp4'; size: number; durationMs: number;
  width: number; height: number; hasAudio: boolean;
  fileUrl: string; downloadUrl: string; posterUrl: null;
}
export interface VideoJobView {
  id: string; threadId: string | null; assistantMessageId: string;
  toolCallId: string; attempt: number; retryOf: string | null;
  service: VideoServiceId; model: string; state: VideoJobState; stage: VideoStage;
  revision: number; createdAt: number; updatedAt: number; finishedAt: number | null;
  request: { durationSeconds: VideoDuration; aspectRatio: VideoAspect; size: VideoSize };
  cost: { currency: 'USD'; estimatedMicrousd: number;
    settledMicrousd: number | null; state: 'unknown'|'estimated'|'reported' };
  error: { code: VideoErrorCode; retryable: boolean; mayHaveCharged: boolean } | null;
  remoteCancellation: 'not_requested'|'unsupported'|'confirmed'|'unconfirmed';
  output: VideoOutput | null; outputUnavailable: boolean; canRetry: boolean;
}
export type VideoStage = 'accepted'|'submitting'|'queued_at_provider'|'generating'|'downloading'|'checking'|'complete'|'stopping'|'stopped'|'error';
export type VideoSettings = Partial<Record<VideoServiceId, {
  enabled?: boolean; model?: string; durationSeconds?: VideoDuration; aspectRatio?: VideoAspect; size?: VideoSize;
}>>;
export interface VideoParameters {
  durationSeconds: VideoDuration; aspectRatio: VideoAspect; size: VideoSize; audio: true; hasReference: boolean;
}
export interface VideoPrice {
  priceVersion: '2026-11-05'; currency: 'USD'; basis: 'output_second';
  ratesByResolution: Record<VideoSize, number>;
  referenceImageUsd: number; audio: true; sourceUrl: string;
}
export interface VideoModelDefinition {
  id: string; durations: readonly VideoDuration[]; referenceDurations: readonly VideoDuration[];
  sizes: readonly VideoSize[]; aspects: readonly VideoAspect[]; upscaled1080p: boolean; price: VideoPrice;
}
export interface VideoServiceDefinition {
  id: VideoServiceId; name: string; connectionId: 'xai'|'image-replicate'; baseURL: string;
  verifiedAt: '2026-11-05'; models: readonly VideoModelDefinition[];
}
export interface VideoServiceStatus {
  id: VideoServiceId; name: string; connected: boolean; enabled: boolean; requiresOwnKey: boolean;
  unavailableReason: 'own_key_required'|'connection_disabled'|'unsupported_endpoint'|'unsupported_parameters'|null;
  model: string; models: readonly VideoModelDefinition[];
  defaults: {durationSeconds: VideoDuration; aspectRatio: VideoAspect; size: VideoSize};
}
export interface VideoAcceptedResult {
  version: 1; jobId: string; accepted: true; state: 'queued'; service: VideoServiceId; model: string;
}
export const VIDEO_LIMITS = {
  outputBytes: 64 * 1024 * 1024, referenceBytes: 256 * 1024, receiptBytes: 32 * 1024,
  jsonBytes: 1024 * 1024, deadlineMs: 480_000, leaseMs: 45_000, maxMetadataBytes: 4 * 1024 * 1024,
  maxBoxes: 10_000, maxTableEntries: 10_000,
} as const;
const model = (id: string, rate720: number, rate1080: number, reference: number, sourceUrl: string, upscaled1080p = false, referenceDurations: readonly VideoDuration[] = [4,6,8]): VideoModelDefinition => ({
  id, durations: [4,6,8], referenceDurations, sizes: ['720p','1080p'], aspects: ['16:9','9:16'], upscaled1080p,
  price: {priceVersion:'2026-11-05',currency:'USD',basis:'output_second',ratesByResolution:{'720p':rate720,'1080p':rate1080},referenceImageUsd:reference,audio:true,sourceUrl},
});
export const VIDEO_SERVICES: readonly VideoServiceDefinition[] = [
  {id:'xai',name:'xAI',connectionId:'xai',baseURL:'https://api.x.ai/v1',verifiedAt:'2026-11-05',models:[
    model('grok-imagine-video-1.5-lite',0.03,0.14,0.01,'https://docs.x.ai/developers/pricing',true),
    model('grok-imagine-video-1.5',0.14,0.25,0.01,'https://docs.x.ai/developers/pricing'),
  ]},
  {id:'replicate',name:'Replicate',connectionId:'image-replicate',baseURL:'https://api.replicate.com/v1',verifiedAt:'2026-11-05',models:[
    model('google/veo-3.1-fast',0.15,0.15,0,'https://replicate.com/google/veo-3.1-fast',false,[8]),
  ]},
];
export function videoService(id: VideoServiceId): VideoServiceDefinition {
  return VIDEO_SERVICES.find(s => s.id === id)!;
}
export function supportsVideo(model: VideoModelDefinition, p: VideoParameters): boolean {
  return model.durations.includes(p.durationSeconds) && (!p.hasReference || model.referenceDurations.includes(p.durationSeconds)) && model.sizes.includes(p.size) && model.aspects.includes(p.aspectRatio) && p.audio === true;
}
export function videoEstimateMicrousd(price: VideoPrice, p: VideoParameters, billedSeconds = p.durationSeconds): number {
  if (!Number.isFinite(billedSeconds) || billedSeconds <= 0 || billedSeconds > 15) throw new Error('Invalid billed duration');
  return Math.round((billedSeconds * price.ratesByResolution[p.size] + (p.hasReference ? price.referenceImageUsd : 0)) * 1_000_000);
}
