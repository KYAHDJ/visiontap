'use strict';
const fs = require('node:fs');
const path = require('node:path');

// One small, atomic state file per website, shared by all workers on this VPS.
class SiteRecovery {
  constructor(directory, account, options = {}) {
    this.directory = directory;
    this.account = account;
    this.now = options.now || Date.now;
    this.probe = options.probe || probeWebsite;
    fs.mkdirSync(directory, { recursive: true });
  }
  transaction(host, change) {
    const file = path.join(this.directory, `site-recovery-${host}.json`);
    const lock = file + '.lock';
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Transactions contain no network waits; recover a lock left by a crash.
      try { if (this.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch (_) {}
      return null;
    }
    try {
      let state;
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { state = {}; }
      const result = change(state);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temp, file);
      return result;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  async failure(workUrl, reason) {
    const host = new URL(workUrl).hostname;
    if (!['ecnlmediamarket.com', 'pmath100.com'].includes(host)) throw Error('Unknown recovery host');
    const now = this.now();
    const claim = this.transaction(host, state => {
      state.failures ||= {};
      for (const [account, row] of Object.entries(state.failures)) {
        if (now - row.at > 45000) delete state.failures[account];
      }
      state.failures[this.account] = { at: now, reason };
      const shared = Object.keys(state.failures).length >= 2;
      const due = now >= (state.nextProbeAt || 0);
      if (due) { state.nextProbeAt = now + 10000; state.probeToken = `${this.account}:${now}`; }
      return { due, token: state.probeToken, shared };
    });
    if (!claim) return { wait: true, shared: true, detail: 'coordinating website recovery' };
    if (claim.due) {
      let result;
      try { result = await this.probe(`https://${host}/login`); }
      catch (error) { result = { online: false, detail: error.code || error.name || 'probe failed' }; }
      this.transaction(host, state => {
        if (state.probeToken === claim.token) state.probe = { ...result, at: this.now() };
      });
    }
    return this.transaction(host, state => {
      const probe = state.probe;
      const online = !!(probe?.online && this.now() - probe.at < 15000);
      if (!online) return { wait: true, shared: claim.shared, detail: probe?.detail || 'checking website availability' };
      // A healthy login page is only a hint. Reopen one affected task page at a
      // time; real task progress, not the probe, proves account recovery.
      if (this.now() < (state.nextRetryAt || 0)) return { wait: true, shared: claim.shared, detail: 'staggering task-page retries' };
      state.nextRetryAt = this.now() + 2500;
      return { wait: false, shared: claim.shared, online: true, detail: probe.detail };
    }) || { wait: true, shared: true, detail: 'coordinating website recovery' };
  }
  healthy(workUrl) {
    this.transaction(new URL(workUrl).hostname, state => { if (state.failures) delete state.failures[this.account]; });
  }
}

async function probeWebsite(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
  // Do not download the full page or bypass a verification challenge.
  await response.body?.cancel();
  return { online: response.status >= 200 && response.status < 400, detail: `HTTP ${response.status}` };
}
module.exports = { SiteRecovery, probeWebsite };
