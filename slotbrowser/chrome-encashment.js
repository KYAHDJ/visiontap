'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PH_TIME_ZONE = 'Asia/Manila';
const ENCASH_URL = 'https://ecnlmediamarket.com/network-encashment';
const TASK_ENCASH_URL = 'https://ecnlmediamarket.com/task-encashment';
const HISTORY_URL = 'https://ecnlmediamarket.com/payout-history';
const FIVE_MINUTES = 300000;
const ONE_HOUR = 3600000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function writeJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); }
function compact(value, max = 1600) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function phParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PH_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', weekday:'short', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false })
    .formatToParts(now).reduce((out, item) => { out[item.type] = item.value; return out; }, {});
  let hour = Number(parts.hour); if (hour === 24) hour = 0;
  return { key:`${parts.year}-${parts.month}-${parts.day}`, weekday:parts.weekday, hour, minute:Number(parts.minute), second:Number(parts.second) };
}
function defaultState() { return { date:'', kind:'', status:'scheduled', attempts:0, lastAttemptAt:0, nextAttemptAt:0, lastCheckAt:0, nextCheckAt:0, reference:'', amount:'', tax:'', netAmount:'', gateway:'', payoutNumber:'', requestedAt:'', transactionId:'', payoutStatus:'', message:'', lastUrl:'', screenshot:'', eventLog:[] }; }

