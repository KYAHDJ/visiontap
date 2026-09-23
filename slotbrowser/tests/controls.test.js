const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Slot } = require('../slot');
const { enqueue, drain } = require('../command-queue');
function makeSlot(id = '11') {
  let reloads = 0;
  const slot = new Slot({ id, name: id, logger() {}, view: { webContents: {
    isDestroyed: () => false, stop() {}, reloadIgnoringCache() { reloads++; },
    executeJavaScript: async () => null
  } } });
  slot.isLoopRunning = true;
  slot.lastActivityTs = 1000;
  slot.status = () => {};
  slot.scheduleNext = () => {};
  slot.startStaggered = () => {};
  return { slot, reloads: () => reloads };
}
test('guard hard reloads only the inactive slot at 60 seconds, even if processing is hung', () => {
  const a = makeSlot('11'), b = makeSlot('12');
  a.slot.isProcessing = true;
  a.slot.checkInactivity(60999);
  assert.equal(a.reloads(), 0);
  a.slot.checkInactivity(61000);
  assert.equal(a.reloads(), 1);
  assert.equal(a.slot.isProcessing, false);
  assert.equal(b.reloads(), 0);
});
test('actual progress resets guard; repeated status or same image does not', () => {
  const { slot, reloads } = makeSlot();
  slot.activityImage = 'same';
  slot.markActivity('same');
  slot.touchAction(); slot.touchProgress();
  assert.equal(slot.lastActivityTs, 1000);
  slot.markActivity('new');
  slot.checkInactivity(slot.lastActivityTs + 59999);
  assert.equal(reloads(), 0);
});
test('manual pause blocks guard and auto-start; explicit refresh preserves pause and counters', async () => {
  const { slot, reloads } = makeSlot();
  slot.taskCount = 50;
  slot.manualPause();
  slot.checkInactivity(Date.now() + 120000);
  slot.ensureRunning();
  assert.equal(reloads(), 0);
  assert.equal(slot.canAutomate(), false);
  await slot.refreshPage('dashboard-refresh', true);
  assert.equal(reloads(), 1);
  assert.equal(slot.dashboardPaused, true);
  assert.equal(slot.taskCount, 50);
});
test('resume clears explicit stop and starts again', () => {
  const { slot } = makeSlot();
  slot.stopLoop('user');
  slot.manualPause();
  slot.manualResume();
  assert.equal(slot.canAutomate(), true);
  assert.ok(slot.guardTimer);
  slot.stopLoop('test cleanup');
  assert.equal(slot.guardTimer, null);
});
test('late async iteration cannot continue after pause and resume', async () => {
  const { slot } = makeSlot();
  let release;
  slot.inject = () => new Promise(r => { release = r; });
  let calls = 0;
  slot.api = async () => { calls++; return null; };
  const work = slot.runIteration();
  slot.manualPause(); slot.manualResume();
  calls = 0;
  release(); await work;
  assert.equal(calls, 0);
  assert.equal(slot.isProcessing, false);
});
test('rapid dashboard commands are delivered in order without losing new arrivals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visiontap-commands-'));
  try {
    enqueue(dir, [{ action: 'pause', slot: '11' }, { action: 'resume', slot: '11' }, { action: 'refresh', slot: '12' }]);
    const seen = [];
    drain(dir, cmd => { seen.push(cmd.action); if (cmd.action === 'pause') enqueue(dir, [{ action: 'pause', slot: '13' }]); });
    drain(dir, cmd => seen.push(cmd.action));
    assert.deepEqual(seen, ['pause', 'resume', 'refresh', 'pause']);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
