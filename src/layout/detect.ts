// Box detection: a page's characters → lines → paragraphs → boxes, with panels, tables and
// a reading order. Stages: rules.ts (rule segments, panel candidates, pictures), tables.ts (grids), lines.ts
// (characters → lines and words), paragraphs.ts, boxes.ts, order.ts (XY-cut). Every threshold is in
// DEFAULT_THRESHOLDS and can be overridden through opts.thresholds.
import type { Box, DetectOptions, Line, PageInput, Panel, Paragraph, Rect, Result, Table, Thresholds } from './types.ts';
import type { Frame } from './geom.ts';
import { area, inside, rectDistance, spanOf, union } from './geom.ts';
import { panelCandidates, pictures, ruleSegments } from './rules.ts';
import { findTables } from './tables.ts';
import { buildLines } from './lines.ts';
import type { LineRec } from './lines.ts';
import { buildParagraphs } from './paragraphs.ts';
import { buildBoxes } from './boxes.ts';
import type { Node } from './order.ts';
import { readingOrder } from './order.ts';

export const DEFAULT_THRESHOLDS: Thresholds = {
  baselineTol: 0.25, lineGap: 1.5, gutterGap: 1.0, gutterWindow: 5, wordGap: 0.2, cjkSpaceGap: 1.0,
  verticalStepMin: 0.6, verticalStepMax: 1.8, verticalAxisTol: 0.25,
  sizeTol: 0.1, paraStep: 1.6, paraStepWide: 2.6, leadingJump: 0.25, alignTol: 0.25, alignStrict: 0.08, alignStrictPt: 0.75,
  maxIndent: 4, shortLine: 2, columnTol: 0.5, boxGap: 1,
  panelTol: 2, panelMinArea: 1.5, panelMinHeight: 1.3,
  labelWords: 3, labelCjk: 12, labelPanelHeight: 4, labelNear: 1.5,
  cutGapX: 3, cutGapY: 0.5,
};

