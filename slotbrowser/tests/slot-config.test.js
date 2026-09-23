const test = require('node:test');
const assert = require('node:assert/strict');
const { startupSlots, slotBounds } = require('../slot-config');
const { Slot } = require('../slot');
test('fresh install and empty reset restore exactly the five accounts in row order', () => {
  for (const saved of [{}, { active: [] }]) assert.deepEqual(startupSlots(saved).map(s => s.accountName), ['adaihbi','temi','axceling1001','danicajgb','nnnikkikim']);
});
test('restart omits PMATH and preserves existing manual pauses and stops', () => {
  const slots = startupSlots({ active: [{ id:'14',accountName:'kyaiko' }, { id:'12',paused:true,stopRequested:true }] });
  assert.equal(slots.length,5);
  assert.equal(slots.some(s=>s.id==='14'),false);
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
test('new accounts use exactly 1 second and 4 seconds', () => {
  for(const [user,id,ms] of [['axceling1001','15',1000],['nnnikkikim','16',4000]]) assert.equal(Slot.prototype.getSubmitDelayMs.call({id,_creds:{user}}),ms);
});
