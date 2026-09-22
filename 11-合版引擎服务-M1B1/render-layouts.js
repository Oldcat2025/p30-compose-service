/**
 * M2 渲染层 —— 各图位版式（D2–D5）
 *
 * 与 D1（在 render-layer.js 主流程内联实现）并列；D1 保持原实现不动。
 * 每个版式只负责「正文区」绘制，品牌栏 / LOGO / 主标题 / 副标题 由主流程统一处理。
 *
 * 入参 ctxObj: { ctx, W, H, pad, contentW, dy, dh, cursorY, d, elements, overflow, measure, roundRect }
 * 约定：数据全部来自 bundle，逐字绘制；每个元素都推入 elements 便于几何验收。
 */

/** ★ P-E 主体避让：把整块内容从"主体所在行带"上挪开（最小位移）
 *  规则：不重叠 → 原地不动（保证同一商品多次渲染版式一致）；重叠 → 在上下限内找重叠最小的位置。 */
function nudgeBlock(c, y, h, opts) {
  const sub = c && c.subject;
  if (!sub || !sub.bbox) return y;
  const b = sub.bbox;
  const o = opts || {};
  const maxUp = o.maxUp != null ? o.maxUp : Math.round((c.dh || 0) * 0.16);
  const maxDown = o.maxDown != null ? o.maxDown : Math.round((c.dh || 0) * 0.16);
  /* ⚠️ minY 必须**同时**避开已画好的标题/副标题区：
     实测踩过 —— 只避主体时，内容块被上移到标题上，把标题第二行压掉一半（冰钻 D3 实拍可见）。
     正文区的下界 = max(画面顶+5%, 标题游标 cursorY)。 */
  /* ⚠️ 余量 0.6%H → 2.2%H：实测 D4「Сравнение вариантов」两行标题的第二行被卡片压住
     —— cursorY 记的是文字位置，标题框本身还有内边距，0.6% 不够。 */
  const minY = Math.max((c.dy || 0) + Math.round((c.dh || 0) * 0.05),
                        Math.round((c.cursorY || 0) + (c.H || 0) * 0.022));
  const maxY = (c.H || 0) - (c.pad || 0) - h - Math.round((c.H || 0) * 0.06);
  const ovl = (yy) => Math.max(0, Math.min(yy + h, b.y + b.h) - Math.max(yy, b.y));
  if (ovl(y) <= 0) return y;
  const curOv = ovl(y);
  // ★ 收益阈值：躲不开时（主体占画面大部分高度）不许硬挪 —— 挪一点点反而把版式搞乱。
  //   只有重叠能减少 minGain 以上，才接受位移；完全避开（<=0）永远接受。
  const minGain = o.minGain != null ? o.minGain : 0.4;
  let best = y, bestOv = curOv;
  for (let sft = -maxUp; sft <= maxDown; sft += 3) {
    const yy = Math.max(minY, Math.min(maxY, y + sft));
    const v = ovl(yy);
    if (v <= 0) { best = yy; bestOv = 0; break; }
    if (v < bestOv - 0.5) { bestOv = v; best = yy; }
  }
  if (bestOv > 0 && bestOv > curOv * (1 - minGain)) return y;
  return best;
}

function bodyTop(ctxObj) {
  // 主标题下方的可用起点（主流程已把 cursorY 推进到副标题之后）
  const y = Math.max(ctxObj.cursorY, ctxObj.dy + Math.round(ctxObj.dh * 0.18));
  // ★ P-E：正文块整体避开商品主体所在行带（不重叠则不动）
  return nudgeBlock(ctxObj, y, Math.round((ctxObj.dh || 0) * 0.30), { maxDown: Math.round((ctxObj.dh || 0) * 0.24) });
}

function card(ctxObj, x, y, w, h, fill, radius) {
  const { ctx, roundRect, W } = ctxObj;
  ctx.save();
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, radius == null ? Math.round(W * 0.012) : radius);
  ctx.fill();
  ctx.restore();
}

/* 品牌套件强调色 → rgba；无套件色时返回 fallback（行为与改造前一致） */
function kitRgba(c, alpha, fallback) {
  const hex = c && c.kitAccent;
  const m = hex ? /^#([0-9A-Fa-f]{6})$/.exec(hex) : null;
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")";
}