export function detectBoxes(page: PageInput, opts: DetectOptions = {}): Result {
  const t0 = performance.now();
  const th: Thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const segs = ruleSegments(page.shapes);
  const grids = findTables(segs);
  const cands = panelCandidates(page);
  const pics = pictures(page.shapes);
  const { lines, gutterSplits } = buildLines(page, segs, th);

  // table cells and panel candidates per line
  const cellBase: number[] = [];
  const cellRect: Rect[] = [];
  const cellOwner: { t: number; k: number }[] = [];
  for (const [t, g] of grids.entries()) {
    cellBase.push(cellRect.length);
    for (const [k, r] of g.regions.entries()) { cellRect.push(r.rect); cellOwner.push({ t, k }); }
  }
  for (const L of lines) {
    const cx = (L.box.x0 + L.box.x1) / 2, cy = (L.box.y0 + L.box.y1) / 2;
    for (let c = 0; c < cellRect.length; c++) {
      const r = cellRect[c];
      if (cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1) { L.cell = c; break; }
    }
    const la = area(L.box), lh = L.hi - L.lo;
    // A panel is painted behind its text. A filled shape painted after the line (a reviewer's callout, a sticker,
    // a highlight on top) is an overlay and never groups or splits text.
    let zText = Infinity;
    for (const g of L.ink) { const z = page.textObjects[g.obj]?.z; if (z !== undefined && z < zText) zText = z; }
    let best = -1, bestArea = Infinity;
    for (const si of cands) {
      if (page.shapes[si].z > zText) continue;
      const b = page.shapes[si].bounds;
      if (!inside(L.box, b, th.panelTol)) continue;
      const a = area(b), sp = spanOf(L.frame, b);
      if (a < th.panelMinArea * la || sp.v1 - sp.v0 < th.panelMinHeight * lh) continue;
      if (a < bestArea) { best = si; bestArea = a; }
    }
    L.panel = best;
  }

  const paraRecs = buildParagraphs(lines, segs, th);
  const frames = new Map<string, Frame>(lines.map((l) => [l.group, l.frame]));
  const boxRecs = buildBoxes(paraRecs, frames, segs, th);

  // box frames and panels
  const frameOf = (paras: number[]) => paras.reduce<Rect | null>((r, p) => union(r, paraRecs[p].box), null)!;
  const bFrames = boxRecs.map((b) => frameOf(b.paras));
  // The frame a box reports is its lines' line boxes, not their ink: each horizontal line spans its characters' loose
  // boxes (full advance, font ascent to descent), top to bottom over all of them. Vertical and rotated lines keep their ink box.
  const lineFrame = lines.map((L) => {
    if (L.vertical || L.angle !== 0) return L.box;
    const cs = L.ink.map((g) => page.chars[g.i]).filter((c) => c && c.loose.x1 > c.loose.x0 && c.loose.y1 > c.loose.y0);
    if (!cs.length) return L.box;
    return { x0: Math.min(...cs.map((c) => c.loose.x0)), x1: Math.max(...cs.map((c) => c.loose.x1)), y0: Math.min(...cs.map((c) => c.loose.y0)), y1: Math.max(...cs.map((c) => c.loose.y1)) };
  });
  const outFrame = boxRecs.map((b) => b.paras.flatMap((p) => paraRecs[p].lines).reduce<Rect | null>((r, li) => union(r, lineFrame[li]), null)!);
  const kept = new Set<number>();
  for (const b of boxRecs) if (b.panel >= 0) kept.add(b.panel);
  for (const si of cands) {
    const s = page.shapes[si].bounds;
    if (kept.has(si)) continue;
    if (bFrames.some((f) => inside(f, s, th.panelTol) && area(s) > area(f))) kept.add(si);
  }
  const panelShapes = [...kept].sort((a, b) => a - b);
  const innermost = (r: Rect, among: number[]) => {
    let best = -1, bestArea = Infinity;
    for (const si of among) {
      const s = page.shapes[si].bounds;
      if (inside(r, s, th.panelTol) && area(s) < bestArea) { best = si; bestArea = area(s); }
    }
    return best;
  };
  const boxPanel = boxRecs.map((b, k) => (b.panel >= 0 ? b.panel : innermost(bFrames[k], panelShapes)));

  // tables with at least one cell box
  const cellBox = new Map<number, number>();   // global cell → box index
  boxRecs.forEach((b, k) => { if (b.cell >= 0 && !cellBox.has(b.cell)) cellBox.set(b.cell, k); });
  const keptGrids = grids.map((_, t) => t).filter((t) => grids[t].regions.some((_, k) => cellBox.has(cellBase[t] + k)));

  // labels
  const kinds: Box['kind'][] = boxRecs.map((b) => (b.cell >= 0 ? 'cell' : 'text'));
  const panelCount = new Map<number, number>();
  boxPanel.forEach((p) => { if (p >= 0) panelCount.set(p, (panelCount.get(p) ?? 0) + 1); });
  for (const [k, b] of boxRecs.entries()) {
    if (kinds[k] !== 'text' || b.paras.length !== 1 || paraRecs[b.paras[0]].lines.length !== 1) continue;
    const L = lines[paraRecs[b.paras[0]].lines[0]];
    const words = L.text.split(/\s+/).filter(Boolean).length;
    const cjk = L.ink.filter((g) => g.cjk).length;
    if (!(cjk === 0 ? words <= th.labelWords : L.ink.length <= th.labelCjk)) continue;
    const lh = 1.2 * L.size;
    const p = boxPanel[k];
    let label = false;
    if (p >= 0 && (panelCount.get(p) ?? 0) === 1) {
      const sp = spanOf(L.frame, page.shapes[p].bounds);
      if (sp.v1 - sp.v0 <= th.labelPanelHeight * lh) label = true;
    }
    if (!label && pics.some((r) => rectDistance(r, bFrames[k]) <= th.labelNear * L.size)) {
      label = !bFrames.some((f, j) => j !== k && rectDistance(f, bFrames[k]) < th.boxGap * lh);
    }
    if (label) kinds[k] = 'label';
  }

  // reading order: tables and panels are nodes of their own
  const tableNodes: Node[] = keptGrids.map((t) => {
    const g = grids[t];
    const kids: Node[] = [];
    for (const [k] of g.regions.map((r, k) => [k, r] as const).sort((a, b) => a[1].r - b[1].r || a[1].c - b[1].c)) {
      const bi = cellBox.get(cellBase[t] + k);
      if (bi !== undefined) kids.push({ frame: bFrames[bi], vertical: boxRecs[bi].group === 'v', box: bi });
    }
    // cells of the grid in other directions or extra boxes in a cell
    boxRecs.forEach((b, bi) => {
      if (b.cell >= 0 && cellOwner[b.cell].t === t && !kids.some((n) => n.box === bi)) kids.push({ frame: bFrames[bi], vertical: b.group === 'v', box: bi });
    });
    return { frame: g.frame, vertical: false, kids, rowMajor: true };
  });
  const nodePanels = panelShapes.filter((si) => !keptGrids.some((t) => inside(page.shapes[si].bounds, grids[t].frame, 1)));
  const container = (r: Rect, self = -1) => {
    let best = -1, bestArea = Infinity;
    for (const si of nodePanels) {
      if (si === self) continue;
      const s = page.shapes[si].bounds;
      if (inside(r, s, th.panelTol) && area(s) < bestArea && (self < 0 || area(s) > area(page.shapes[self].bounds))) { best = si; bestArea = area(s); }
    }
    return best;
  };
  const panelNode = new Map<number, Node>(nodePanels.map((si) => [si, { frame: page.shapes[si].bounds, vertical: false, kids: [] }]));
  const root: Node[] = [];
  const place = (n: Node, c: number) => (c >= 0 ? panelNode.get(c)!.kids!.push(n) : root.push(n));
  for (const si of nodePanels) place(panelNode.get(si)!, container(page.shapes[si].bounds, si));
  keptGrids.forEach((t, j) => place(tableNodes[j], container(grids[t].frame)));
  boxRecs.forEach((b, bi) => {
    if (b.cell >= 0 && keptGrids.includes(cellOwner[b.cell].t)) return;
    const c = nodePanels.includes(boxPanel[bi]) ? boxPanel[bi] : container(bFrames[bi]);
    place({ frame: bFrames[bi], vertical: b.group === 'v', box: bi }, c);
  });
  for (const n of panelNode.values()) {
    const v = n.kids!.filter((k) => k.vertical).length;
    n.vertical = v * 2 > n.kids!.length;
  }
  const order = readingOrder(root, th);
  const seen = new Set(order);
  boxRecs.forEach((_, bi) => { if (!seen.has(bi)) order.push(bi); });

  // output, renumbered in reading order
  const outLines: Line[] = [];
  const outParas: Paragraph[] = [];
  const outBoxes: Box[] = [];
  const lineIndex = new Map<number, number>();
  const id = (o: number) => `b${o}`;
  const boxId = new Map<number, string>();
  order.forEach((bi, o) => boxId.set(bi, id(o)));
  const panelIndex = new Map(panelShapes.map((si, k) => [si, k]));
  const tableIndex = new Map(keptGrids.map((t, k) => [t, k]));
  for (const [o, bi] of order.entries()) {
    const b = boxRecs[bi];
    const pIdx: number[] = [];
    const chars: number[] = [];
    for (const pi of b.paras) {
      const P = paraRecs[pi];
      const lIdx: number[] = [];
      for (const li of P.lines) {
        if (!lineIndex.has(li)) { lineIndex.set(li, outLines.length); outLines.push(lineOut(lines[li])); }
        lIdx.push(lineIndex.get(li)!);
        for (const g of lines[li].glyphs) chars.push(g.i);
      }
      pIdx.push(outParas.length);
      outParas.push({ lines: lIdx, text: P.text, box: P.box, align: P.align, size: P.size, leading: round2(P.leading), indent: P.indent, bullet: P.bullet });
    }
    chars.sort((p, q) => p - q);
    const objs = [...new Set(chars.map((i) => page.chars[i].obj).filter((x) => x >= 0))].sort((p, q) => p - q);
    outBoxes.push({
      id: id(o), kind: kinds[bi], frame: outFrame[bi], paragraphs: pIdx, text: pIdx.map((k) => outParas[k].text).join('\n'),
      objs, chars, vertical: lines[paraRecs[b.paras[0]].lines[0]].vertical, angle: lines[paraRecs[b.paras[0]].lines[0]].angle, order: o,
      panel: boxPanel[bi] >= 0 ? panelIndex.get(boxPanel[bi])! : null,
      table: b.cell >= 0 && tableIndex.has(cellOwner[b.cell].t) ? tableIndex.get(cellOwner[b.cell].t)! : null,
    });
  }
  const panels: Panel[] = panelShapes.map((si, k) => ({
    shape: si, frame: page.shapes[si].bounds, fill: page.shapes[si].fill,
    boxes: outBoxes.filter((b) => b.panel === k).map((b) => b.id),
  }));
  const tables: Table[] = keptGrids.map((t) => {
    const g = grids[t];
    return { frame: g.frame, rows: g.rows, cols: g.cols, cells: g.slot.map((k) => { const bi = cellBox.get(cellBase[t] + k); return bi === undefined ? '' : boxId.get(bi)!; }) };
  });
  const result: Result = { lines: outLines, paragraphs: outParas, boxes: outBoxes, panels, tables, skipped: [], ms: 0 };
  if (opts.debug) result.debug = { rules: segs.map((s) => ({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 })), panelCandidates: cands, gutterSplits };
  result.ms = performance.now() - t0;
  return result;
}

function lineOut(L: LineRec): Line {
  let baseline = L.v;
  if (!L.vertical && L.frame.axis && L.angle !== 0) baseline = L.angle === 90 ? -L.v : L.angle === 180 ? -L.v : L.v;
  return { chars: L.glyphs.map((g) => g.i), words: L.words, text: L.text, box: L.box, baseline: round2(baseline), size: L.size, vertical: L.vertical, angle: L.angle };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
