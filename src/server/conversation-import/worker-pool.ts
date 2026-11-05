import { Worker } from 'node:worker_threads';
import { IMPORT_LIMITS as L, type NormalizedFile } from '../../shared/chat-import.js';
import { ImportFailure } from './json.js';

interface Entry { start: () => void; reject: (error: Error) => void }
const waiting: Entry[] = [];
const active = new Set<Worker>();
let running = 0, closed = false;
function advance(): void { while (!closed && running < 2 && waiting.length) waiting.shift()!.start(); }
function run(mode: 'parse' | 'export', bytes: Uint8Array, admissionTime: number, signal?: AbortSignal): Promise<unknown> {
  if (closed || (running >= 2 && waiting.length >= 4)) return Promise.reject(new ImportFailure('worker_capacity'));
  if (!bytes.length || bytes.length > L.inputBytes) return Promise.reject(new ImportFailure('too_large'));
  return new Promise((resolve,reject) => {
    let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort',cancel); clearTimeout(timer);
      const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index,1);
      // A slot remains occupied until termination actually completes, including OOM/timeout/cancel.
      const cleanup = worker ? worker.terminate().finally(()=> { active.delete(worker!); running--; advance(); }) : Promise.resolve();
      void cleanup.then(()=>error ? reject(error) : resolve(value));
    };
    const cancel = () => finish(new ImportFailure('cancelled'));
    const entry: Entry = { reject: (error) => finish(error), start: () => {
      running++;
      const url = new URL('./parse-worker.js',import.meta.url);
      const development = import.meta.url.endsWith('.ts');
      // tsx's explicit registration is needed inside Node workers; inherited --import alone is insufficient.
      try {
        worker = development
          ? new Worker(`import('tsx/esm/api').then(({ register }) => { register(); return import(${JSON.stringify(new URL('./parse-worker.ts',import.meta.url).href)}); }).catch(() => { process.exitCode = 1; });`,{eval:true,workerData:{mode,bytes,admissionTime},resourceLimits:{maxOldGenerationSizeMb:256,stackSizeMb:4}})
          : new Worker(url,{workerData:{mode,bytes,admissionTime},resourceLimits:{maxOldGenerationSizeMb:256,stackSizeMb:4}});
      } catch {
        running--;
        finish(new ImportFailure('internal_error'));
        advance();
        return;
      }
      active.add(worker);
      timer = setTimeout(()=>finish(new ImportFailure('validation_timeout')),L.workerTimeoutMs);
      worker.once('message',(message: {ok:boolean;value?:unknown;code?:string})=>finish(message.ok ? undefined : new ImportFailure(message.code ?? 'internal_error'),message.value));
      worker.once('error',()=>finish(new ImportFailure('internal_error')));
      worker.once('exit',()=>finish(new ImportFailure('internal_error')));
    }};
    signal?.addEventListener('abort',cancel,{once:true});
    if (signal?.aborted) cancel(); else if (running < 2) entry.start(); else waiting.push(entry);
  });
}
export function parseInWorker(bytes: Uint8Array, admissionTime: number, signal?: AbortSignal): Promise<NormalizedFile> { return run('parse',bytes,admissionTime,signal) as Promise<NormalizedFile>; }
export function serializeInWorker(bytes: Uint8Array, admissionTime: number, signal?: AbortSignal): Promise<Uint8Array> { return run('export',bytes,admissionTime,signal) as Promise<Uint8Array>; }
export async function stopImportWorkers(): Promise<void> {
  closed = true;
  for (const entry of waiting.splice(0)) entry.reject(new ImportFailure('cancelled'));
  await Promise.all([...active].map((worker)=>worker.terminate()));
}