function text(ctxObj, t, x, y, px, color, weight, fam, maxW) {
  const { ctx } = ctxObj;
  ctx.save();
  ctx.font = (weight || "700") + " " + px + 'px "' + (fam || "ZernoBodyBold") + '", sans-serif';
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  if (maxW) ctx.fillText(String(t), x, y, maxW); else ctx.fillText(String(t), x, y);
  ctx.restore();
}

/** D2 功能细节图：标题 + N 个带序号的细节标注（2 列网格）+ 底部参数条 */
function drawD2(c) {
  const { W, H, pad, contentW, d, elements, overflow, measure, ctx } = c;
  const items = (Array.isArray(d.bullets) ? d.bullets : []).map((b) => (typeof b === "string" ? { text: b } : b));
  const top = bodyTop(c);
  const cols = items.length > 2 ? 2 : 1;
  const rows = Math.ceil(items.length / cols);
  const gapY = Math.round(H * 0.052);
  const cellW = Math.floor(contentW / cols);
  // 编号圆点 + 标注文字（不依赖模型画细节窗，标注自身即信息）
  items.forEach((it, i) => {
    const r = Math.floor(i / cols), col = i % cols;
    const x = pad + col * cellW;
    const y = top + r * gapY;
    ctx.save();
    ctx.fillStyle = (c.kitAccent || "#0F7B2F");
    ctx.beginPath();
    ctx.arc(x + Math.round(W * 0.022), y + Math.round(W * 0.020), Math.round(W * 0.019), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    text(c, String(i + 1), x + Math.round(W * 0.0115), y + Math.round(W * 0.0065), Math.round(W * 0.026), "#FFFFFF", "800", "ZernoBodyBold");
    const lx = x + Math.round(W * 0.055);
    const maxW = cellW - Math.round(W * 0.075);
    const f = fitInline(c, String(it.text || ""), maxW, 2, Math.round(W * 0.030), "ZernoBodyBold");
    f.lines.forEach((ln, k) => text(c, ln, lx, y + k * Math.round(f.px * 1.15), f.px, "#FFFFFF", "700", "ZernoBodyBold", maxW));
    elements.push({ kind: "detailLabel", index: i, x: lx, y: y, w: Math.round(f.width), text: f.lines.join(" ") });
    if (f.overflowed) overflow.push({ element: "detailLabel[" + i + "]", reason: "标注文字放不下" });
  });
  // 底部参数条（横贯）
  drawParamStrip(c, nudgeBlock(c, H - pad - Math.round(H * 0.055), Math.round(H * 0.055), { maxUp: Math.round(H * 0.10), maxDown: 0 }));
}

/** D3 场景使用图：标题 + 左侧若干标注卡（带引线）+ 底部参数条 */
function drawD3(c) {
  const { W, H, pad, contentW, d, elements, overflow, ctx } = c;
  const items = (Array.isArray(d.bullets) ? d.bullets : []).map((b) => (typeof b === "string" ? { text: b } : b));
  const cardW = Math.round(contentW * 0.52);
  const cardH = Math.round(H * 0.042);
  const shown = items.slice(0, 4);
  // ★ P-E：整组卡片一起避让（此前只有第一张被 bodyTop 挪，后几张照旧压主体）
  const groupH = Math.max(1, shown.length) * Math.round(cardH * 1.35);
  const top = nudgeBlock(c, bodyTop(c), groupH, { maxDown: Math.round((c.dh || 0) * 0.20), maxUp: Math.round((c.dh || 0) * 0.22) });
  shown.forEach((it, i) => {
    const y = top + i * Math.round(cardH * 1.35);
    // ★ 2026-09-18：白底配雪景不突出 → 中灰底 + 白字（灰已按老猫二次反馈调浅、降不透明度）
    card(c, pad - Math.round(W * 0.012), y - Math.round(H * 0.004), cardW, cardH, kitRgba(c, 0.90, "rgba(92,97,104,0.80)"));
    const f = fitInline(c, String(it.text || ""), cardW - Math.round(W * 0.05), 1, Math.round(W * 0.030), "ZernoBodyBold");
    text(c, f.lines[0] || "", pad, y + Math.round(cardH * 0.18), f.px, "#FFFFFF", "700", "ZernoBodyBold", cardW - Math.round(W * 0.04));
    // 引线：卡片右缘 → 画面中部
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, Math.round(W * 0.0022));
    ctx.beginPath();
    const sx = pad + cardW, sy = y + Math.round(cardH / 2);
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.round(W * 0.06), sy);
    ctx.lineTo(sx + Math.round(W * 0.12), sy + Math.round(H * 0.05));
    ctx.stroke();
    ctx.restore();
    elements.push({ kind: "sceneLabel", index: i, x: pad, y: y, w: cardW, h: cardH, text: f.lines[0] || "" });
    if (f.overflowed) overflow.push({ element: "sceneLabel[" + i + "]", reason: "标注放不下" });
  });
  drawParamStrip(c, H - pad - Math.round(H * 0.055));
}

