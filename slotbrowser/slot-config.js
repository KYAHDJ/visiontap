const DEFAULT_SLOTS = [
  { id: '14', accountName: 'kyaiko' },
  { id: '11', accountName: 'adaihbi' },
  { id: '12', accountName: 'temi' },
  { id: '15', accountName: 'axceling1001' },
  { id: '13', accountName: 'danicajgb' },
  { id: '16', accountName: 'nnnikkikim' },
  { id: '17', accountName: 'darlenejoyce' }
];
function startupSlots(saved = {}) {
  const existing = new Map((saved.active || []).map(s => [String(s.id), s]));
  // Single pmath (kyaiko 14) + 5 ecnl =6; preserve saved including taskMode for hard reset
  if (saved.active && saved.active.length) {
    return saved.active.map(s => ({ ...s, name: s.accountName || s.name, taskMode: s.taskMode || (String(s.id)==="14"||String(s.accountName||"").toLowerCase()==="kyaiko" ? "math" : "color"), bootsOnStart: s.bootsOnStart !== false }));
  }
  return DEFAULT_SLOTS.map(slot => ({ ...existing.get(slot.id), ...slot, name: slot.accountName, taskMode: slot.taskMode || (String(slot.id)==="14"||String(slot.accountName||"").toLowerCase()==="kyaiko" ? "math" : "color"), bootsOnStart: true }));
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
