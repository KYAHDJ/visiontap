const fs = require('fs');
const path = require('path');
const PH_TIME_ZONE = 'Asia/Manila';
const ENCASH_URL = 'https://ecnlmediamarket.com/network-encashment';
const HISTORY_URL = 'https://ecnlmediamarket.com/payout-history';
const FIVE_MINUTES = 300000;
const ONE_HOUR = 3600000;

function phParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: PH_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', weekday:'short', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false })
    .formatToParts(now).reduce((o,x) => { o[x.type]=x.value; return o; }, {});
  let hour=Number(p.hour); if(hour===24) hour=0;
  return { key:`${p.year}-${p.month}-${p.day}`, weekday:p.weekday, hour, minute:Number(p.minute), second:Number(p.second) };
}
function readJson(f,d){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(_){return d;}}
function writeJson(f,d){fs.mkdirSync(path.dirname(f),{recursive:true});const t=f+'.tmp';fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,f);}
function compact(v,n=1600){return String(v||'').replace(/\s+/g,' ').trim().slice(0,n);}
function defaultState(){return {date:'',status:'scheduled',attempts:0,lastAttemptAt:0,nextAttemptAt:0,lastCheckAt:0,nextCheckAt:0,reference:'',amount:'',payoutStatus:'',message:'',lastUrl:'',screenshot:'',eventLog:[]};}