/** D4 对比图：标题 + 左右两栏（左=普通版 灰、右=本品 高亮）+ 底部栏目标签 */
function drawD4(c) {
  const { W, H, pad, contentW, d, elements, overflow, measure } = c;
  const top = bodyTop(c);
  const colGap = Math.round(W * 0.025);
  const colW = Math.floor((contentW - colGap) / 2);
  const h = (d.compareRows || []).length ? 0 : 0; // 行高按条数计算
  const left = (d.compareLeft || []).map((x) => String(x));
  const right = (d.compareRight || []).map((x) => String(x));
  const n = Math.max(left.length, right.length, 1);
  const rowH = Math.round(H * 0.058);
  const boxH = n * rowH + Math.round(H * 0.03);
  // 左栏（普通版）
  card(c, pad, top, colW, boxH, "rgba(245,245,245,0.93)");
  // 右栏（本品）
  card(c, pad + colW + colGap, top, colW, boxH, kitRgba(c, 0.90, "rgba(16,94,44,0.90)"));
  const fpx = Math.round(W * 0.029);
  for (let i = 0; i < n; i++) {
    const y = top + Math.round(H * 0.016) + i * rowH;
    const maxW = colW - Math.round(W * 0.05);
    if (left[i]) {
      const f = fitInline(c, left[i], maxW, 2, fpx, "ZernoBody");
      f.lines.forEach((ln, k) => text(c, ln, pad + Math.round(W * 0.025), y + k * Math.round(f.px * 1.12), f.px, "#555555", "600", "ZernoBody", maxW));
      if (f.overflowed) overflow.push({ element: "compareLeft[" + i + "]", reason: "放不下" });
    }
    if (right[i]) {
      const f2 = fitInline(c, right[i], maxW, 2, fpx, "ZernoBodyBold");
      f2.lines.forEach((ln, k) => text(c, ln, pad + colW + colGap + Math.round(W * 0.025), y + k * Math.round(f2.px * 1.12), f2.px, "#FFFFFF", "700", "ZernoBodyBold", maxW));
      if (f2.overflowed) overflow.push({ element: "compareRight[" + i + "]", reason: "放不下" });
    }
  }
  // 底部栏目标签
  const tagH = Math.round(H * 0.040);
  const tagY = top + boxH + Math.round(H * 0.012);
  card(c, pad, tagY, colW, tagH, "rgba(160,160,160,0.95)");
  const tagPx = Math.round(W * 0.032);
  const tagMaxW = colW - Math.round(W * 0.04);
  const leftTag = String(d.leftTag || "ОБЫЧНЫЙ ВАРИАНТ");
  const leftW = Math.min(measure(leftTag, tagPx, "800", "ZernoBodyBold"), tagMaxW);
  text(c, leftTag, pad + Math.round((colW - leftW) / 2), tagY + Math.round(tagH * 0.2), tagPx, "#FFFFFF", "800", "ZernoBodyBold", tagMaxW);
  card(c, pad + colW + colGap, tagY, colW, tagH, kitRgba(c, 0.98, "rgba(15,123,47,0.98)"));
  const rightTag = String(d.rightTag || "НАША МОДЕЛЬ");
  const rightW = Math.min(measure(rightTag, tagPx, "800", "ZernoBodyBold"), tagMaxW);
  text(c, rightTag, pad + colW + colGap + Math.round((colW - rightW) / 2), tagY + Math.round(tagH * 0.2), tagPx, "#FFFFFF", "800", "ZernoBodyBold", tagMaxW);
  elements.push({ kind: "compareBox", x: pad, y: top, w: contentW, h: boxH, rows: n });
}