class ChromeEncashmentController {
  constructor(pilot, stateDir) {
    this.pilot = pilot;
    this.stateDir = stateDir;
    this.configFile = path.join(stateDir, 'encashment_config.json');
    this.stateFile = path.join(stateDir, 'encashment_adaihbi.json');
    this.imageFile = path.join(stateDir, 'encashment_adaihbi.png');
    this.busy = false;
    this.timer = null;
  }
  config() { return readJson(this.configFile, { enabled:false }); }
  state() { return Object.assign(defaultState(), readJson(this.stateFile, {})); }
  save(state, event) {
    if (event) { state.eventLog = Array.isArray(state.eventLog) ? state.eventLog : []; state.eventLog.push({ at:Date.now(), text:compact(event, 300) }); state.eventLog = state.eventLog.slice(-30); }
    writeJson(this.stateFile, state);
  }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(error => this.pilot.log(`ENCASH tick error: ${error.message}`)), 15000); setTimeout(() => this.tick().catch(() => {}), 3000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick(now = new Date()) {
    if (this.busy || this.pilot.verificationHold || this.pilot.paused || !this.pilot.page || this.pilot.page.isClosed()) return;
    const cfg = this.config(); if (!cfg.enabled) return;
    const ph = phParts(now), start = Number(cfg.startHour || 8), end = Number(cfg.endHour || 10), kind = cfg.type === 'task' ? 'task' : 'network';
    let state = this.state();
    if (/submitted|pending|processing/i.test(`${state.status} ${state.payoutStatus}`) && state.date === ph.key) return;
    if (ph.weekday !== (cfg.weekday || 'Wed')) return;
    if (state.date !== ph.key || state.kind !== kind) { state = defaultState(); state.date = ph.key; state.kind = kind; this.save(state, `${kind === 'task' ? 'Task' : 'Network'} schedule opened for ${ph.key}`); }
    if (/approved|paid|transferred/i.test(`${state.status} ${state.payoutStatus}`)) return;
    if (ph.hour >= start && ph.hour < end) { if (!state.lastAttemptAt || Date.now() - state.lastAttemptAt >= FIVE_MINUTES) await this.attempt(); return; }
    if (ph.hour >= end && !state.lastAttemptAt && state.status === 'scheduled') { state.status = 'window_closed'; state.message = `No withdrawal was submitted before ${end}:00 AM PH.`; this.save(state, state.message); }
    if (/submitted|pending|processing/i.test(`${state.status} ${state.payoutStatus}`) && (!state.lastCheckAt || Date.now() - state.lastCheckAt >= ONE_HOUR)) await this.checkHistory();
  }
  async capture(state) { try { await this.pilot.page.screenshot({ path:this.imageFile, fullPage:false }); state.screenshot = path.basename(this.imageFile); } catch (error) { this.pilot.log(`ENCASH screenshot failed: ${error.message}`); } }
  async withResume(label, work) {
    if (this.busy) return; this.busy = true; this.pilot.epoch++; this.pilot.pending = null; await this.pilot.setStatus(label);
    try { return await work(); }
    finally { await this.pilot.page.goto(this.pilot.workUrl, { waitUntil:'domcontentloaded', timeout:30000 }).catch(() => {}); await this.pilot.installPageRuntime(); this.pilot.lastActivityAt = Date.now(); this.busy = false; await this.pilot.setStatus('Color work resumed.'); }
  }
  async attempt() {
    const cfg = this.config(); if (!cfg.enabled) return;
    const state = this.state(); if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < FIVE_MINUTES) return;
    state.lastAttemptAt = Date.now(); state.nextAttemptAt = state.lastAttemptAt + FIVE_MINUTES; state.attempts = Number(state.attempts || 0) + 1; state.status = 'attempting'; this.save(state, `Attempt ${state.attempts} started`);
    await this.withResume('Withdrawal attempt in progress…', async () => {
      try {
        const kind = cfg.type === 'task' ? 'task' : 'network'; state.kind = kind;
        await this.pilot.page.goto(kind === 'task' ? TASK_ENCASH_URL : ENCASH_URL, { waitUntil:'domcontentloaded', timeout:30000 }); await sleep(2500);
        const prepared = await this.pilot.page.evaluate(data => {
          const receiver=document.querySelector('[name="recipient_name"]'),email=document.querySelector('[name="email_address"]'),mobile=document.querySelector('[name="wallet_address"]'),amount=document.querySelector('[name="amount"]'),payment=document.querySelector('[name="payment_gateway"]'),submit=document.querySelector('#btnSubmit,[name="encash"]');
          const set=(el,v)=>{if(!el)return false;const proto=Object.getPrototypeOf(el),desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc?.set)desc.set.call(el,String(v));else el.value=String(v);for(const type of ['input','change','blur'])el.dispatchEvent(new Event(type,{bubbles:true}));return true;};
          set(receiver,data.receiverName);set(email,data.email);set(mobile,data.mobile);
          if(payment){const options=[...payment.options],index=options.findIndex(o=>/^gcash$/i.test(o.text.trim()));if(index>=0)payment.selectedIndex=index;payment.dispatchEvent(new Event('change',{bubbles:true}));}
          const missing=[];if(!receiver||receiver.value.trim()!==data.receiverName.trim())missing.push('receiver_name');if(!email||email.value.trim()!==data.email.trim())missing.push('email_address');if(!mobile||mobile.value.replace(/\D/g,'')!==String(data.mobile).replace(/\D/g,''))missing.push('wallet_address');if(!amount||!(Number(amount.value)>0))missing.push('amount');if(!payment||!/gcash/i.test(payment.options[payment.selectedIndex]?.text||''))missing.push('payment_gateway');if(!submit)missing.push('submit_button');if(submit?.form&&!submit.form.checkValidity())missing.push('form_validation');
          return { ready:missing.length===0, missing, amount:amount?.value||'', gateway:payment?.options[payment.selectedIndex]?.text||'' };
        }, { receiverName:cfg.receiverName||'', email:cfg.email||'', mobile:cfg.mobile||'', payment:cfg.payment||'GCash' });
        state.amount = prepared.amount || state.amount || ''; state.gateway = prepared.gateway || cfg.payment || 'GCash'; state.payoutNumber = cfg.mobile || state.payoutNumber || ''; state.requestedAt = new Intl.DateTimeFormat('en-PH',{timeZone:PH_TIME_ZONE,dateStyle:'medium',timeStyle:'medium'}).format(new Date());
        if (!prepared.ready) throw new Error(`Form not ready: ${prepared.missing.join(', ')}`);
        await this.pilot.page.evaluate(() => { window.confirm=()=>true;window.alert=m=>{window.__vtAlert=String(m||'');};const submit=document.querySelector('#btnSubmit,[name="encash"]');if(submit?.form?.requestSubmit)submit.form.requestSubmit(submit);else submit?.click(); });
        await sleep(1200);
        for (let i=0;i<3;i++) { await this.pilot.page.evaluate(() => { const button=[...document.querySelectorAll('.swal2-confirm,.modal button,button,[role="button"],input[type="submit"]')].find(el=>/^(yes|confirm|continue|submit|ok|request|proceed)$/i.test((el.innerText||el.value||'').trim())&&!el.disabled);if(button)button.click(); }).catch(()=>{}); await sleep(1200); }
        await sleep(2500);
        const result = await this.pilot.page.evaluate(() => { const text=`${window.__vtAlert||''} ${document.body?.innerText||''}`.replace(/\s+/g,' ').trim(),failed=/failed|error|invalid|unable|try again|insufficient|required field/i.test(text),success=(/success(?:ful|fully)?|submitted|pending|processing|request received/i.test(text)||!document.querySelector('[name="recipient_name"]'))&&!failed,reference=(text.match(/(?:reference(?: number| no\.?| #)?|ref no\.?)\s*[:#-]\s*([A-Z0-9-]{5,})/i)||[])[1]||'';return{submitted:success,failed,reference,url:location.href,text:text.slice(0,1800)}; });
        state.lastUrl=result.url;state.reference=result.reference||state.reference;state.message=compact(result.text);state.status=result.submitted?'submitted':'failed';state.payoutStatus=result.submitted?'Pending':state.payoutStatus;state.nextAttemptAt=result.submitted?0:Date.now()+FIVE_MINUTES;await this.capture(state);this.save(state,result.submitted?'Withdrawal submitted; retries stopped':'Attempt failed; retry after five minutes');
      } catch (error) { state.status='failed';state.message=compact(error.message);state.nextAttemptAt=Date.now()+FIVE_MINUTES;this.save(state,`Attempt error: ${error.message}`); }
    });
  }
  async checkHistory() {
    const state=this.state();state.lastCheckAt=Date.now();state.nextCheckAt=state.lastCheckAt+ONE_HOUR;this.save(state,'Payout history check started');
    await this.withResume('Checking payout status…',async()=>{try{await this.pilot.page.goto(HISTORY_URL,{waitUntil:'domcontentloaded',timeout:30000});await sleep(2500);const result=await this.pilot.page.evaluate(targetDate=>{const rows=[...document.querySelectorAll('tbody tr,tr')].map(el=>(el.innerText||'').replace(/\s+/g,' ').trim()).filter(Boolean),recent=rows.find(text=>text.includes(targetDate)&&/processing|pending|approved|paid|transferred|failed|declined/i.test(text))||[...rows].reverse().find(text=>/processing|pending|approved|paid|transferred|failed|declined/i.test(text))||'',status=(recent.match(/processing|pending|approved|paid|transferred|failed|declined/i)||[])[0]||'',reference=(recent.match(/\b(ECL[A-Z]-[A-Z0-9]+)\b/i)||[])[1]||'',amount=(recent.match(/[₱P]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i)||[])[1]||'';return{url:location.href,recent,status,reference,amount};},state.date||phParts().key);state.lastUrl=result.url;state.payoutStatus=result.status||state.payoutStatus||'Pending';state.reference=result.reference||state.reference;state.amount=result.amount||state.amount;state.message=compact(result.recent||'No payout row found');state.status=/approved|paid|transferred/i.test(state.payoutStatus)?'approved':/failed|declined/i.test(state.payoutStatus)?'failed':'pending';await this.capture(state);this.save(state,`Payout status: ${state.payoutStatus||'unknown'}`);}catch(error){state.message=compact(error.message);this.save(state,`History check error: ${error.message}`);}});
  }
}

module.exports = { ChromeEncashmentController, phParts, PH_TIME_ZONE };
