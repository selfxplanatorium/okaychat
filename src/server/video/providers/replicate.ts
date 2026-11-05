import { assertVideoParameters } from '../services.js';
import { VideoError } from '../errors.js';
import { downloadDescriptor, object, providerId, videoJson, type VideoFetch } from '../transport.js';
import { referenceData, type VideoProvider, type VideoProviderStatus } from './types.js';
function status(value: unknown, model: string): VideoProviderStatus {
  const r = object(value);
  if (r.model !== undefined && r.model !== model) throw new VideoError('provider_protocol');
  switch (r.status) {
    case 'starting': return {state:'queued'};
    case 'processing': return {state:'running'};
    case 'failed': return {state:'failed'};
    case 'canceled': return {state:'cancelled'};
    case 'succeeded': return {state:'succeeded',output:downloadDescriptor('replicate',r.output),billedSeconds:null};
    default: throw new VideoError('provider_protocol');
  }
}
export function replicateVideo(transport: VideoFetch = fetch): VideoProvider {
  return {
    service:'replicate',
    async submit(key,input,signal) {
      assertVideoParameters('replicate',input.model,input.parameters);
      const image = referenceData(input);
      const p = input.parameters;
      const result = await videoJson('replicate','/models/google/veo-3.1-fast/predictions',key,'POST',{input:{prompt:input.prompt,duration:p.durationSeconds,aspect_ratio:p.aspectRatio,resolution:p.size,generate_audio:true,...(image ? {image} : {})}},signal,transport,false,201);
      // Commit this id before interpreting terminal output or polling, even for immediate success.
      try { return {id:providerId(object(result).id)}; } catch { throw new VideoError('provider_protocol',502,'unknown'); }
    },
    async poll(key,id,model,signal) {
      return status(await videoJson('replicate',`/predictions/${providerId(id)}`,key,'GET',undefined,signal,transport),model);
    },
    async cancel(key,id,signal) {
      const result = object(await videoJson('replicate',`/predictions/${providerId(id)}/cancel`,key,'POST',undefined,signal,transport,true));
      return result.status === 'canceled' ? 'confirmed' : 'unconfirmed';
    },
  };
}
