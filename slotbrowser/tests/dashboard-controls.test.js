'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

test('all dashboard automation controls use the live control API', () => {
  assert.match(source, /function confirmControl\(/);
  assert.match(source, /fetch\('\/dashboard-control\?action='/);
  for (const action of ['pause', 'resume', 'refresh', 'restart']) {
    assert.match(source, new RegExp(`confirmControl\\(event,(?:'|&quot;)${action}`));
  }
  assert.match(source, /url\.pathname === "\/dashboard-control" && req\.method === "POST"/);
});

test('restart all restarts Chrome workers while refresh only reloads pages', () => {
  assert.match(source, /action === 'restart' \? restartChromeServices\(slot\) : sendChromeControl\(action, slot\)/);
  assert.match(source, /execSync\(`sudo systemctl restart \$\{units\}`/);
  assert.match(source, /action === 'restart' \|\| action === 'refresh' \? 'reload'/);
});

test('Kyaiko uses balance history without a duplicate earnings history', () => {
  assert.match(source, /if\(!isKyaikoCard&&s\.earningsHistory&&s\.earningsHistory\.length>0\)/);
  assert.match(source, /Balance History \(10\)/);
});

test('dashboard includes all five ECNL slots and their controls', () => {
  for (const account of ['adaihbi', 'temi', 'axceling1001', 'clarencebopis', 'connormofu']) {
    assert.match(source, new RegExp(account));
  }
  assert.match(source, /'13':'clarencebopis'/);
  assert.match(source, /'16':'connormofu'/);
  assert.doesNotMatch(source, /\["13","16","17"\]/);
});
