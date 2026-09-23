const DEFAULT_SLOTS = [
  { id: '14', accountName: 'kyaiko' },
  { id: '11', accountName: 'adaihbi' },
  { id: '12', accountName: 'temi' },
  { id: '15', accountName: 'axceling1001' },
  { id: '13', accountName: 'danicajgb' },
  { id: '16', accountName: 'nnnikkikim' }
];
function startupSlots(saved = {}) {
  const existing = new Map((saved.active || []).map(s => [String(s.id), s]));
  // Online/local: if saved has active, merge with DEFAULT to keep all 6; otherwise use defaults
  if (saved.active && saved.active.length === 6) {
    return saved.active.map(s => ({ ...s, name: s.accountName || s.name, bootsOnStart: s.bootsOnStart !== false }));
  }
  return DEFAULT_SLOTS.map(slot => ({ ...existing.get(slot.id), ...slot, name: slot.accountName, bootsOnStart: true }));
}
function slotBounds(count, width, height, toolbar = 82, gap = 8) {
  const columns = Math.min(3, count);
  if (!columns) return [];
  const rows = Math.ceil(count / columns);
  const cellW = Math.max(1, Math.floor((width - gap * (columns + 1)) / columns));
  const cellH = Math.max(1, Math.floor((height - toolbar - gap * (rows + 1)) / rows));
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / columns);
    const inRow = Math.min(columns, count - row * columns);
    const left = Math.floor((width - (inRow * cellW + (inRow - 1) * gap)) / 2);
    return { x: left + (i % columns) * (cellW + gap), y: toolbar + gap + row * (cellH + gap), width: cellW, height: cellH };
  });
}
module.exports = { DEFAULT_SLOTS, startupSlots, slotBounds };
