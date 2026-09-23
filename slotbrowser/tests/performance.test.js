const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../inject/slot_inject.js'), 'utf8');

function harness() {
  const timers = [], observers = [];
  let scans = 0, scrolls = 0;
  const target = { getBoundingClientRect: () => ({ top: 385, height: 30 }), scrollIntoView: () => scrolls++ };
  const context = vm.createContext({
    document: { body: {}, querySelector: () => target },
    window: { innerHeight: 800, location: { hash: '' } },
    setTimeout: fn => { timers.push(fn); return timers.length; }, setInterval() {},
    nukeAds: () => scans++,
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} }
  });
  vm.runInContext(source.slice(source.indexOf('  let _adObserver'), source.indexOf('  // ---- Auto-login')), context);
  vm.runInContext(source.slice(source.indexOf('  function centerTaskArea()'), source.lastIndexOf('})();')), context);
  return { timers, observers, target, context, scans: () => scans, scrolls: () => scrolls };
}
const pageChange = [{ target: { nodeType: 1, closest: () => null } }];
const hudChange = [{ target: { nodeType: 1, closest: () => ({}) } }];
test('100 page updates produce one ad scan and one centering pass', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.observers.forEach(fn => fn(pageChange));
  assert.equal(h.timers.length, 2);
  h.timers.splice(0).forEach(fn => fn());
  assert.equal(h.scans(), 1);
  assert.equal(h.scrolls(), 0);
  h.observers.forEach(fn => fn(pageChange));
  assert.equal(h.timers.length, 2);
});
test('HUD updates do not trigger whole-page scans or scrolling', () => {
  const h = harness();
  h.observers.forEach(fn => fn(hudChange));
  assert.equal(h.timers.length, 0);
});
test('off-center task still scrolls into view', () => {
  const h = harness();
  h.target.getBoundingClientRect = () => ({ top: 1200, height: 30 });
  h.context.centerTaskArea();
  assert.equal(h.scrolls(), 1);
});
