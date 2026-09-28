const test = require('node:test');
const assert = require('node:assert/strict');
const { startupSlots, slotBounds } = require('../slot-config');
const { Slot } = require('../slot');

test('fresh install and empty reset restore all seven accounts in row order', () => {
  for (const saved of [{}, { active: [] }]) assert.deepEqual(startupSlots(saved).map(s => s.accountName), ['kyaiko','adaihbi','temi','axceling1001','danicajgb','nnnikkikim','darlenejoyce']);
});

test('restart preserves the explicitly saved slot list, task modes, pauses, and stops', () => {
  const slots = startupSlots({ active: [{ id:'14',accountName:'kyaiko' }, { id:'12',accountName:'temi',paused:true,stopRequested:true }] });
  assert.equal(slots.length,2);
  assert.equal(slots[0].taskMode,'math');
  assert.equal(slots[1].paused,true);
  assert.equal(slots[1].stopRequested,true);
});

test('three top slots and two bottom slots fit and do not overlap', () => {
  for (const [w,h] of [[1280,1024],[1440,800]]) {
    const b=slotBounds(5,w,h);
    assert.equal(b[0].y,b[2].y);assert.equal(b[3].y,b[4].y);assert.ok(b[3].y>=b[0].y+b[0].height);
    for(const r of b) {assert.ok(r.x>=0 && r.y>=82);assert.ok(r.x+r.width<=w && r.y+r.height<=h);}
  }
});

test('new accounts use exactly 0.7s and 3s', () => {
  for(const [user,id,ms] of [['axceling1001','15',700],['nnnikkikim','16',3000]]) assert.equal(Slot.prototype.getSubmitDelayMs.call({id,_creds:{user}}),ms);
});