const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../inject/slot_inject.js'), 'utf8');

test('conversion confirmation works without an optional dismiss dialog', async () => {
  let confirmed = false;
  let buttons;
  const button = (text, click) => ({ innerText:text, click, getBoundingClientRect:() => ({width:100,height:20}) });
  const yes = button('Yes, Convert', () => { confirmed = true; });
  buttons = [button('Convert Coins', () => { buttons = [yes]; })];
  const sandbox = {
    vt:{}, window:{}, sleep:async () => {},
    getComputedStyle:() => ({display:'block',visibility:'visible'}),
    document:{querySelectorAll:selector => selector.startsWith('button,') ? buttons : []}
  };
  const start = source.indexOf('  vt.pmathConfirmPreparedConversion =');
  const end = source.indexOf('\n  vt.pageReady', start);
  vm.runInNewContext(source.slice(start, end), sandbox);
  assert.equal((await sandbox.vt.pmathConfirmPreparedConversion()).status, 'confirmed');
  assert.equal(confirmed, true);
});

test('conversion page cleanup preserves hidden confirmation templates', () => {
  let queried = false;
  const sandbox = { location:{pathname:'/convert-coins'}, document:{querySelectorAll:() => { queried = true; return []; }} };
  const start = source.indexOf('  function nukeAds()');
  const end = source.indexOf('\n  nukeAds();', start);
  vm.runInNewContext(source.slice(start, end) + '\nnukeAds();', sandbox);
  assert.equal(queried, false);
});
