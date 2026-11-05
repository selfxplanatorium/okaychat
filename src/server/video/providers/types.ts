import { VideoError } from '../errors.js';
import type { VideoParameters, VideoServiceId } from '../../../shared/video.js';
import type { VideoDownloadDescriptor } from '../transport.js';
export interface VideoSubmitInput {
  model: string; prompt: string; parameters: VideoParameters; referenceJpeg?: Buffer;
}
export type VideoProviderStatus =
  | {state:'queued'|'running'}
  | {state:'succeeded'; output:VideoDownloadDescriptor; billedSeconds:number|null}
  | {state:'failed'|'cancelled'};
export interface VideoProvider {
  service: VideoServiceId;
  submit(key:string,input:VideoSubmitInput,signal?:AbortSignal):Promise<{id:string}>;
  poll(key:string,id:string,model:string,signal?:AbortSignal):Promise<VideoProviderStatus>;
  cancel(key:string,id:string,signal?:AbortSignal):Promise<'unsupported'|'confirmed'|'unconfirmed'>;
}
export function referenceData(input: VideoSubmitInput): string | undefined {
  if (!input.prompt.trim() || [...input.prompt].length > 4000 || Buffer.byteLength(input.prompt,'utf8') > 16384) throw new VideoError('unsupported_parameters',400);
  const bytes = input.referenceJpeg;
  if (!!bytes !== input.parameters.hasReference || bytes && (bytes.length > 256 * 1024 || bytes.length < 3 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255)) throw new VideoError('invalid_reference',400);
  return bytes ? `data:image/jpeg;base64,${bytes.toString('base64')}` : undefined;
}
