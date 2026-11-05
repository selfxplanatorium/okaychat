import type { ToolPolicy, ResolvedRunConfig } from '../../shared/assistant-presets.js';
import { db } from '../db.js';
import { resolveAssistantForTurn } from '../assistant-presets.js';
import { assistantAllowsFamily } from '../assistant-policy.js';
import { resolveModel } from '../catalog/providers.js';
import { assertFeature, assertModelAllowed } from '../permissions/guard.js';
import { isRestrictedKnowledgeThread } from '../knowledge/thread-policy.js';
import { voiceCallRegistry } from '../voice/routes.js';
import { AppError } from '../errors.js';
import { getSettings } from '../settings.js';
import { videoServiceStatuses } from './services.js';
import type { VideoServiceId } from '../../shared/video.js';

export interface VideoTurnContext {
  userId:string;threadId:string;assistantMessageId:string;getRunId:()=>string|null;
  modelRef:string;toolCallModel:boolean;toolPolicy:ToolPolicy;
  interactive:boolean;unattended:boolean;turnOrigin:string|undefined;temporary:boolean;restrictedChat:boolean;comparison:boolean;
}
export const videoModeEligible=(c:VideoTurnContext):boolean=>c.interactive===true && c.unattended!==true && c.turnOrigin==='interactive' && !c.temporary && !c.threadId.startsWith('tmp_') && !c.restrictedChat && !c.comparison && c.toolCallModel && assistantAllowsFamily(c.toolPolicy,'videos');
export interface VideoEligibilityDependencies {
  model:(userId:string,ref:string)=>Promise<{toolCall:boolean}>;
  voice:(userId:string)=>boolean;
}
export const videoVoiceActive=(user:string):boolean=>{const call=voiceCallRegistry.get(user);return !!call&&!call.ended;};
const live:VideoEligibilityDependencies={model:async(user,ref)=>(await resolveModel(user,ref)).model,voice:videoVoiceActive};
const notEligible=()=>new AppError({code:'conflict',message:'Video generation is not available in this chat.',details:{reason:'video_not_eligible'}});
/** Synchronous recheck closes changes while the live model lookup awaited. This is also admission's transaction guard. */
export function assertVideoTurn(context:VideoTurnContext,service:VideoServiceId,deps:VideoEligibilityDependencies=live):void {
  const c=context;
  if(!videoModeEligible(c)||deps.voice(c.userId))throw notEligible();
  assertFeature({userId:c.userId,modelRef:c.modelRef},'videos');assertModelAllowed(c.userId,c.modelRef);
  const thread=db.prepare('SELECT compare_group_id FROM threads WHERE id=? AND user_id=?').get(c.threadId,c.userId);
  if(!thread || thread.compare_group_id!==null || isRestrictedKnowledgeThread(c.threadId))throw notEligible();
  const current=resolveAssistantForTurn(c.userId,c.threadId).snapshot;
  if(!assistantAllowsFamily(current?.tools??{mode:'inherit',builtins:[],mcpTools:[]},'videos'))throw notEligible();
  const runId=c.getRunId();
  const run=runId?db.prepare('SELECT config_json FROM generation_runs WHERE id=? AND thread_id=? AND assistant_message_id=?').get(runId,c.threadId,c.assistantMessageId):undefined;
  if(!run)throw notEligible();
  const config=JSON.parse(String(run.config_json)) as ResolvedRunConfig;
  if(config.turnOrigin!=='interactive' || config.modelRef!==c.modelRef || !assistantAllowsFamily(config.toolPolicy,'videos'))throw notEligible();
  const status=videoServiceStatuses(c.userId,getSettings(c.userId).videoServices??{}).find(s=>s.id===service);
  if(!status?.enabled)throw notEligible();
}
export async function checkVideoTurn(c:VideoTurnContext,service:VideoServiceId,deps:VideoEligibilityDependencies=live):Promise<()=>void> {
  assertVideoTurn(c,service,deps);
  const model=await deps.model(c.userId,c.modelRef);
  if(!model.toolCall)throw notEligible();
  assertVideoTurn(c,service,deps);
  return ()=>assertVideoTurn(c,service,deps);
}
