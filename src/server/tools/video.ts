import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { VideoAcceptedResult, VideoServiceStatus } from '../../shared/video.js';
import { videoService } from '../../shared/video.js';
import { getSettings } from '../settings.js';
import { riskMetadata } from '../prompt-injection.js';
import { AppError } from '../errors.js';
import { videoAppError, VideoError } from '../video/errors.js';
import { db } from '../db.js';
import { admitVideo } from '../video/store.js';
import { checkVideoTurn, type VideoTurnContext, type VideoEligibilityDependencies } from '../video/eligibility.js';

const prompt=z.string().refine(s=>!!s.trim()&&[...s].length<=4000&&Buffer.byteLength(s)<=16384,'Invalid video prompt');
const base={prompt,reference_image_id:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),duration_seconds:z.union([z.literal(4),z.literal(6),z.literal(8)]).optional(),aspect_ratio:z.enum(['16:9','9:16']).optional(),size:z.enum(['720p','1080p']).optional()};
/** Input schema is built from server-resolved services, never from client tools/settings payloads. */
export function videoTools(context:VideoTurnContext,services:VideoServiceStatus[],dependencies?:VideoEligibilityDependencies):ToolSet {
  if(!services.length)return {};
  const ids=services.map(s=>s.id) as ['xai'|'replicate',...Array<'xai'|'replicate'>];
  const inputSchema=services.length===1?z.object(base).strict():z.object({...base,service:z.enum(ids)}).strict();
  const description='Start one paid video generation. Pass the user’s request verbatim or with light cleanup only; do not invent subjects, style, composition, lighting, colors, text or other details unless explicitly asked. A vague prompt is valid. Defaults are used exactly when omitted. The result means started, never finished: completion appears in the video card without another assistant message. No automatic retries or service fallback. '+
    services.map(s=>`${s.id}: ${s.model}; 4/6/8 seconds, 16:9/9:16, 720p/1080p; defaults ${s.defaults.durationSeconds}s ${s.defaults.aspectRatio} ${s.defaults.size}; starting image must be an owned upload with matching ratio (within 1%); ${s.id==='replicate'?'starting images require 8 seconds; ':''}USD estimates per output second, with any starting-image fee once: ${JSON.stringify(videoService(s.id).models.find(m=>m.id===s.model)!.price)}.`).join('\n')+
    (services.length>1?' Ask the user which service before the first generation unless they named one; wait for the answer, never select a paid service yourself. Keep their choice until asked to change.':'');
  return {generate_video:tool({
    description,inputSchema,metadata:riskMetadata('outbound'),
    execute:async(args,options)=>{
      const requested=services.length===1?services[0]!.id:'service' in args?args.service:undefined;
      const service=requested==='xai'||requested==='replicate'?requested:undefined;
      if(!service)throw new AppError({code:'validation'});
      try{
        const replay=db.prepare('SELECT id,service,model_id FROM video_jobs WHERE user_id=? AND thread_id=? AND assistant_message_id=? AND tool_call_id=? AND attempt=0').get(context.userId,context.threadId,context.assistantMessageId,options.toolCallId) as {id:string;service:'xai'|'replicate';model_id:string}|undefined;
        if(replay)return {version:1,jobId:replay.id,accepted:true,state:'queued',service:replay.service,model:replay.model_id} satisfies VideoAcceptedResult;
        const authorize=await checkVideoTurn(context,service,dependencies);
        const current=getSettings(context.userId).videoServices?.[service];
        const offered=services.find(s=>s.id===service)!;
        // Revalidate the exact offered model; a settings edit cannot silently redirect a paid call.
        if((current?.model??videoService(service).models[0]!.id)!==offered.model)throw new VideoError('credentials_changed',403);
        const row=admitVideo({userId:context.userId,threadId:context.threadId,llmRunId:context.getRunId()!,assistantMessageId:context.assistantMessageId,toolCallId:options.toolCallId,service,model:offered.model,authorize,request:{prompt:args.prompt,referenceUploadId:args.reference_image_id,durationSeconds:args.duration_seconds??offered.defaults.durationSeconds,aspectRatio:args.aspect_ratio??offered.defaults.aspectRatio,size:args.size??offered.defaults.size,audio:true}});
        return {version:1,jobId:row.id,accepted:true,state:'queued',service:row.service,model:row.model_id} satisfies VideoAcceptedResult;
      }catch(error){throw error instanceof VideoError?videoAppError(error):error;}
    },
    toModelOutput:({output})=>({type:'text',value:`Video generation started (accepted job ${output.jobId}). Completion will appear in the card. Do not say the video is finished.`}),
  })};
}
