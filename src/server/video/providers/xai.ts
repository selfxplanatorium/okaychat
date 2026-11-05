import { assertVideoParameters } from '../services.js';
import { VideoError } from '../errors.js';
import { downloadDescriptor, object, providerId, videoJson, type VideoFetch } from '../transport.js';
import { referenceData, type VideoProvider } from './types.js';
export function xaiVideo(transport: VideoFetch = fetch): VideoProvider {
  return {
    service:'xai',
    async submit(key,input,signal) {
      assertVideoParameters('xai',input.model,input.parameters);
      const image = referenceData(input);
      const p = input.parameters;
      const body = {model:input.model,prompt:input.prompt,duration:p.durationSeconds,aspect_ratio:p.aspectRatio,resolution:p.size,generate_audio:true,...(image ? {image:{url:image}} : {})};
      const result = await videoJson('xai','/videos/generations',key,'POST',body,signal,transport);
      try { return {id:providerId(object(result).request_id)}; } catch { throw new VideoError('provider_protocol',502,'unknown'); }
    },
    async poll(key,id,model,signal) {
      const result = object(await videoJson('xai',`/videos/${providerId(id)}`,key,'GET',undefined,signal,transport));
      if (result.model !== undefined && result.model !== model) throw new VideoError('provider_protocol');
      if (result.status === 'pending') return {state:'running'};
      if (result.status === 'failed') return {state:'failed'};
      if (result.status !== 'done') throw new VideoError('provider_protocol');
      const video = object(result.video);
      if (video.respect_moderation === false) throw new VideoError('provider_moderation',422);
      if (typeof video.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 15) throw new VideoError('provider_protocol');
      return {state:'succeeded',output:downloadDescriptor('xai',video.url),billedSeconds:video.duration};
    },
    async cancel() { return 'unsupported'; },
  };
}
