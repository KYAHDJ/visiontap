'use strict';

const fs = require('node:fs');

const file = process.argv[2];
if (!file) throw new Error('Preferences path is required');
const preferences = JSON.parse(fs.readFileSync(file, 'utf8'));
const levels = preferences?.partition?.per_host_zoom_levels;
if (levels && typeof levels === 'object') {
  for (const group of Object.values(levels)) {
    if (group && typeof group === 'object') delete group['ecnlmediamarket.com'];
  }
}
const temporary = `${file}.zoom-reset.tmp`;
fs.writeFileSync(temporary, JSON.stringify(preferences));
fs.renameSync(temporary, file);
