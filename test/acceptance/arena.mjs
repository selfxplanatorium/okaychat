// Run after npm run build and arena-fixture.mjs. Set ARENA_FIXTURE_MANIFEST and ARENA_BASE_URL.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
const fixture = JSON.parse(readFileSync(process.env.ARENA_FIXTURE_MANIFEST,'utf8'));
const base = process.env.ARENA_BASE_URL;
assert.ok(base?.startsWith('https://'), 'Use the isolated HTTPS fixture URL');
const artifacts = process.env.ARENA_ARTIFACTS || path.join(fixture.dir,'artifacts'); mkdirSync(artifacts,{recursive:true});
const cache = path.join(os.homedir(),'.cache/ms-playwright');
const installed = readdirSync(cache).filter(name=>/^chromium-/.test(name)).sort().reverse();
const executablePath = process.env.CHROMIUM_PATH || installed.flatMap(name=>[path.join(cache,name,'chrome-linux64/chrome'),path.join(cache,name,'chrome-linux/chrome')]).find(p=>existsSync(p));
const browser = await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const context = await browser.newContext({baseURL:base,viewport:{width:1280,height:900},ignoreHTTPSErrors:true});
const page = await context.newPage(); const errors=[],results=[];
const note = message => { results.push(message); console.log('PASS '+message); };
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
const json = async response => {assert.ok(response.ok(), `${response.status()} ${response.url()}`);return response.json()};
const state = async()=> (await fetch(`http://127.0.0.1:${fixture.controlPort}/state`)).json();
const mode = async value => fetch(`http://127.0.0.1:${fixture.controlPort}/mode`,{method:'POST',body:JSON.stringify(value)});
const snap = name => page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true});
const request = context.request;
const auth=await request.post('/api/auth/login',{headers:{origin:base},data:{email:fixture.email,password:fixture.password}});assert.equal(auth.status(),200);
async function runUi() {
  await page.locator('#arena-prompt').fill('Compare two options using clear criteria.');
  const started=page.waitForResponse(r=>r.url().endsWith('/api/arena/battles')&&r.request().method()==='POST');
  await page.locator('[data-command="arena.run"]').click();
  const {battle}=await json(await started); await page.waitForURL(/battle=/);return battle.id;
}
async function readyUi() {await page.waitForSelector('[data-arena-state="ready"]');}
async function apiBattle(api, choice, label) {
  const {battle}=await json(await api.post('/api/arena/battles',{headers:{origin:base},data:{mutationId:randomBytes(12).toString('hex'),mode:'public',prompt:label}}));
  const stream=await api.get(`/api/arena/battles/${battle.id}/events`);assert.equal(stream.status(),200);const text=await stream.text();assert.ok(text.includes('"canVote":true'));
  assert.doesNotMatch(text,/PRIVATE-|openai|arena-fixture/);
  await json(await api.post(`/api/arena/battles/${battle.id}/vote`,{headers:{origin:base},data:{choice}}));
  await json(await api.delete(`/api/arena/battles/${battle.id}/content`,{headers:{origin:base},data:{}}));return battle.id;
}
try {
  await page.goto('/arena');await page.locator('[data-command="arena.run"]').waitFor();
  await page.getByRole('radio',{name:'Public',exact:true}).click();
  const before=await state(),id=await runUi();
  await page.waitForSelector('[data-arena-state="running"]');
  assert.equal(await page.locator('[data-command="arena.voteA"]').isDisabled(),true);
  assert.doesNotMatch(await page.locator('main').innerHTML(),/PRIVATE-|arena-fixture|openai\//);
  await snap('blind');await readyUi();await snap('ready');
  const usage=await json(await request.get('/api/usage?groupBy=model&days=30'));
  assert.equal(usage.hiddenArenaRequests,2);assert.equal(usage.rows.length,0);
  const finished=await state();assert.equal(finished.calls.length-before.calls.length,2);assert.equal(finished.maxActive,2);assert.equal(finished.roots.length,1);assert.equal(finished.usage.length,2);
  assert.ok(finished.calls[1].started<finished.calls[0].ended);
  note('Concurrent finite-root calls; two usage rows; A/B and usage stay blind');
  await page.locator('section[tabindex="0"]').first().focus();await page.keyboard.press('Alt+Shift+3');
  await page.getByRole('heading',{name:'Models revealed'}).waitFor();assert.equal(await page.locator('#arena-reveal-heading').evaluate(e=>e===document.activeElement),true);
  assert.match(await page.locator('main').innerText(),/PRIVATE-arena-fixture/);assert.doesNotMatch(await page.locator('main').innerText(),/PRIVATE-reasoning/);await snap('reveal');
  const duplicate=await Promise.all([request.post(`/api/arena/battles/${id}/vote`,{headers:{origin:base},data:{choice:'tie'}}),request.post(`/api/arena/battles/${id}/vote`,{headers:{origin:base},data:{choice:'tie'}})]);assert.ok(duplicate.every(r=>r.status()===200));
  assert.equal((await state()).votes.length,1);await page.reload();await page.getByRole('heading',{name:'Models revealed'}).waitFor();assert.equal((await state()).calls.length,2);
  note('Keyboard vote, focus, immutable duplicate replay, reveal and reload without redispatch');
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
  const close=page.getByRole('button',{name:'Close sidebar',exact:true});if(await close.isVisible())await close.click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const boxes=await page.locator('section[tabindex="0"]').evaluateAll(es=>es.map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y})));
  assert.equal(boxes[0].x,boxes[1].x);assert.ok(boxes[1].y>boxes[0].y);
  assert.ok(await page.locator('[data-arena-state]').evaluate(root=>[...root.querySelectorAll('*')].some(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight&&getComputedStyle(e).overflowY==='auto')));
  await snap('mobile-reduced-motion');note('390px stacked panes and reveal remain scrollable without overflow');
  await page.locator('[data-command="arena.next"]').click();await page.locator('#arena-prompt:focus').waitFor();
  await runUi();await readyUi();await page.locator('[data-command="arena.voteBothBad"]').click();await page.getByRole('heading',{name:'Models revealed'}).waitFor();
  note('Next focuses editable setup, never auto-runs; Both bad commits and reveals');
  // Populate ranking through real authenticated APIs, with separate fixture accounts to respect 20 writes/min/account.
  for(let account=0;account<6;account++){
    const ctx=await browser.newContext({baseURL:base,ignoreHTTPSErrors:true});
    try{
      const response=await ctx.request.post('/api/auth/signup',{headers:{origin:base},data:{email:`arena-${account}@example.test`,name:`Arena tester ${account}`,password:randomBytes(18).toString('hex')}});
      assert.equal(response.status(),200);
      for(let i=0;i<3;i++)await apiBattle(ctx.request,i%2?'both_bad':'tie',`Private fixture prompt ${account}-${i}`);
    }finally{await ctx.close()}
    note(`Authorized public ballot group ${account+1}/6`);
  }
  const ranked=await json(await request.get('/api/public/arena/leaderboard'));assert.equal(ranked.rows.length,2);assert.ok(ranked.rows.every(r=>r.battles>=20&&!r.provisional&&r.rank!==null));
  assert.doesNotMatch(JSON.stringify(ranked),/PRIVATE-|Private fixture prompt|arena@example|openai\/|http:/);
  const anon=await browser.newContext({baseURL:base,ignoreHTTPSErrors:true,viewport:{width:390,height:844}});const publicPage=await anon.newPage();const publicApi=[];
  publicPage.on('request',r=>{if(r.url().includes('/api/'))publicApi.push(new URL(r.url()).pathname)});
  await publicPage.goto('/arena/leaderboard');await publicPage.locator('tbody tr').first().waitFor();assert.ok(publicApi.every(p=>p==='/api/public/arena/leaderboard'));
  await publicPage.screenshot({path:path.join(artifacts,'public-mobile.png'),fullPage:true});await anon.close();note('20 real ballots produce ranks; anonymous board requests aggregate API only');
  // Existing fixture primary has 4 writes so far: failure/Stop checks remain inside its mutation budget.
  await page.locator('[data-command="arena.next"]').click();await mode({failure:true});await runUi();await page.waitForSelector('[data-arena-state="failed"]');assert.equal(await page.locator('[data-command="arena.voteA"]').isDisabled(),true);assert.doesNotMatch(await page.locator('main').innerText(),/PRIVATE-provider-error/);
  await mode({});await page.locator('[data-command="arena.next"]').click();await runUi();await page.locator('[data-command="arena.stop"]').click();await page.waitForSelector('[data-arena-state="cancelled"]');assert.equal(await page.locator('[data-command="arena.voteA"]').isDisabled(),true);note('Forced provider failure and Stop are controlled, unvoteable terminal states');
  const balance = await json(await request.get('/api/credits'));
  await json(await request.post('/api/admin/users/fixture-user/credits/reset',{headers:{origin:base},data:{expectedVersion:balance.version,mutationId:randomUUID(),reason:'Fixture reset after cancellation',acknowledgeUnknown:true}}));
  await page.locator('[data-command="arena.next"]').click();
  for(const locale of ['fr','it','pt-PT','de','es','en']){
    await json(await request.patch('/api/settings',{headers:{origin:base},data:{locale}}));await page.reload();await page.locator('#arena-prompt').waitFor();assert.doesNotMatch(await page.locator('main').innerText(),/arena\.[a-zA-Z]/);
  }
  note('All six shipped Arena locales load without missing keys');
  await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>document.documentElement.style.zoom='2');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await snap('zoom-200');
  assert.deepEqual(errors,[]);note('200% zoom and zero unexpected console/page errors');
  writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:true,results,errors,providerCalls:(await state()).calls.length},null,2));
  console.log('ARTIFACTS '+artifacts);
} finally {await context.close();await browser.close();}
