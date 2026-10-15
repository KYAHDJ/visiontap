#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ACCOUNT = 'adaihbi1001';
const LOGIN_URL = 'https://keycashv2.pro/?c=login';
const GAME_URL = 'https://keycashv2.pro/?start-game=typing';
const ROOT = process.env.VT_KEYCASH_STATE_DIR || path.join(os.homedir(), '.config', 'VisionTap-KeyCash');
const PASSWORD_FILE = process.env.VT_KEYCASH_PASSWORD_FILE || path.join(ROOT, 'password');
const PROFILE_DIR = process.env.VT_KEYCASH_PROFILE || path.join(ROOT, 'chrome');
const STATE_FILE = path.join(ROOT, 'state.json');
const LOAD_LIMIT = Number(process.env.VT_KEYCASH_LOAD_LIMIT || 14);
const MEMORY_FLOOR_MB = Number(process.env.VT_KEYCASH_MEMORY_FLOOR_MB || 1024);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let context;
let page;
let rounds = 0;
let errors = 0;
let startedAt = Date.now();
let lastCreditAt = 0;
let lastProgressAt = Date.now();
let lastBalance = 0;

function writeState(status, extra = {}) {
  fs.mkdirSync(ROOT, { recursive:true });
  const state = { account:ACCOUNT, running:true, status, rounds, errors, balance:lastBalance, startedAt, lastCreditAt, lastProgressAt, updatedAt:Date.now(), ...extra };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function availableMemoryMb() {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const match = text.match(/^MemAvailable:\s+(\d+) kB/m);
  return match ? Number(match[1]) / 1024 : os.freemem() / 1048576;
}

async function waitForCapacity() {
  while (os.loadavg()[0] > LOAD_LIMIT || availableMemoryMb() < MEMORY_FLOOR_MB) {
    writeState('Paused to protect ECNL workers', { load:Number(os.loadavg()[0].toFixed(2)), availableMemoryMb:Math.round(availableMemoryMb()) });
    await sleep(60000);
  }
}

async function readBalance() {
  const text = await page.locator('body').innerText().catch(() => '');
  const matches = [...text.matchAll(/₱\s*([0-9]+(?:\.[0-9]{1,3})?)/g)].map(match => Number(match[1])).filter(Number.isFinite);
  if (matches.length) lastBalance = matches[0];
  return lastBalance;
}

async function login() {
  await page.goto(LOGIN_URL, { waitUntil:'domcontentloaded', timeout:30000 });
  const user = page.locator('input[name="username"], input[name="user"], input[type="text"]').first();
  const pass = page.locator('input[name="password"], input[type="password"]').first();
  if (!(await pass.count())) return;
  const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  await user.fill(ACCOUNT);
  await pass.fill(password);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForURL(url => !String(url).includes('c=login'), { timeout:20000 });
  await readBalance();
}

async function ensureGame() {
  if (!page || page.isClosed()) throw new Error('KeyCash page closed');
  if (/c=login/.test(page.url())) await login();
  if (!/c=typing/.test(page.url())) {
    await page.goto(GAME_URL, { waitUntil:'domcontentloaded', timeout:30000 });
    if (/c=login/.test(page.url())) { await login(); await page.goto(GAME_URL, { waitUntil:'domcontentloaded', timeout:30000 }); }
  }
  await page.locator('#word-input').waitFor({ state:'attached', timeout:20000 });
  const ok = page.getByRole('button', { name:/^OK$/i }).first();
  if (await ok.isVisible().catch(() => false)) await ok.click({ force:true }).catch(() => {});
}

async function completeRound() {
  await waitForCapacity();
  await ensureGame();
  const start = page.locator('#start-btn');
  await start.waitFor({ state:'visible', timeout:30000 });
  if (await start.isEnabled()) await start.click({ force:true });
  let previous = '';
  for (let index = 0; index < 5; index++) {
    const input = page.locator('#word-input');
    await input.waitFor({ state:'visible', timeout:15000 });
    await page.waitForFunction(() => { const el=document.querySelector('#word-input'); return el && !el.disabled; }, null, { timeout:30000 });
    const word = (await page.locator('#word-display').innerText()).trim();
    if (!word) throw new Error(`Missing KeyCash word at step ${index + 1}`);
    previous = word;
    await input.fill(word);
    await input.press('Enter');
    lastProgressAt = Date.now();
    writeState(`Answered ${index + 1}/5`, { currentWordLength:word.length });
    await page.waitForFunction(({word,index}) => {
      const shown=(document.querySelector('#word-display')?.textContent||'').trim();
      const score=(document.querySelector('#score')?.textContent||'').trim();
      return shown !== word || score.startsWith(String(index + 1)) || /completed|cooldown|next/i.test(document.body.innerText);
    }, {word,index}, { timeout:30000 });
  }
  await page.waitForFunction(() => /completed|cooldown|next/i.test(document.body.innerText) || !document.querySelector('#word-input') || document.querySelector('#word-input').disabled, null, { timeout:20000 }).catch(() => {});
  await sleep(1500);
  const before = lastBalance;
  await readBalance();
  rounds++;
  if (lastBalance > before) lastCreditAt = Date.now();
  lastProgressAt = Date.now();
  writeState('Round completed', { lastRoundAt:Date.now() });
  await page.waitForFunction(() => { const button=document.querySelector('#start-btn'); return button && !button.disabled; }, null, { timeout:45000 });
}

async function recover(error) {
  errors++;
  writeState('Recovering', { error:String(error.message || error).slice(0,240) });
  await sleep(Math.min(60000, 5000 * errors));
  if (page && !page.isClosed()) await page.reload({ waitUntil:'domcontentloaded', timeout:30000 }).catch(() => {});
  if (errors >= 4) throw error;
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive:true });
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath:'/opt/google/chrome/chrome', headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-sync','--disable-extensions','--disable-notifications','--disable-gpu']
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);
  writeState('Starting');
  while (true) {
    try { await completeRound(); errors = 0; }
    catch (error) { await recover(error); }
  }
}

process.on('SIGTERM', async () => { writeState('Stopped', { running:false }); if (context) await context.close().catch(() => {}); process.exit(0); });
main().catch(error => { writeState('Failed', { running:false, error:String(error.stack || error).slice(0,500) }); process.exit(1); });
