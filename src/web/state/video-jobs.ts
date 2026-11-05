import { api } from '@/lib/api';
import { VideoJobClient, type VideoEventConnection } from './video-job-client';
import type { VideoJobView } from '@shared/video';

export const videoJobs=new VideoJobClient({
  get:(id,signal)=>api<VideoJobView>(`/video-jobs/${encodeURIComponent(id)}`,{signal}),
  connect:id=>{
    const source=new EventSource(`/api/video-jobs/${encodeURIComponent(id)}/events`);
    const connection:VideoEventConnection={close:()=>source.close(),onmessage:null,onerror:null};
    source.addEventListener('video-job',event=>connection.onmessage?.((event as MessageEvent<string>).data));
    source.onerror=()=>connection.onerror?.();
    return connection;
  },
  later:work=>{const timer=setTimeout(work,5000);return()=>clearTimeout(timer);},
});
export const setVideoAccount=(userId:string|null)=>videoJobs.setAccount(userId);
