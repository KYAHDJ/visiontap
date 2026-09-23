const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const ACTIONS = new Set(['pause', 'resume', 'restart', 'refresh', 'remove']);
let sequence = 0;
function enqueue(dir, commands) {
  fs.mkdirSync(dir, { recursive: true });
  for (const command of commands) {
    if (!ACTIONS.has(command.action)) throw new Error('Invalid slot command');
    const id = `${Date.now()}-${String(sequence++).padStart(8, '0')}-${randomUUID()}`;
    const temp = path.join(dir, id + '.tmp');
    fs.writeFileSync(temp, JSON.stringify({ action: command.action, slot: String(command.slot || 'all') }));
    fs.renameSync(temp, path.join(dir, id + '.json'));
  }
}
function drain(dir, apply) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const full = path.join(dir, file);
    const command = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!ACTIONS.has(command.action)) throw new Error('Invalid queued command');
    apply(command);
    fs.unlinkSync(full);
  }
}
module.exports = { enqueue, drain };
