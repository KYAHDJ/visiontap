const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Slot } = require('../slot');

const source = fs.readFileSync(path.join(__dirname, '../inject/slot_inject.js'), 'utf8');
const submitCode = source.slice(source.indexOf('  async function pasteAndSubmit('), source.indexOf('  // ---- EXACT Chrome extension: 60-Second'));
const readyCode = source.slice(source.indexOf('  vt.checkInputReady ='), source.indexOf('  vt.grabImage ='));

function harness(value = 'blue', afterWait = () => {}) {
  let now = 1000;
  const writes = [], clicks = [], waits = [];
  class Input {
    constructor() { this.current = value; this.disabled = false; }
    get value() { return this.current; }
    set value(v) { writes.push(v); this.current = v; }
    dispatchEvent() {}
    getBoundingClientRect() { return { width: 100, height: 30 }; }
  }
  const box = new Input();
  const button = { disabled: false, click() { clicks.push(now); }, getBoundingClientRect: box.getBoundingClientRect };
  const state = { image: 'task-a', box, button };
  const context = vm.createContext({
    vt: {}, Date: { now: () => now }, performance: { now: () => now }, Number, Math, String, Object,
    window: { HTMLInputElement: Input, location: { href: 'https://ecnlmediamarket.com/solving-colors' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    document: { body: { innerText: 'Task', innerHTML: 'x'.repeat(2500) } },
    Event: class {}, signal() {},
    isUIFullyLoaded: () => true, isCheckingState: () => false,
    findAnswerInput: () => state.box, findSubmitButton: () => state.button,
    grabTaskImage: async () => state.image,
    sleep: async ms => { waits.push(ms); now += ms; afterWait(state); }
  });
  vm.runInContext(submitCode + '\n' + readyCode, context);
  return { context, state, writes, clicks, waits, submit: options => context.pasteAndSubmit('blue', { expectedImage: 'task-a', readyAt: 1000, ...options }) };
}

for (const [user, delayMs] of [['adaihbi', 0], ['temi', 500], ['danicajgb', 4000], ['axceling1001', 1000], ['nnnikkikim', 4500]]) {
  test(`${user}: one ${delayMs}ms delay, no clearing or retyping existing answer`, async () => {
    const slot = { id: 99, _creds: { user }, accountName: '' };
    assert.equal(Slot.prototype.getSubmitDelayMs.call(slot), delayMs);
    const h = harness();
    assert.equal(h.context.vt.checkInputReady().ready, true);
    assert.equal(h.state.box.value, 'blue');
    const result = await h.submit({ delayMs });
    assert.equal(result.status, 'filled');
    assert.equal(result.delayMs, 0);
    assert.deepEqual(h.clicks, [1000 + delayMs]);
    assert.deepEqual(h.waits, delayMs ? [delayMs] : []);
    assert.deepEqual(h.writes, []);
  });
}
test('account setting wins over legacy slot ID', () => {
  assert.equal(Slot.prototype.getSubmitDelayMs.call({ id: 11, _creds: { user: ' TEMI ' } }), 500);
});
test('different answer is replaced once without clearing', async () => {
  const h = harness('red');
  await h.submit({ delayMs: 500 });
  assert.deepEqual(h.writes, ['blue']);
  assert.equal(h.clicks.length, 1);
});
test('changed task during wait is never submitted', async () => {
  const h = harness('blue', state => { state.image = 'task-b'; });
  assert.equal((await h.submit({ delayMs: 4000 })).status, 'task-changed');
  assert.deepEqual(h.clicks, []);
});
test('changed answer during wait is never submitted', async () => {
  const h = harness('blue', state => { state.box.current = 'red'; });
  assert.equal((await h.submit({ delayMs: 4000 })).status, 'input-changed');
  assert.deepEqual(h.clicks, []);
});
test('disabled submit button is not counted as a submission', async () => {
  const h = harness();
  h.state.button.disabled = true;
  assert.equal((await h.submit({ delayMs: 500 })).status, 'not-ready');
  assert.deepEqual(h.clicks, []);
});
test('pause during delayed submission cancels the click', async () => {
  let h;
  h = harness('blue', () => { h.context.window.__vtAutomation = { enabled: false, epoch: 2 }; });
  h.context.window.__vtAutomation = { enabled: true, epoch: 1 };
  assert.equal((await h.submit({ delayMs: 4000, epoch: 1 })).status, 'cancelled');
  assert.deepEqual(h.clicks, []);
});
test('pause then resume cannot revive the previous pending submission', async () => {
  let h;
  h = harness('blue', () => { h.context.window.__vtAutomation = { enabled: true, epoch: 3 }; });
  h.context.window.__vtAutomation = { enabled: true, epoch: 1 };
  assert.equal((await h.submit({ delayMs: 4000, epoch: 1 })).status, 'cancelled');
  assert.deepEqual(h.clicks, []);
});

test('old readiness timestamp cannot shorten the full delay after filling', async () => {
  const h = harness('red');
  const result = await h.submit({ delayMs: 4500, readyAt: -9000 });
  assert.equal(result.elapsedMs, 4500);
  assert.deepEqual(h.waits, [4500]);
  assert.deepEqual(h.clicks, [5500]);
});
