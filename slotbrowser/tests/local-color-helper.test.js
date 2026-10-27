const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installColorHelper } = require('../local-color-helper');

function fixture() {
  const box = (left,top,width,height) => ({left,top,width,height,right:left+width,bottom:top+height});
  const element = (bounds,fill='rgb(30, 136, 229)') => ({
    checkVisibility:()=>true, getBoundingClientRect:()=>bounds,
    style:{fill,fillOpacity:'1',opacity:'1'}
  });
  const shapes = Array.from({length:36},(_,i)=>element(box(100+i%6*50,100+Math.floor(i/6)*50,35,35)));
  shapes[19].style.fill='rgb(255, 143, 0)';
  const hidden = {checkVisibility:()=>false, getBoundingClientRect:()=>{throw Error('Hidden element read');}};
  const svg = Object.assign(element(box(90,90,320,320)),{querySelectorAll:()=>[hidden,...shapes].reverse()});
  // The question may be above the viewport after the user scrolls, but it is
  // still rendered page content and must remain readable by the helper.
  const heading = Object.assign(element(box(90,-50,320,30)),{innerText:'What is the color of shape number 20?',classList:{contains:()=>true}});
  const input = Object.assign(element(box(90,430,320,40)),{value:'',events:[],dispatchEvent(event){this.events.push(event.type);}});
  const button = Object.assign(element(box(420,430,100,40)),{
    disabled:true, clicks:0, innerText:'Submit', textContent:'Submit',
    getAttribute:()=>null, click(){this.clicks++;}
  });
  const task = Object.assign(element(box(80,40,350,450)),{
    children:[heading],querySelector:selector=>selector==='#task-answer'?input:svg,
    querySelectorAll:selector=>selector==='button'?[button]:[]
  });
  let panel, tick;
  const context = {
    location:{hostname:'fixture.test'},window:{},innerHeight:800,innerWidth:1000,
    HTMLInputElement:function(){},Event:function(type){this.type=type;},
    setInterval:fn=>{tick=fn;},getComputedStyle:el=>el.style,
    document:{querySelectorAll:()=>[task],createElement:()=>({style:{},setAttribute(){}}),
      body:{appendChild(el){panel=el;el.isConnected=true;}}}
  };
  Object.defineProperty(context.HTMLInputElement.prototype,'value',{set(value){this.value=value;}});
  vm.runInNewContext(`(${installColorHelper.toString()})('fixture.test')`,context);
  return {get panel(){return panel;},tick,heading,shapes,input,button};
}

test('helper fills, waits for an enabled Submit, clicks once, and advances on a new task',()=>{
  const f=fixture();
  assert.equal(f.input.value,'orange');
  assert.deepEqual(f.input.events,['input','change']);
  assert.match(f.panel.textContent,/Shape 20: ORANGE/);
  f.tick();
  assert.equal(f.button.clicks,0);
  assert.match(f.panel.textContent,/Waiting for Submit/);
  f.button.disabled=false;
  f.tick();
  assert.equal(f.button.clicks,1);
  f.tick();
  assert.equal(f.button.clicks,1);
  assert.match(f.panel.textContent,/Submitted/);

  // A new rendered task/input may be reused by the app. Clearing it allows
  // the next detected answer to fill, while the old submission is not repeated.
  f.input.value='';
  f.heading.innerText='What is the color of shape number 1?';
  f.tick();
  assert.equal(f.input.value,'blue');
  f.tick();
  assert.equal(f.button.clicks,2);
  f.shapes[0].style.fill='url(#gradient)';
  f.input.value='';
  f.tick();
  assert.match(f.panel.textContent,/ambiguous/);
  assert.doesNotMatch(installColorHelper.toString(),/requestSubmit|\.submit\(/);
});
