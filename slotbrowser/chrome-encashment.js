'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PH_TIME_ZONE = 'Asia/Manila';
const ENCASH_URL = 'https://ecnlmediamarket.com/network-encashment';
const TASK_ENCASH_URL = 'https://ecnlmediamarket.com/task-encashment';
const HISTORY_URL = 'https://ecnlmediamarket.com/payout-history';
const FIVE_MINUTES = 300000;
const MIN_CASHOUT_PESOS = 300;
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
function defaultState() { return { date:'', kind:'', status:'scheduled', attempts:0, lastAttemptAt:0, nextAttemptAt:0, historyCheckedAt:0, historyCaptured:false, reference:'', amount:'', tax:'', netAmount:'', gateway:'', payoutNumber:'', requestedAt:'', transactionId:'', payoutStatus:'', message:'', lastUrl:'', screenshot:'', eventLog:[] }; }
function cleanMoney(value) {
  const match = String(value || '').replace(/,/g, '').match(/-?[0-9]+(?:\.[0-9]+)?/);
  return match ? match[0] : '';
}
function parsePayoutRecords(records, targetDate = '') {
  const list = Array.isArray(records) ? records : [];
  const date = String(targetDate || '');
  const parts = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dateHints = [date];
  if (parts) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateHints.push(`${months[Number(parts[2])-1]} ${Number(parts[3])}, ${parts[1]}`, `${parts[2]}/${parts[3]}/${parts[1]}`, `${parts[1]}/${parts[2]}/${parts[3]}`);
  }
  const scored = list.map((record, index) => {
    const text = String(record?.text || '').replace(/\s+/g, ' ').trim();
    const hasDate = dateHints.some(hint => hint && text.toLowerCase().includes(hint.toLowerCase()));
    const hasStatus = /processing|pending|approved|paid|transferred|completed|success|failed|declined/i.test(text);
    const hasMoney = /(?:₱|PHP|\bP\s*)[0-9]/i.test(text);
    return { record, index, score:(hasDate?8:0)+(hasStatus?4:0)+(hasMoney?2:0)-index/1000 };
  }).sort((a,b)=>b.score-a.score);
  const picked = scored[0]?.record || {};
  const headers = Array.isArray(picked.headers) ? picked.headers : [];
  const cells = Array.isArray(picked.cells) ? picked.cells : [];
  const fields = {};
  headers.forEach((header, index) => { fields[String(header || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()] = String(cells[index] || '').trim(); });
  const byHeader = patterns => {
    for (const [key,value] of Object.entries(fields)) if (patterns.some(pattern => pattern.test(key)) && value) return value;
    return '';
  };
  const text = String(picked.text || '').replace(/\s+/g, ' ').trim();
  const status = byHeader([/^status$/, /payout status/]) || (text.match(/processing|pending|approved|paid|transferred|completed|successful?|failed|declined/i)||[])[0] || '';
  const reference = byHeader([/^reference$/, /reference no/, /^ref$/]) || (text.match(/(?:reference(?: number| no\.?| #)?|ref no\.?)\s*[:#-]?\s*([A-Z0-9-]{5,})/i)||[])[1] || (text.match(/\b(ECL[A-Z0-9-]{5,})\b/i)||[])[1] || '';
  const transactionId = byHeader([/^trx/, /transaction id/, /transaction no/, /^transaction$/, /^id$/, /payout id/]) || (text.match(/(?:transaction(?: id| number| no\.?)?|trx#?)\s*[:#-]?\s*([A-Z0-9-]{3,})/i)||[])[1] || '';
  const amount = cleanMoney(byHeader([/^gross$/, /gross amount/, /^amount$/, /requested amount/, /payout amount/]));
  const tax = cleanMoney(byHeader([/^tax$/, /^fee$/, /fee tax/, /deduction/]));
  const netAmount = cleanMoney(byHeader([/^net$/, /net amount/, /you receive/, /receivable/, /received amount/]));
  const requestedAt = byHeader([/^date$/, /request date/, /requested at/, /created at/, /date time/]);
  const gateway = byHeader([/^gateway$/, /payment method/, /channel/]);
  const payoutNumber = byHeader([/account number/, /wallet/, /mobile/, /gcash/]);
  return { found:!!text, text, status, reference, transactionId, amount, tax, netAmount, requestedAt, gateway, payoutNumber };
}

class ChromeEncashmentController {
  constructor(pilot, stateDir, account = 'adaihbi') {
    this.pilot = pilot;
    this.stateDir = stateDir;
    this.account = String(account || 'adaihbi').trim().toLowerCase();
    this.configFile = path.join(stateDir, this.account === 'adaihbi' ? 'encashment_config.json' : `encashment_${this.account}_config.json`);
    this.stateFile = path.join(stateDir, `encashment_${this.account}.json`);
    this.imageFile = path.join(stateDir, `encashment_${this.account}.png`);
    this.busy = false;
    this.timer = null;
  }
  config() { return readJson(this.configFile, { enabled:false }); }
  effectiveConfig(now = new Date(), base = this.config()) {
    const ph = phParts(now), override = base && base.oneTimeOverride;
    if (override && String(override.date || '') < ph.key) {
      const cleaned = Object.assign({}, base); delete cleaned.oneTimeOverride; writeJson(this.configFile, cleaned);
      return cleaned;
    }
    return override && String(override.date || '') === ph.key
      ? Object.assign({}, base, override, { __oneTime:true })
      : base;
  }
  clearOneTimeOverride(state) {
    const base = this.config();
    if (!base.oneTimeOverride || String(base.oneTimeOverride.date || '') !== String(state.date || '')) return;
    delete base.oneTimeOverride; writeJson(this.configFile, base);
    this.save(state, 'One-time schedule completed; recurring schedule restored.');
  }
  state() {
    const state = Object.assign(defaultState(), readJson(this.stateFile, {}));
    if (!state.historyCheckedAt && state.lastCheckAt && state.reference) {
      state.historyCheckedAt = state.lastCheckAt;
      state.historyCaptured = true;
      state.nextCheckAt = 0;
      writeJson(this.stateFile, state);
    }
    return state;
  }
  save(state, event) {
    if (event) { state.eventLog = Array.isArray(state.eventLog) ? state.eventLog : []; state.eventLog.push({ at:Date.now(), text:compact(event, 300) }); state.eventLog = state.eventLog.slice(-30); }
    writeJson(this.stateFile, state);
  }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(error => this.pilot.log(`ENCASH tick error: ${error.message}`)), 15000); setTimeout(() => this.tick().catch(() => {}), 3000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick(now = new Date()) {
    if (this.busy || this.pilot.verificationHold || this.pilot.paused || !this.pilot.page || this.pilot.page.isClosed()) return;
    const baseCfg = this.config(); if (!baseCfg.enabled) return;
    const cfg = this.effectiveConfig(now, baseCfg);
    const ph = phParts(now), start = Number(cfg.startHour || 8), end = Number(cfg.endHour || 10), kind = cfg.type === 'task' ? 'task' : 'network';
    let state = this.state();
    if (/submitted|pending|processing/i.test(`${state.status} ${state.payoutStatus}`) && state.date === ph.key) {
      if (!state.historyCheckedAt) await this.checkHistory();
      return;
    }
    if (ph.weekday !== (cfg.weekday || 'Wed')) return;
    if (state.date !== ph.key || state.kind !== kind) { state = defaultState(); state.date = ph.key; state.kind = kind; this.save(state, `${kind === 'task' ? 'Task' : 'Network'} schedule opened for ${ph.key}`); }
    if (/approved|paid|transferred/i.test(`${state.status} ${state.payoutStatus}`)) return;
    const available = Number(this.pilot.withdrawable);
    if (kind === 'task' && (!Number.isFinite(available) || available < MIN_CASHOUT_PESOS)) {
      const message = `Cash-out locked: ₱${Number.isFinite(available) ? available.toFixed(3).replace(/\.?0+$/, '') : '0'} is below the ₱${MIN_CASHOUT_PESOS} minimum.`;
      if (state.status !== 'below_minimum' || state.message !== message) {
        state.status = 'below_minimum'; state.message = message; state.observedBalance = Number.isFinite(available) ? available : 0;
        this.save(state, message);
      }
      return;
    }
    if (ph.hour >= start && ph.hour < end) { if (!state.lastAttemptAt || Date.now() - state.lastAttemptAt >= FIVE_MINUTES) await this.attempt(now); return; }
    if (ph.hour >= end && !state.lastAttemptAt && state.status === 'scheduled') { state.status = 'window_closed'; state.message = `No withdrawal was submitted before ${end}:00 AM PH.`; this.save(state, state.message); }
  }
  async capture(state) { try { await this.pilot.page.screenshot({ path:this.imageFile, fullPage:false }); state.screenshot = path.basename(this.imageFile); } catch (error) { this.pilot.log(`ENCASH screenshot failed: ${error.message}`); } }
  async withResume(label, work) {
    if (this.busy) return; this.busy = true; this.pilot.epoch++; this.pilot.pending = null; await this.pilot.setStatus(label);
    try { return await work(); }
    finally { await this.pilot.page.goto(this.pilot.workUrl, { waitUntil:'domcontentloaded', timeout:30000 }).catch(() => {}); await this.pilot.installPageRuntime(); this.pilot.lastActivityAt = Date.now(); this.busy = false; await this.pilot.setStatus('Color work resumed.'); }
  }
  async attempt(now = new Date()) {
    const cfg = this.effectiveConfig(now); if (!cfg.enabled) return;
    const available = Number(this.pilot.withdrawable);
    const requestedKind = cfg.type === 'task' ? 'task' : 'network';
    if (requestedKind === 'task' && (!Number.isFinite(available) || available < MIN_CASHOUT_PESOS)) return;
    const state = this.state(); if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < FIVE_MINUTES) return;
    state.lastAttemptAt = Date.now(); state.nextAttemptAt = state.lastAttemptAt + FIVE_MINUTES; state.attempts = Number(state.attempts || 0) + 1; state.status = 'attempting'; this.save(state, `Attempt ${state.attempts} started`);
    await this.withResume('Withdrawal attempt in progress…', async () => {
      try {
        const kind = cfg.type === 'task' ? 'task' : 'network'; state.kind = kind;
        await this.pilot.page.goto(kind === 'task' ? TASK_ENCASH_URL : ENCASH_URL, { waitUntil:'domcontentloaded', timeout:30000 }); await sleep(2500);
        const prepared = await this.pilot.page.evaluate(data => {
          const receiver=document.querySelector('[name="recipient_name"]'),email=document.querySelector('[name="email_address"]'),mobile=document.querySelector('[name="wallet_address"]'),amount=document.querySelector('[name="amount"]'),payment=document.querySelector('[name="payment_gateway"]'),submit=document.querySelector('#btnSubmit,[name="encash"]');
          const set=(el,v)=>{if(!el)return false;const proto=Object.getPrototypeOf(el),desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc?.set)desc.set.call(el,String(v));else el.value=String(v);for(const type of ['input','change','blur'])el.dispatchEvent(new Event(type,{bubbles:true}));return true;};
          set(receiver,data.receiverName);if(data.email)set(email,data.email);set(mobile,data.mobile);
          if(payment){const options=[...payment.options],index=options.findIndex(o=>/^gcash$/i.test(o.text.trim()));if(index>=0)payment.selectedIndex=index;payment.dispatchEvent(new Event('change',{bubbles:true}));}
          const missing=[];if(!receiver||receiver.value.trim()!==data.receiverName.trim())missing.push('receiver_name');if(!email||!email.value.trim())missing.push('email_address');if(!mobile||mobile.value.replace(/\D/g,'')!==String(data.mobile).replace(/\D/g,''))missing.push('wallet_address');if(!amount||!(Number(amount.value)>0))missing.push('amount');if(!payment||!/gcash/i.test(payment.options[payment.selectedIndex]?.text||''))missing.push('payment_gateway');if(!submit)missing.push('submit_button');if(submit?.form&&!submit.form.checkValidity())missing.push('form_validation');
          return { ready:missing.length===0, missing, amount:amount?.value||'', gateway:payment?.options[payment.selectedIndex]?.text||'' };
        }, { receiverName:cfg.receiverName||'', email:cfg.email||'', mobile:cfg.mobile||'', payment:cfg.payment||'GCash' });
        state.amount = prepared.amount || state.amount || ''; state.gateway = prepared.gateway || cfg.payment || 'GCash'; state.payoutNumber = cfg.mobile || state.payoutNumber || ''; state.requestedAt = new Intl.DateTimeFormat('en-PH',{timeZone:PH_TIME_ZONE,dateStyle:'medium',timeStyle:'medium'}).format(new Date());
        if (!prepared.ready) throw new Error(`Form not ready: ${prepared.missing.join(', ')}`);
        const formAmount = Number(String(prepared.amount || '').replace(/[^0-9.-]/g, ''));
        if (!Number.isFinite(formAmount) || formAmount < MIN_CASHOUT_PESOS) { state.status='below_minimum';state.message=`Cash-out locked: ${kind === 'task' ? 'Task' : 'Network'} Earnings amount is below the ₱${MIN_CASHOUT_PESOS} minimum.`;state.nextAttemptAt=Date.now()+FIVE_MINUTES;this.save(state,state.message);return; }
        await this.pilot.page.evaluate(() => { window.confirm=()=>true;window.alert=m=>{window.__vtAlert=String(m||'');};const submit=document.querySelector('#btnSubmit,[name="encash"]');if(submit?.form?.requestSubmit)submit.form.requestSubmit(submit);else submit?.click(); });
        await sleep(1200);
        for (let i=0;i<3;i++) { await this.pilot.page.evaluate(() => { const button=[...document.querySelectorAll('.swal2-confirm,.modal button,button,[role="button"],input[type="submit"]')].find(el=>/^(yes|confirm|continue|submit|ok|request|proceed)$/i.test((el.innerText||el.value||'').trim())&&!el.disabled);if(button)button.click(); }).catch(()=>{}); await sleep(1200); }
        await sleep(2500);
        const result = await this.pilot.page.evaluate(() => { const text=`${window.__vtAlert||''} ${document.body?.innerText||''}`.replace(/\s+/g,' ').trim(),failed=/failed|error|invalid|unable|try again|insufficient|required field/i.test(text),success=(/success(?:ful|fully)?|submitted|pending|processing|request received/i.test(text)||!document.querySelector('[name="recipient_name"]'))&&!failed,reference=(text.match(/(?:reference(?: number| no\.?| #)?|ref no\.?)\s*[:#-]\s*([A-Z0-9-]{5,})/i)||[])[1]||'';return{submitted:success,failed,reference,url:location.href,text:text.slice(0,1800)}; });
        state.lastUrl=result.url;state.reference=result.reference||state.reference;state.message=compact(result.text);state.status=result.submitted?'submitted':'failed';state.payoutStatus=result.submitted?'Pending':state.payoutStatus;state.nextAttemptAt=result.submitted?0:Date.now()+FIVE_MINUTES;await this.capture(state);this.save(state,result.submitted?'Withdrawal submitted; retries stopped':'Attempt failed; retry after five minutes');if(result.submitted&&cfg.__oneTime)this.clearOneTimeOverride(state);
      } catch (error) { state.status='failed';state.message=compact(error.message);state.nextAttemptAt=Date.now()+FIVE_MINUTES;this.save(state,`Attempt error: ${error.message}`); }
    });
  }
  async checkHistory() {
    const state=this.state();state.historyCheckedAt=Date.now();state.lastCheckAt=state.historyCheckedAt;state.nextCheckAt=0;this.save(state,'One-time payout history capture started');
    await this.withResume('Checking payout status…',async()=>{
      try {
        await this.pilot.page.goto(HISTORY_URL,{waitUntil:'domcontentloaded',timeout:30000});
        await sleep(2500);
        const pageData=await this.pilot.page.evaluate(()=>{
          const records=[];
          document.querySelectorAll('table').forEach(table=>{
            const headers=[...table.querySelectorAll('thead th')].map(el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim());
            table.querySelectorAll('tbody tr').forEach(row=>{
              const cells=[...row.querySelectorAll('th,td')].map(el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim());
              const text=(row.innerText||row.textContent||'').replace(/\s+/g,' ').trim();
              if(text)records.push({headers,cells,text});
            });
          });
          if(!records.length) document.querySelectorAll('[class*="payout" i],[class*="transaction" i],[class*="history" i]').forEach(el=>{const text=(el.innerText||'').replace(/\s+/g,' ').trim();if(text&&/(?:₱|PHP|processing|pending|approved|paid|transferred|completed|failed|declined)/i.test(text))records.push({headers:[],cells:[],text});});
          return {url:location.href,records};
        });
        const result=parsePayoutRecords(pageData.records,state.date||phParts().key);
        state.lastUrl=pageData.url;
        state.payoutStatus=result.status||state.payoutStatus||'Pending';
        state.reference=result.reference||state.reference;
        state.transactionId=result.transactionId||state.transactionId;
        state.amount=result.amount||state.amount;
        state.tax=result.tax||state.tax;
        state.netAmount=result.netAmount||state.netAmount;
        state.requestedAt=result.requestedAt||state.requestedAt;
        state.gateway=result.gateway||state.gateway;
        state.payoutNumber=result.payoutNumber||state.payoutNumber;
        state.message=compact(result.text||'No payout row found');
        state.historyCaptured=!!result.found;
        state.status=/approved|paid|transferred|completed|success/i.test(state.payoutStatus)?'approved':/failed|declined/i.test(state.payoutStatus)?'failed':'pending';
        await this.capture(state);
        this.save(state,result.found?`Payout history captured once: ${state.payoutStatus||'unknown'}`:'One-time payout-history check found no matching row');
      }catch(error){state.message=compact(error.message);this.save(state,`History check error: ${error.message}`);}
    });
  }
}

module.exports = { ChromeEncashmentController, phParts, parsePayoutRecords, PH_TIME_ZONE, MIN_CASHOUT_PESOS };