/** D5 信息总结图：标题 + 4 个卖点卡（2×2）+ 2×2 参数表 */
/** ★ B（防再犯）：D5 上部卡片的「半截短语」治理。
 *  C6 的提示词里其实**已经写死**了"D5 每个点必须是 参数+数值，光有名字严格禁止"，
 *  但模型照样输出 "Ширина среза" 这种无值短语（提示词硬规则 ≠ 生效 —— 老坑了）。
 *  所以在这里做确定性收口：① 与底部参数表能配上 → 直接补上值；② 既没数字又配不上 → 丢弃。
 *  宁少一张卡，也不要一张没有数字的空卡。 */
function normalizeD5Bullet(txt, params) {
  const t = String(txt == null ? "" : txt).trim();
  if (!t) return "";
  if (/\d/.test(t)) return t;
  const up = t.toUpperCase();
  for (let i = 0; i < (params || []).length; i++) {
    const p = params[i] || {};
    const k = String(p.key || p.k || "").toUpperCase();
    const v = String(p.value || p.v || "");
    if (!k || !v) continue;
    if (up === k || up.indexOf(k) >= 0 || k.indexOf(up) >= 0) return t + " " + v;
  }
  return "";
}

function drawD5(c) {
  const { W, H, pad, contentW, d, elements, overflow } = c;
  const top = bodyTop(c);
  const items = (Array.isArray(d.bullets) ? d.bullets : [])
    .map((b) => (typeof b === "string" ? { text: b } : b))
    .map((b) => ({ text: normalizeD5Bullet(b && b.text, d.params) }))
    .filter((b) => !!b.text)          // ★ B：无值短语直接丢弃
    .slice(0, 4);
  const colGap = Math.round(W * 0.022), rowGap = Math.round(H * 0.012);
  const colW = Math.floor((contentW - colGap) / 2);
  /* 卡片压缩（原 0.075H）：给画面中部的商品留出可视区 */
  const rowH = Math.round(H * 0.060);
  items.forEach((it, i) => {
    const r = Math.floor(i / 2), col = i % 2;
    const x = pad + col * (colW + colGap), y = top + r * (rowH + rowGap);
    // ★ 2026-09-18：白底配雪景不突出 → 中灰底 + 白字（灰已按老猫二次反馈调浅、降不透明度）
    card(c, x, y, colW, rowH, kitRgba(c, 0.90, "rgba(92,97,104,0.80)"));
    const maxW = colW - Math.round(W * 0.045);
    const f = fitInline(c, String(it.text || ""), maxW, 3, Math.round(W * 0.026), "ZernoBodyBold");
    f.lines.forEach((ln, k) => text(c, ln, x + Math.round(W * 0.022), y + Math.round(H * 0.010) + k * Math.round(f.px * 1.16), f.px, "#FFFFFF", "700", "ZernoBodyBold", maxW));
    elements.push({ kind: "featureCard", index: i, x: x, y: y, w: colW, h: rowH });
    if (f.overflowed) overflow.push({ element: "featureCard[" + i + "]", reason: "卖点放不下" });
  });
  /* 参数表下沉到画面底部（原紧跟卡片下方，会把商品整体盖住）。
     中间带留白 = 商品可视区。 */
  const pn = Array.isArray(d.params) ? d.params.length : 0;
  const pRows = pn ? Math.ceil(pn / Math.min(2, pn)) : 0;
  const gridH = pRows * Math.round(H * 0.052) + Math.round(H * 0.02);
  const gTop = Math.max(top + Math.ceil(items.length / 2) * (rowH + rowGap) + Math.round(H * 0.012),
                        H - pad - gridH);
  drawParamGrid(c, gTop, contentW);
}

