import path from 'node:path';
import { env } from '../env.js';
export const videoFile=(userId:string,id:string)=>path.join(env.dataDir,'videos',userId,`${id}.mp4`);
export const videoStaging=(userId:string,id:string)=>path.join(env.dataDir,'video-staging',userId,id);
