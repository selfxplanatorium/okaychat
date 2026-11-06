// Isolated real-provider fixture. Never imported by production code; no real keys or app database.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { register } from 'tsx/esm/api';
register();
const dir = process.env.ARENA_FIXTURE_DIR || mkdtempSync(path.join(tmpdir(), 'okaychat-arena-acceptance-'));
process.env.OKAYCHAT_DATA_DIR = dir;
process.env.OKAYCHAT_ALLOW_SIGNUP = 'true';
process.env.OKAYCHAT_SECRET = randomBytes(32).toString('hex');
const modelIds = ['arena-fixture-one', 'arena-fixture-two'];
writeFileSync(path.join(dir, 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), data: { openai: { id: 'openai', name: 'Fixture', npm: '@ai-sdk/openai-compatible', api: 'https://fixture.invalid/v1', models: Object.fromEntries(modelIds.map(id => [id, { id, name: 'PRIVATE-'+id, modalities: { input: ['text'], output: ['text'] }, limit: { context: 32000, output: 4096 }, cost: { input: 1, output: 2 } }])) } } }));
const { db } = await import('../../src/server/db.ts');
const { saveConnection } = await import('../../src/server/catalog/providers.ts');
const { hashPassword } = await import('../../src/server/crypto.ts');
let calls = [], active = 0, maxActive = 0, failure = false, missingUsage = false;
const provider = createServer(async (req, res) => {
  if (req.url === '/v1/models') return res.setHeader('content-type','application/json').end(JSON.stringify({ data: modelIds.map(id => ({ id })) }));
  if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  calls.push({ model: input.model, started: Date.now(), ended: null });
  const call = calls.at(-1); active++; maxActive = Math.max(active, maxActive);
  res.on('close', () => { call.ended = Date.now(); active--; });
  if (failure && input.model === modelIds[1]) return res.writeHead(422).end('PRIVATE-provider-error');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id:'PRIVATE-request', model:input.model, object:'chat.completion.chunk', created:1, choices:[{index:0,delta,finish_reason}], ...(usage ? {usage} : {}) })}\n\n`);
  send({ role: 'assistant', reasoning_content: 'PRIVATE-reasoning-never-display' });
  const parts = ['## A useful answer\n\n', 'Use clear criteria, ', 'compare the trade-offs, ', 'and check the result.\n\n', 'This is a streamed final answer.'];
  for (const content of parts) { await new Promise(r => setTimeout(r, 550)); if (res.destroyed) return; send({content}); }
  send({}, 'stop', missingUsage ? undefined : {prompt_tokens:10,completion_tokens:20,total_tokens:30}); res.end('data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
const providerPort = provider.address().port;
saveConnection(null,'openai',{ baseURL:`http://127.0.0.1:${providerPort}/v1`,apiKey:'test-fixture-key' });
process.env.OKAYCHAT_ARENA_PUBLIC_MODELS = JSON.stringify(modelIds.map(id => ({ref:'openai/'+id,label:'Published '+id,epoch:'acceptance-v1'})));
const password = randomBytes(18).toString('hex');
const passwordHash = await hashPassword(password);
db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES ('fixture-user','arena@example.test','Arena tester',?,'admin',1)").run(passwordHash);
db.prepare("INSERT INTO user_settings(user_id,json) VALUES ('fixture-user',?)").run(JSON.stringify({onboardingSkipped:true,locale:'en',autoTitle:false}));
db.prepare("INSERT INTO token_credit_accounts(user_id,credit_tokens,period_started_at) VALUES ('fixture-user',1000000,1)").run();
const control = createServer(async (req,res) => {
  if (req.method === 'GET' && req.url === '/state') {
    res.setHeader('content-type','application/json'); return res.end(JSON.stringify({calls,maxActive,active,roots:db.prepare('SELECT * FROM token_credit_roots').all(),usage:db.prepare('SELECT kind,input_tokens,output_tokens,arena_battle_id,arena_side FROM usage').all(),votes:db.prepare('SELECT choice FROM arena_votes').all(),dataDir:dir}));
  }
  if(req.method==='POST' && req.url==='/mode') { let raw=''; for await(const c of req) raw+=c; const input=JSON.parse(raw);failure=!!input.failure;missingUsage=!!input.missingUsage; return res.end('{}'); }
  res.writeHead(404).end();
});
await new Promise(resolve => control.listen(0,'127.0.0.1',resolve));
const port = Number(process.env.ARENA_FIXTURE_PORT || 8788);
// Run the actual compiled app: all HTTP/session/CSRF/credit/middleware paths are production paths.
const child = spawn(process.execPath,['dist/server/index.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'production'},stdio:['ignore','inherit','inherit']});
const manifest = {port,dir,controlPort:control.address().port,email:'arena@example.test',password};
writeFileSync(path.join(dir,'fixture.json'), JSON.stringify(manifest));
console.log('ARENA_FIXTURE_READY '+JSON.stringify({port,dir,controlPort:manifest.controlPort}));
process.on('SIGTERM',()=>{child.kill('SIGTERM');provider.closeAllConnections();provider.close();control.closeAllConnections();control.close();db.close();});
child.on('exit',code=>{process.exitCode=code||0;provider.closeAllConnections();provider.close();control.closeAllConnections();control.close();});