/** 底部横贯参数条（D2/D3 用） */
function drawParamStrip(c, y) {
  const { W, pad, contentW, d, elements, overflow } = c;
  const params = Array.isArray(d.params) ? d.params : [];
  if (!params.length) return;
  const h = Math.round(c.h * 0.055) || Math.round(c.H * 0.055);
  card(c, pad, y, contentW, h, kitRgba(c, 0.88, "rgba(92,97,104,0.80)"));
  const cellW = Math.floor(contentW / params.length);
  params.forEach((p, i) => {
    const x = pad + i * cellW + Math.round(W * 0.022);
    const maxW = cellW - Math.round(W * 0.04);
    text(c, String(p.key || ""), x, y + Math.round(h * 0.16), Math.round(W * 0.020), "rgba(255,255,255,0.72)", "600", "ZernoBody", maxW);
    text(c, String(p.value == null ? "" : p.value), x, y + Math.round(h * 0.46), Math.round(W * 0.030), "#FFFFFF", "800", "ZernoBodyBold", maxW);
    elements.push({ kind: "param", index: i, x: x, y: y, key: String(p.key || ""), value: String(p.value == null ? "" : p.value) });
    if (c.measure(String(p.value == null ? "" : p.value), Math.round(W * 0.030), "800", "ZernoBodyBold") > maxW) overflow.push({ element: "param[" + i + "]", reason: "value 超宽", value: String(p.value) });
  });
}

/** 2×2 参数表（D5 用） */
function drawParamGrid(c, y, w) {
  const { W, d, elements, overflow, pad } = c;
  const params = Array.isArray(d.params) ? d.params : [];
  if (!params.length) return;
  const cols = Math.min(2, params.length);
  const rows = Math.ceil(params.length / cols);
  const h = rows * Math.round(c.H * 0.052) + Math.round(c.H * 0.02);
  card(c, pad, y, w, h, kitRgba(c, 0.88, "rgba(92,97,104,0.80)"));
  const cellW = Math.floor(w / cols);
  params.forEach((p, i) => {
    const r = Math.floor(i / cols), col = i % cols;
    const x = pad + col * cellW + Math.round(W * 0.025);
    const yy = y + Math.round(c.H * 0.012) + r * Math.round(c.H * 0.052);
    const maxW = cellW - Math.round(W * 0.035);
    text(c, String(p.key || ""), x, yy, Math.round(W * 0.0245), "rgba(255,255,255,0.72)", "600", "ZernoBody", maxW);
    text(c, String(p.value == null ? "" : p.value), x, yy + Math.round(W * 0.033), Math.round(W * 0.035), "#FFFFFF", "800", "ZernoBodyBold", maxW);
    elements.push({ kind: "param", index: i, x: x, y: yy, key: String(p.key || ""), value: String(p.value == null ? "" : p.value) });
    if (c.measure(String(p.value == null ? "" : p.value), Math.round(W * 0.035), "800", "ZernoBodyBold") > maxW) overflow.push({ element: "param[" + i + "]", reason: "value 超宽", value: String(p.value) });
  });
}

/** 行内自动折行（返回行与字号），供各版式复用 */
function fitInline(c, t, maxW, maxLines, startPx, fam) {
  const { ctx, measure } = c;
  const words = String(t || "").split(/\s+/).filter(Boolean);
  for (let px = startPx; px >= Math.round(startPx * 0.6); px -= 1) {
    const lines = [];
    let cur = "";
    for (const w of words) {
      const cand = cur ? cur + " " + w : w;
      if (measure(cand, px, "700", fam) <= maxW) cur = cand;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    const fixed = [];
    for (const ln of lines) {
      if (measure(ln, px, "700", fam) <= maxW) { fixed.push(ln); continue; }
      let seg = "";
      for (const ch of ln) {
        if (measure(seg + ch, px, "700", fam) <= maxW) seg += ch;
        else { fixed.push(seg); seg = ch; }
      }
      if (seg) fixed.push(seg);
    }
    if (fixed.length <= maxLines) {
      return { lines: fixed, px: px, width: Math.max.apply(null, fixed.map((l) => measure(l, px, "700", fam))), overflowed: false };
    }
    if (px - 1 < Math.round(startPx * 0.6)) {
      return { lines: fixed.slice(0, maxLines), px: px, width: maxW, overflowed: true };
    }
  }
  return { lines: [], px: startPx, width: 0, overflowed: true };
}

module.exports = { nudgeBlock: nudgeBlock,  drawD2, drawD3, drawD4, drawD5, fitInline, bodyTop };
