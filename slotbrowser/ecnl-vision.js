'use strict';
// Page-side image analysis for the ECNL colors task (runs inside the page via CDP Runtime.evaluate).
// analyze(src) -> { count, rows, cells:[{x,y,rgb}], badge:{x0,y0,x1,y1}, glyphs:[bitmap strings] }
module.exports = String.raw`
(async function(src){
  const img = new Image(); img.src = src; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, W, H).data;
  const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i+1], d[i+2]]; };
  // ---- shapes: ink mask (dark or strongly coloured), connected components above the text line
  const yMax = Math.round(H * 0.70);
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < yMax; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r = d[i], g = d[i+1], b = d[i+2];
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b), lum = 0.299*r + 0.587*g + 0.114*b;
    if (lum < 175 || (mx - mn) > 80) ink[y*W+x] = 1;
  }
  const seen = new Uint8Array(W * H), comps = [];
  for (let y0 = 0; y0 < yMax; y0++) for (let x0 = 0; x0 < W; x0++) {
    const s0 = y0*W+x0; if (!ink[s0] || seen[s0]) continue;
    const st = [s0]; seen[s0] = 1; let n = 0, x1 = x0, x2 = x0, y1 = y0, y2 = y0;
    while (st.length) { const s = st.pop(); const x = s % W, y = (s / W) | 0; n++;
      if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x+dx, ny = y+dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= yMax) continue; const t = ny*W+nx; if (ink[t] && !seen[t]) { seen[t] = 1; st.push(t); } } }
    const w = x2-x1+1, h = y2-y1+1;
    if (n > 250 && w > 30 && h > 30 && w < 140 && h < 140) comps.push({ x1, x2, y1, y2, cx: (x1+x2)/2, cy: (y1+y2)/2, n });
  }
  // rows: cluster by cy
  comps.sort((a,b) => a.cy - b.cy);
  const rows = []; for (const c of comps) { const r = rows[rows.length-1]; if (r && Math.abs(c.cy - r.cy) < 45) { r.items.push(c); r.cy = r.items.reduce((s,k)=>s+k.cy,0)/r.items.length; } else rows.push({ cy: c.cy, items: [c] }); }
  const cells = [];
  for (let ri = 0; ri < rows.length; ri++) { rows[ri].items.sort((a,b) => a.cx - b.cx);
    for (const c of rows[ri].items) { // median colour of a 9x9 patch at the centre
      const rs = [], gs = [], bs = []; for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const p = px(Math.round(c.cx)+dx, Math.round(c.cy)+dy); rs.push(p[0]); gs.push(p[1]); bs.push(p[2]); }
      const med = a => a.sort((p,q)=>p-q)[a.length>>1];
      cells.push({ row: ri, x: Math.round(c.cx), y: Math.round(c.cy), rgb: [med(rs), med(gs), med(bs)] }); } }
  // ---- badge: gold box in the lower part
  let bx1 = 1e9, bx2 = -1, by1 = 1e9, by2 = -1;
  for (let y = Math.round(H*0.70); y < H; y++) for (let x = 0; x < W; x++) { const [r,g,b] = px(x,y); if (r > 180 && r < 240 && g > 150 && g < 200 && b < 90) { if (x<bx1)bx1=x; if(x>bx2)bx2=x; if(y<by1)by1=y; if(y>by2)by2=y; } }
  // dark glyph pixels inside the badge
  const glyphs = [];
  if (bx2 > 0) {
    const cols = []; for (let x = bx1; x <= bx2; x++) { let c = 0; for (let y = by1; y <= by2; y++) { const [r,g,b] = px(x,y); if (0.299*r+0.587*g+0.114*b < 110) c++; } cols.push(c); }
    let run = null; const runs = [];
    for (let i = 0; i < cols.length; i++) { if (cols[i] > 0) { if (!run) run = { a: bx1+i, b: bx1+i }; else run.b = bx1+i; } else if (run) { runs.push(run); run = null; } }
    if (run) runs.push(run);
    for (const r of runs) { if (r.b - r.a < 3) continue;
      let ya = 1e9, yb = -1; for (let y = by1; y <= by2; y++) for (let x = r.a; x <= r.b; x++) { const [R,G,B] = px(x,y); if (0.299*R+0.587*G+0.114*B < 110) { if (y<ya) ya=y; if (y>yb) yb=y; } }
      glyphs.push({ x1: r.a, x2: r.b, y1: ya, y2: yb }); }
  }
  // bitmap of each glyph normalised to 10x16 (fraction of dark pixels per cell)
  const bm = glyphs.map(g => { const out = []; const gw = g.x2-g.x1+1, gh = g.y2-g.y1+1;
    for (let j = 0; j < 16; j++) for (let i = 0; i < 10; i++) { let dark = 0, tot = 0;
      const xa = g.x1 + Math.floor(i*gw/10), xb = g.x1 + Math.max(Math.floor((i+1)*gw/10), Math.floor(i*gw/10)+1);
      const ya = g.y1 + Math.floor(j*gh/16), yb = g.y1 + Math.max(Math.floor((j+1)*gh/16), Math.floor(j*gh/16)+1);
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { const [r,g2,b] = px(x,y); tot++; if (0.299*r+0.587*g2+0.114*b < 110) dark++; }
      out.push(tot ? +(dark/tot).toFixed(2) : 0); }
    return { w: gw, h: gh, bm: out }; });
  return JSON.stringify({ W, H, count: cells.length, rowCounts: rows.map(r => r.items.length), cells, badge: { x1: bx1, x2: bx2, y1: by1, y2: by2 }, glyphs: bm.map(g => ({ w: g.w, h: g.h })), bm: bm.map(g => g.bm) });
})`;
