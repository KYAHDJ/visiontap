'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PAYOUT_URL = 'https://pmath100.com/games-payout';
const PH_ZONE = 'Asia/Manila';
const RETRY_MS = 300000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); const tmp=`${file}.tmp`; fs.writeFileSync(tmp,JSON.stringify(value,null,2)); fs.renameSync(tmp,file); };
function phParts(now=new Date()) { const p=new Intl.DateTimeFormat('en-CA',{timeZone:PH_ZONE,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(now).reduce((o,x)=>(o[x.type]=x.value,o),{}); return {date:`${p.year}-${p.month}-${p.day}`,weekday:p.weekday,hour:Number(p.hour)===24?0:Number(p.hour),minute:Number(p.minute)}; }

class PmathCashoutController {
  constructor(pilot,stateDir) { this.pilot=pilot; this.configFile=path.join(stateDir,'pmath_cashout_config.json'); this.stateFile=path.join(stateDir,'pmath_cashout_state.json'); this.historyFile=path.join(stateDir,'pmath_payout_history.json'); this.imageFile=path.join(stateDir,'pmath_cashout.png'); this.timer=null; this.busy=false; }
  config(){ return readJson(this.configFile,{enabled:false}); }
  state(){ return readJson(this.stateFile,{date:'',status:'scheduled',attempts:0,lastAttemptAt:0,message:''}); }
  save(state,event){ if(event){state.eventLog=Array.isArray(state.eventLog)?state.eventLog:[];state.eventLog.push({at:Date.now(),text:event});state.eventLog=state.eventLog.slice(-30);} writeJson(this.stateFile,state); }
  start(){ if(this.timer)return; this.timer=setInterval(()=>this.tick().catch(e=>this.pilot.log(`PMath payout tick error: ${e.message}`)),15000); setTimeout(()=>this.tick().catch(()=>{}),3000); }
  stop(){ if(this.timer)clearInterval(this.timer);this.timer=null; }
  async tick(now=new Date()){
    const cfg=this.config(),ph=phParts(now); if(!cfg.enabled||this.busy||this.pilot.paused||this.pilot.verificationHold)return;
    const target=String(cfg.oneTimeDate||''),allowed=target?ph.date===target:(cfg.weekdays||[]).includes(ph.weekday); if(!allowed)return;
    let state=this.state(); if(state.date!==ph.date){state={account:'kyaiko',platform:'PMath',kind:'Task',date:ph.date,status:'scheduled',attempts:0,lastAttemptAt:0,message:''};this.save(state,'Weekday payout schedule opened.');}
    if(/submitted|pending|processing|paid|approved|completed|success/i.test(`${state.status} ${state.payoutStatus||''}`))return;
    const start=Number(cfg.startHour??8),end=Number(cfg.endHour??10); if(ph.hour<start||ph.hour>=end)return;
    if(state.lastAttemptAt&&Date.now()-state.lastAttemptAt<RETRY_MS)return;
    await this.attempt(cfg,state);
  }
  async attempt(cfg,state){
    this.busy=true; this.pilot.epoch++; this.pilot.pending=null; this.pilot.mathPending=null; state.lastAttemptAt=Date.now();state.attempts=Number(state.attempts||0)+1;state.status='attempting';this.save(state,`Attempt ${state.attempts} started.`);await this.pilot.setStatus('PayMath weekday payout: converting remaining coins first…');
    try{
      const conversionReady=await this.pilot.preparePmathPayout();
      if(!conversionReady)throw new Error('Coin conversion was not confirmed; payout deferred so no balance is left behind.');
      await this.pilot.page.goto(PAYOUT_URL,{waitUntil:'domcontentloaded',timeout:30000});await sleep(2500);
      const prepared=await this.pilot.page.evaluate(data=>{
        const text=(document.body?.innerText||'').replace(/\s+/g,' ').trim();
        const money=[...text.matchAll(/(?:Available|Withdrawable Wallet)[^₱0-9]{0,40}₱?\s*([0-9,]+(?:\.[0-9]+)?)/gi)].map(m=>Number(m[1].replace(/,/g,'')));
        const available=money.length?Math.max(...money):0,controls=[...document.querySelectorAll('input,select,textarea')];
        const set=(el,value)=>{if(!el||value==null)return;const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');if(d?.set)d.set.call(el,String(value));else el.value=String(value);['input','change','blur'].forEach(t=>el.dispatchEvent(new Event(t,{bubbles:true})));};
        const hint=el=>`${el.name||''} ${el.id||''} ${el.placeholder||''} ${el.getAttribute('aria-label')||''}`.toLowerCase();
        controls.forEach(el=>{const h=hint(el);if(/recipient|receiver|full.?name/.test(h))set(el,data.receiverName);else if(/mobile|phone|wallet|gcash/.test(h)&&el.tagName!=='SELECT')set(el,data.mobile);else if(el.tagName==='SELECT'&&/payment|gateway|method|wallet/.test(h)){const option=[...el.options].find(o=>/gcash/i.test(o.text));if(option)set(el,option.value);}});
        const submit=[...document.querySelectorAll('button,input[type="submit"],a.btn')].filter(el=>!el.disabled&&el.getBoundingClientRect().width>0).find(el=>/encash|cash.?out|withdraw|request payout|submit payout|claim/i.test((el.innerText||el.value||'').trim()));
        return {available,closed:/encashment closed for now/i.test(text),hasSubmit:!!submit};
      },{receiverName:cfg.receiverName||'',mobile:cfg.mobile||''});
      state.amount=prepared.available.toFixed(3);state.gateway=cfg.payment||'GCash';state.payoutNumber=cfg.mobile||'';
      if(prepared.closed)throw new Error('PayMath payout window is still closed.');
      if(prepared.available<Number(cfg.minimumPesos||300))throw new Error(`Available ₱${prepared.available.toFixed(3)} is below the ₱${Number(cfg.minimumPesos||300)} minimum.`);
      if(!prepared.hasSubmit)throw new Error('PayMath payout button was not found.');
      if(!cfg.autoSubmit)throw new Error('Automatic PayMath payout submission is disabled.');
      await this.pilot.page.evaluate(()=>{window.confirm=()=>true;const button=[...document.querySelectorAll('button,input[type="submit"],a.btn')].find(el=>!el.disabled&&/encash|cash.?out|withdraw|request payout|submit payout|claim/i.test((el.innerText||el.value||'').trim()));button?.click();});
      for(let i=0;i<20;i++){await sleep(300);await this.pilot.page.evaluate(()=>{const b=[...document.querySelectorAll('button,input[type="submit"],[role="button"]')].find(el=>!el.disabled&&/^(yes|confirm|continue|submit|request|proceed|ok)$/i.test((el.innerText||el.value||'').trim()));b?.click();}).catch(()=>{});}
      await sleep(2500);
      const result=await this.pilot.page.evaluate(()=>{const text=(document.body?.innerText||'').replace(/\s+/g,' ').trim();return {text:text.slice(0,1800),success:/success|submitted|pending|processing|request received/i.test(text)&&!/failed|error|invalid|unable/i.test(text),transactionId:(text.match(/(?:transaction|reference|trx)[^A-Z0-9]{0,20}([A-Z0-9-]{5,})/i)||[])[1]||''};});
      state.status=result.success?'submitted':'failed';state.payoutStatus=result.success?'Pending':'Failed';state.transactionId=result.transactionId;state.message=result.text;await this.pilot.page.screenshot({path:this.imageFile,fullPage:false}).catch(()=>{});this.save(state,result.success?'PayMath payout submitted; retries stopped.':'Payout response was not confirmed; retry scheduled.');
      if(result.success){const history=readJson(this.historyFile,[]);history.push({...state,updatedAt:Date.now()});writeJson(this.historyFile,history.slice(-100));}
    }catch(error){state.status='failed';state.message=error.message;this.save(state,`Attempt failed: ${error.message}`);}
    finally{await this.pilot.page.goto(this.pilot.workUrl,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});await this.pilot.installPageRuntime().catch(()=>{});this.pilot.mathPending=null;this.pilot.lastActivityAt=Date.now();this.pilot.lastProgressAt=Date.now();this.busy=false;await this.pilot.setStatus('PayMath work resumed.');}
  }
}
module.exports={PmathCashoutController,phParts};