class EncashmentController {
  constructor(slot,stateDir){this.slot=slot;this.stateDir=stateDir;this.configFile=path.join(stateDir,'encashment_config.json');this.stateFile=path.join(stateDir,'encashment_adaihbi.json');this.imageFile=path.join(stateDir,'encashment_adaihbi.png');this.timer=null;this.busy=false;}
  get enabledForSlot(){const a=String(this.slot.accountName||(this.slot._creds&&this.slot._creds.user)||'').toLowerCase();return a==='adaihbi';}
  config(){return readJson(this.configFile,{enabled:false});}
  state(){return Object.assign(defaultState(),readJson(this.stateFile,{}));}
  save(s,event){if(event){s.eventLog=Array.isArray(s.eventLog)?s.eventLog:[];s.eventLog.push({at:Date.now(),text:compact(event,300)});s.eventLog=s.eventLog.slice(-30);}writeJson(this.stateFile,s);}
  start(){if(this.timer)return;this.timer=setInterval(()=>this.tick().catch(e=>this.slot.log('ENCASH tick error: '+e.message)),15000);setTimeout(()=>this.tick().catch(()=>{}),3000);}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  async tick(now=new Date()){
    if(!this.enabledForSlot||this.busy||!this.slot.wcIsAlive())return;
    const cfg=this.config();if(!cfg.enabled)return;const ph=phParts(now),start=Number(cfg.startHour||8),end=Number(cfg.endHour||10),withdrawDay=ph.weekday===(cfg.weekday||'Mon');
    let s=this.state();
    if(/submitted|pending/i.test(s.status+' '+s.payoutStatus)){
      if(ph.hour>=12&&(!s.lastCheckAt||Date.now()-s.lastCheckAt>=ONE_HOUR))await this.checkHistory(false);
      return;
    }
    if(!withdrawDay)return;
    if(s.date!==ph.key){s=defaultState();s.date=ph.key;this.save(s,'Schedule opened for '+ph.key);}
    if(/approved|paid|transferred/i.test(s.status+' '+s.payoutStatus))return;
    if(ph.hour>=start&&ph.hour<end){if(!s.lastAttemptAt||Date.now()-s.lastAttemptAt>=FIVE_MINUTES)await this.attempt(false);return;}
    if(ph.hour>=end&&!s.lastAttemptAt&&s.status==='scheduled'){s.status='window_closed';s.message='No withdrawal was submitted before 10:00 AM PH.';this.save(s,s.message);}
  }
  async waitForLoad(ms=25000){const wc=this.slot.wc;return new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve(true);};const timer=setTimeout(finish,ms);wc.once('did-finish-load',finish);});}
  async navigate(url){const loading=this.waitForLoad();await this.slot.wc.loadURL(url);await loading;await new Promise(r=>setTimeout(r,2500));return this.slot.wc.getURL();}
  async capture(s){try{await this.slot.wc.executeJavaScript(`(()=>{for(const e of document.querySelectorAll('input')){const k=((e.name||'')+' '+(e.id||'')+' '+(e.placeholder||'')).toLowerCase();if(/email|mobile|phone|wallet|receiver|recipient|name/.test(k)&&e.value)e.value='••••••••';}})()`);const im=await this.slot.wc.capturePage();fs.writeFileSync(this.imageFile,im.toPNG());s.screenshot=path.basename(this.imageFile);}catch(e){this.slot.log('ENCASH screenshot failed: '+e.message);}}
  async withColorResume(label,work){if(this.busy)return null;this.busy=true;this.slot.encashmentBusy=true;this.slot.cancelPendingWork();this.slot.status(label);try{return await work();}finally{try{await this.slot.wc.loadURL(this.slot.getWorkUrl());}catch(_){}this.slot.encashmentBusy=false;this.busy=false;this.slot.markActivity();if(this.slot.isLoopRunning&&!this.slot.paused&&!this.slot.dashboardPaused&&!this.slot.loopStopRequested){this.slot.status('Color work resumed.');this.slot.scheduleNext(1200);}}}
  async inspect(){
    if(!this.enabledForSlot)return;
    await this.withColorResume('Inspecting encashment form...',async()=>{
      const s=this.state();await this.navigate(ENCASH_URL);
      const info=await this.slot.wc.executeJavaScript(`(()=>{const label=e=>{const d=e.id&&document.querySelector('label[for="'+CSS.escape(e.id)+'"]');return((d&&d.innerText)||(e.closest('label')&&e.closest('label').innerText)||'').trim();};return{url:location.href,title:document.title,fields:[...document.querySelectorAll('input,select,textarea')].map(e=>({tag:e.tagName,type:e.type||'',name:e.name||'',id:e.id||'',placeholder:e.placeholder||'',label:label(e),required:!!e.required,max:e.max||'',options:e.tagName==='SELECT'?[...e.options].map(o=>o.text.trim()).slice(0,20):[]})),buttons:[...document.querySelectorAll('button,input[type=submit],a')].map(e=>(e.innerText||e.value||'').trim()).filter(Boolean).slice(0,80),text:(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').slice(0,5000)};})()`);
      s.lastUrl=info&&info.url||this.slot.wc.getURL();s.message='Inspection captured: '+(info&&info.fields?info.fields.length:0)+' fields';s.inspection=info;await this.capture(s);this.save(s,s.message);
    });
  }

  async attempt(force){
    const cfg=this.config();if(!cfg.enabled||!this.enabledForSlot)return;const s=this.state();if(!force&&s.lastAttemptAt&&Date.now()-s.lastAttemptAt<FIVE_MINUTES)return;
    s.lastAttemptAt=Date.now();s.nextAttemptAt=s.lastAttemptAt+FIVE_MINUTES;s.attempts=Number(s.attempts||0)+1;s.status='attempting';this.save(s,'Attempt '+s.attempts+' started');
    await this.withColorResume('Withdrawal attempt in progress...',async()=>{
      try{
        await this.navigate(ENCASH_URL);
        const payload={receiverName:cfg.receiverName||'',email:cfg.email||'',mobile:cfg.mobile||'',payment:cfg.payment||'GCash'};
        const result=await this.slot.wc.executeJavaScript(`(async()=>{
          const data=${JSON.stringify(payload)},sleep=ms=>new Promise(r=>setTimeout(r,ms));
          const all=()=>[...document.querySelectorAll('input,select,textarea')];
          const key=e=>((e.name||'')+' '+(e.id||'')+' '+(e.placeholder||'')+' '+(e.getAttribute('aria-label')||'')+' '+((e.closest('.form-group,.mb-3,.row')||{}).innerText||'')).toLowerCase();
          const field=words=>all().find(e=>words.some(w=>key(e).includes(w)));
          const set=(e,v)=>{if(!e||!v)return false;const p=Object.getPrototypeOf(e),d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(e,v);else e.value=v;for(const t of['input','change','blur'])e.dispatchEvent(new Event(t,{bubbles:true}));return true;};
          const receiver=field(['receiver name','receiver','recipient','fullname','full name']),email=field(['email']),mobile=field(['mobile','phone','ewallet','e-wallet','account number']);
          const payment=all().find(e=>e.tagName==='SELECT'&&(/payment|method|channel/.test(key(e))||[...e.options].some(o=>/gcash/i.test(o.text))));
          set(receiver,data.receiverName);set(email,data.email);set(mobile,data.mobile);if(payment){const o=[...payment.options].find(o=>/gcash/i.test(o.text));if(o)set(payment,o.value);}
          const amount=field(['amount','cashout','encash']);if(amount&&!amount.value){const max=Number(amount.max||0),page=(document.body&&document.body.innerText||'').replace(/\\s+/g,' '),matches=[...page.matchAll(/(?:network wallet|available(?: balance)?|wallet balance)[^0-9₱P]{0,60}[₱P]?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)/ig)].map(m=>Number(m[1].replace(/,/g,''))).filter(n=>n>=300),v=max>=300?max:(matches.length?Math.max(...matches):0);if(v>0)set(amount,String(v));}
          const missing=[];if(!receiver)missing.push('receiver');if(!email)missing.push('email');if(!mobile)missing.push('mobile');if(!payment)missing.push('payment');if(amount&&!amount.value)missing.push('amount');if(missing.length)return{submitted:false,error:'Missing fields: '+missing.join(', '),url:location.href,text:(document.body.innerText||'').slice(0,1800)};
          const submit=[...document.querySelectorAll('button,input[type=submit],a')].find(e=>/request encashment|submit|cash ?out|withdraw|encash/i.test((e.innerText||e.value||'').trim())&&!/history/i.test(e.innerText||e.value||''));
          if(!submit)return{submitted:false,error:'Submit button not found',url:location.href,text:(document.body.innerText||'').slice(0,1800)};
          submit.click();await sleep(1800);for(let i=0;i<3;i++){const c=[...document.querySelectorAll('button,[role=button],input[type=submit]')].find(e=>/^(yes|confirm|continue|submit|ok|request|proceed)$/i.test((e.innerText||e.value||'').trim())&&!e.disabled);if(!c)break;c.click();await sleep(1800);}await sleep(3000);
          const text=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').trim(),ref=(text.match(/(?:reference|ref(?:erence)?\\s*(?:no|number|#)?)[^A-Z0-9-]*([A-Z0-9-]{5,})/i)||[])[1]||'',failed=/failed|error|invalid|unable|try again|insufficient/i.test(text),zeroWallet=/(?:network|task)\\s+wallet.{0,80}[₱P]\\s*0(?:\\.0+)?\\b/i.test(text),success=(/success(?:ful|fully)?|submitted|pending|request received/i.test(text)||zeroWallet)&&!failed;
          return{submitted:success,failed,reference:ref,url:location.href,text:text.slice(0,1800)};
        })()`);
        s.lastUrl=result&&result.url||this.slot.wc.getURL();s.reference=result&&result.reference||s.reference||'';s.message=compact(result&&(result.error||result.text)||'No result returned');
        if(result&&result.submitted){s.status='submitted';s.payoutStatus='Pending';s.nextAttemptAt=0;}else{s.status='failed';s.nextAttemptAt=Date.now()+FIVE_MINUTES;}
        await this.capture(s);this.save(s,result&&result.submitted?'Withdrawal submitted; retries stopped':'Attempt failed; retry after five minutes');
      }catch(e){s.status='failed';s.message=compact(e.message);s.nextAttemptAt=Date.now()+FIVE_MINUTES;this.save(s,'Attempt error: '+e.message);}
    });
  }
  async checkHistory(force){
    const cfg=this.config();if(!cfg.enabled||!this.enabledForSlot)return;const s=this.state();if(!force&&s.lastCheckAt&&Date.now()-s.lastCheckAt<ONE_HOUR)return;
    s.lastCheckAt=Date.now();s.nextCheckAt=s.lastCheckAt+ONE_HOUR;this.save(s,'Payout history check started');
    await this.withColorResume('Checking payout status...',async()=>{
      try{
        await this.navigate(HISTORY_URL);
        const result=await this.slot.wc.executeJavaScript(`(()=>{const rows=[...document.querySelectorAll('tr,.card,.list-group-item')].map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean),recent=rows.find(t=>/pending|approved|paid|transferred|failed|declined/i.test(t))||rows[0]||'',status=(recent.match(/approved|paid|transferred|pending|failed|declined/i)||[])[0]||'',ref=(recent.match(/(?:reference|ref(?:erence)?\\s*(?:no|number|#)?)[^A-Z0-9-]*([A-Z0-9-]{5,})/i)||[])[1]||'',amount=(recent.match(/[₱P]\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)/i)||[])[1]||'';return{url:location.href,recent:recent.slice(0,1800),status,reference:ref,amount};})()`);
        s.lastUrl=result&&result.url||this.slot.wc.getURL();s.payoutStatus=result&&result.status||s.payoutStatus||'Pending';s.reference=result&&result.reference||s.reference||'';s.amount=result&&result.amount||s.amount||'';s.message=compact(result&&result.recent||'No payout row found');
        if(/approved|paid|transferred/i.test(s.payoutStatus)){s.status='approved';s.nextCheckAt=0;}else if(/failed|declined/i.test(s.payoutStatus)){s.status='failed';s.nextCheckAt=0;}else s.status='pending';
        await this.capture(s);this.save(s,'Payout status: '+(s.payoutStatus||'unknown'));
      }catch(e){s.message=compact(e.message);this.save(s,'History check error: '+e.message);}
    });
  }
}

module.exports={EncashmentController,phParts,defaultState,PH_TIME_ZONE,FIVE_MINUTES,ONE_HOUR};