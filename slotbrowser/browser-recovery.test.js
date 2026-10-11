const test = require('node:test');
const assert = require('node:assert/strict');
const { pageFailure, guardBrowserRecovery, recordProgress } = require('./browser-recovery');
function pilot(info) {
  const p = { paused:false, epoch:1, running:true, statuses:[], visits:[],
    page:{ evaluate:async()=>info, url:()=>info.url, goto:async u=>p.visits.push(u) },
    detectVerification:async()=>false, setStatus:async s=>p.statuses.push(s), log:()=>{} };
  return p;
}
const work = 'https://ecnlmediamarket.com/solving-colors';
test('Chrome and HTTP failures are recognized without flagging a normal task',()=>{
  for (const text of ["This page isn’t working", "This site can't be reached", 'HTTP ERROR 500','ERR_CONNECTION_RESET','503 Service Unavailable']) assert.ok(pageFailure(work,'',text));
  assert.ok(pageFailure('chrome-error://chromewebdata/','',''));
  assert.equal(pageFailure(work,'ECNL','Success! Correct Answer!'),null);
});
test('error recovery uses task URL and throttles retries to ten seconds',async()=>{
  const p=pilot({url:'chrome-error://chromewebdata/',title:'',text:''});
  assert.equal(await guardBrowserRecovery(p,work),true);
  assert.deepEqual(p.visits,[work]);
  await guardBrowserRecovery(p,work); assert.equal(p.visits.length,1);
  assert.equal(p.browserRecoveryActive,true);
});
test('unexpected page gets a bounded wait then recovers',async()=>{
  const p=pilot({url:'about:blank',title:'',text:''});
  assert.equal(await guardBrowserRecovery(p,work),false);
  p.unexpectedPageSince=Date.now()-21000;
  p.nextBrowserProbeAt=0;
  assert.equal(await guardBrowserRecovery(p,work),true);
  assert.deepEqual(p.visits,[work]);
});
test('pause, payout and verification remain protected',async()=>{
  for(const kind of ['paused','payout','verification']){
    const p=pilot({url:work,title:'Verify',text:'Please verify'});
    if(kind==='paused') p.paused=true;
    if(kind==='payout') p.encashment={busy:true};
    if(kind==='verification') p.detectVerification=async()=>true;
    assert.equal(await guardBrowserRecovery(p,work),false); assert.equal(p.visits.length,0);
  }
});
test('expired login re-enters existing login handling',async()=>{
  const p=pilot({url:'https://ecnlmediamarket.com/login.php',title:'',text:''});
  await guardBrowserRecovery(p,work); assert.equal(p.verificationHold,true); assert.equal(p.visits.length,0);
});
test('repeated errors restart only the affected browser',async()=>{
  const p=pilot({url:'chrome-error://chromewebdata/',title:'',text:''});
  p.browserRecoveryAttempts=5; p.browserRecoverySince=Date.now()-61000;
  let closed=false; p.context={close:async()=>{closed=true;}};
  const before=process.exitCode;
  try { await guardBrowserRecovery(p,work); assert.equal(closed,true); assert.equal(p.running,false); assert.equal(process.exitCode,75); }
  finally {process.exitCode=before;}
});
test('only observed increases reset progress and recovery counters',()=>{
  const p={pointsDone:10,withdrawable:3,lastConfirmedProgressAt:1,browserRecoveryAttempts:3};
  recordProgress(p,10,3); assert.equal(p.lastConfirmedProgressAt,1);
  p.pointsDone=11;recordProgress(p,10,3);assert.ok(p.lastConfirmedProgressAt>1);assert.equal(p.browserRecoveryAttempts,0);
  p.lastConfirmedProgressAt=1;p.pointsDone=0;p.withdrawable=6;recordProgress(p,249,3);assert.ok(p.lastConfirmedProgressAt>1);
});
