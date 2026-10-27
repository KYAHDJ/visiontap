'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SiteRecovery } = require('./site-recovery');
const work = 'https://ecnlmediamarket.com/solving-colors';
function setup(t, online) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'vt-recovery-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let time=100000, probes=0;
  const clients = Array.from({length:6},(_,i)=>new SiteRecovery(directory,`account${i}`,{
    now:()=>time,probe:async()=>{probes++;return {online,detail:online?'HTTP 200':'HTTP 503'};}
  }));
  return {clients,advance:n=>time+=n,count:()=>probes};
}
test('six failing workers share one probe per ten seconds',async t=>{
  const h=setup(t,false);
  const results=await Promise.all(h.clients.map(c=>c.failure(work,'ERR_CONNECTION_TIMED_OUT')));
  assert.equal(h.count(),1);assert.ok(results.every(r=>r.wait));
  h.advance(9000);await h.clients[3].failure(work,'ERR_CONNECTION_TIMED_OUT');assert.equal(h.count(),1);
  h.advance(1000);await h.clients[1].failure(work,'ERR_CONNECTION_TIMED_OUT');assert.equal(h.count(),2);
});
test('healthy probe releases task retries separately, not six at once',async t=>{
  const h=setup(t,true);
  const results=await Promise.all(h.clients.map(c=>c.failure(work,'HTTP 503')));
  assert.equal(results.filter(r=>!r.wait).length,1);
  h.advance(2500);assert.equal((await h.clients[1].failure(work,'HTTP 503')).wait,false);
  assert.equal((await h.clients[2].failure(work,'HTTP 503')).wait,true);
  assert.equal(h.count(),1);
});
test('website groups are independent',async t=>{
  const h=setup(t,false);
  await h.clients[0].failure(work,'HTTP 503');
  assert.equal(h.count(),2);
});
test('progress removes recovered account from shared failure detection',async t=>{
  const h=setup(t,true);
  await h.clients[0].failure(work,'HTTP 503');
  assert.equal((await h.clients[1].failure(work,'HTTP 503')).shared,true);
  h.clients[0].healthy(work);h.advance(3000);
  assert.equal((await h.clients[1].failure(work,'HTTP 503')).shared,false);
});
test('shared outage does not restart a browser with repeated failures',async()=>{
  const { guardBrowserRecovery }=require('./browser-recovery');
  let closed=false,visited=false;
  const pilot={page:{evaluate:async()=>({url:'chrome-error://chromewebdata/',title:'',text:'ERR_CONNECTION_TIMED_OUT'}),goto:async()=>{visited=true;}},
    siteRecovery:{failure:async()=>({wait:true,shared:true,detail:'HTTP 503'})},
    browserRecoveryAttempts:9,browserRecoverySince:Date.now()-200000,epoch:1,
    context:{close:async()=>{closed=true;}},log:()=>{},setStatus:async()=>{}};
  assert.equal(await guardBrowserRecovery(pilot,work),true);
  assert.equal(closed,false);assert.equal(visited,false);
  assert.ok(pilot.siteRecoveryWaitUntil>Date.now());
});
