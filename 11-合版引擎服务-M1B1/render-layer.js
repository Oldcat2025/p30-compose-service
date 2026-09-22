/**
 * M2 渲染层 —— 生图与排版解耦（确定性文字/LOGO 叠加）
 *
 * 目标：生图模型只出「产品 + 场景」（零文字、零 LOGO），
 *      所有字符由本模块用 canvas 逐字绘制 —— 模型不负责"写什么、写哪里"。
 *
 * 端点：POST /v1/render-shot  （见 compose-service.js 路由）
 * 设计文档：01 项目设计与开发文档/项目30-M2-生图与排版解耦-技术设计-v1.0.md
 */
const fs = require("fs");
const path = require("path");

// 各图位版式（D2–D5）；D1 沿用本文件内联实现
let _layouts = null;
// 卖点文本裁剪：源卖点常是整句长句，硬 slice 会断词（出现 "мощны…" 这种残词）
// → 按词边界收尾并加省略号，保证视觉完整
function clipBullet(t, maxLen) {
  const s = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return (sp > maxLen * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-]+$/, "") + "…";
}

function layouts() {
  if (!_layouts) { try { _layouts = require(path.join(__dirname, "render-layouts.js")); } catch (e) { _layouts = require("./render-layouts"); } }
  return _layouts;
}
const LAYOUT_BODY = {
  "D2-v1": function (c) { return layouts().drawD2(c); },
  "D3-v1": function (c) { return layouts().drawD3(c); },
  "D4-v1": function (c) { return layouts().drawD4(c); },
  "D5-v1": function (c) { return layouts().drawD5(c); },
};

// ---- ZERNO LOGO 几何（与 compose-service.js 同源；闪电多边形 + ZERNO 字标）----
const ZERNO_GEOM = {
  naturalW: 160,
  naturalH: 40,
  boltW: 18,
  gap: 10,
  textH: 30,
  textDy: 3,
  pts: [
    [2, 0], [18, 0], [11, 15], [18, 15], [0, 40], [7, 20], [1, 20],
  ],
};

function fontsDirPath() {
  const cands = [
    path.join(__dirname, "..", "03-合版引擎-spike", "fonts"),
    path.join(process.cwd(), "03-合版引擎-spike", "fonts"),
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function ensureFonts(cv) {
  if (global.__m2FontReg) return;
  const fd = fontsDirPath();
  if (fd) {
    const reg = (file, family) => {
      try { cv.GlobalFonts.registerFromPath(path.join(fd, file), family); } catch (e) {}
    };
    reg("Montserrat-Black.ttf", "ZernoDisplay");
    reg("Montserrat-ExtraBold.ttf", "ZernoHead");
    reg("GolosText-Regular.ttf", "ZernoBody");
    reg("GolosText-Bold.ttf", "ZernoBodyBold");
    reg("Oswald-Regular.ttf", "ZernoCond");
  }
  global.__m2FontReg = true;
}

/** 采样矩形区域平均色 */
function avgColor(ctx, x, y, w, h, step) {
  step = step || 4;
  try {
    const px = ctx.getImageData(Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h)).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4 * step) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
    if (!n) return { r: 255, g: 255, b: 255 };
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  } catch (e) { return { r: 255, g: 255, b: 255 }; }
}

function rgb(c) { return "rgb(" + c.r + "," + c.g + "," + c.b + ")"; }
function lum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

/**
 * 文字自动换行 + 自动缩字号；返回 { lines, fontPx }
 * overflow 时返回实际用的最小字号并标记 overflowed
 */
function fitText(ctx, text, maxW, maxLines, startPx, minPx, family, weight) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  for (let px = startPx; px >= minPx; px -= 2) {
    ctx.font = (weight ? weight + " " : "") + px + "px \"" + family + "\", sans-serif";
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width <= maxW) { cur = t; }
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    // 单词太长需硬切
    // ⚠️ 硬切会从单词中间断开（实测出现 ["АККУМУЛЯТОРА","Я","ГАЗОНОКОСИЛКА"] 这种残词）。
    // 所以记录是否发生过硬切：只要还能缩字号，就宁可缩字号也不拆词（拆词只作为最后手段）。
    let hardSplit = false;
    const fixed = [];
    for (const ln of lines) {
      if (ctx.measureText(ln).width <= maxW) { fixed.push(ln); continue; }
      hardSplit = true;
      let seg = "";
      for (const ch of ln) {
        if (ctx.measureText(seg + ch).width <= maxW) seg += ch;
        else { fixed.push(seg); seg = ch; }
      }
      if (seg) fixed.push(seg);
    }
    // 未拆词且行数达标 → 采用；拆过词则继续缩字号（除非已到最小字号）
    if (fixed.length <= maxLines && !hardSplit) return { lines: fixed, fontPx: px, overflowed: false };
    if (px === minPx || px - 2 < minPx) return { lines: fixed.slice(0, maxLines), fontPx: px, overflowed: hardSplit };
  }
  return { lines: [], fontPx: minPx, overflowed: true };
}

/** 画 ZERNO LOGO（闪电 + 字标）；color 为 'auto' 时按底色亮度自适应 */
function drawZernoLogo(ctx, x, y, w, color, bgLumVal) {
  const s = w / ZERNO_GEOM.naturalW;
  let drawColor = color;
  if (!drawColor || drawColor === "auto") drawColor = (bgLumVal == null ? 0.8 : bgLumVal) > 0.62 ? "#111111" : "#FFFFFF";
  ctx.save();
  ctx.fillStyle = drawColor;
  ctx.beginPath();
  ZERNO_GEOM.pts.forEach(([px, py], i) => {
    const X = x + px * s, Y = y + py * s;
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.font = Math.round(ZERNO_GEOM.textH * s) + 'px "ZernoDisplay", sans-serif';
  ctx.textBaseline = "top";
  ctx.fillText("ZERNO", x + (ZERNO_GEOM.boltW + ZERNO_GEOM.gap) * s, y + ZERNO_GEOM.textDy * s);
  ctx.restore();
  return drawColor;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 主函数：把 data 渲染到 background 上
 * body: { shotCode, canvas:{width,height}, backgroundUrl|backgroundBase64, layout, data:{title,subtitle,params,bullets,brand}, output, taskId, returnBase64 }
 */
/* ===== P-E 主体避让（PRD v2.1 §16.7）=====
   零依赖、零调用：直接采样已绘到画布上的背景像素，按「行带边缘能量」找出画面最"忙"的区域
   —— AI 生成的场景图里，主体（产品/人物）就是高频细节最密集的地方。
   产出 bbox 交给各版式做「不遮挡」避让；不重叠时版式一律不动，保证多次渲染版式稳定。 */
function subjectFromCanvas(ctx, x0, y0, w, h, n) {
  n = n || 20;
  const bands = [];
  for (let i = 0; i < n; i++) {
    const by = y0 + Math.round((h * i) / n);
    const bh = Math.max(3, Math.round(h / n) - 2);
    let data;
    try { data = ctx.getImageData(x0, by, w, bh).data; } catch (err) { return null; }
    const stepX = Math.max(3, Math.round(w / 90));
    const stepY = Math.max(3, Math.round(bh / 8));
    let e = 0, cnt = 0;
    for (let py = 0; py + stepY < bh; py += stepY) {
      for (let px = 0; px + stepX < w; px += stepX) {
        const ia = (py * w + px) * 4;
        const ib = (py * w + px + stepX) * 4;
        const ic = ((py + stepY) * w + px) * 4;
        const ga = 0.2126 * data[ia] + 0.7152 * data[ia + 1] + 0.0722 * data[ia + 2];
        const gb = 0.2126 * data[ib] + 0.7152 * data[ib + 1] + 0.0722 * data[ib + 2];
        const gc = 0.2126 * data[ic] + 0.7152 * data[ic + 1] + 0.0722 * data[ic + 2];
        e += Math.abs(ga - gb) + Math.abs(ga - gc);
        cnt++;
      }
    }
    bands.push({ i: i, y: by, h: bh, raw: cnt ? e / cnt : 0 });
  }
  const mx = Math.max.apply(null, bands.map(function (b) { return b.raw; })) || 1;
  bands.forEach(function (b) { b.score = Math.round((b.raw / mx) * 100) / 100; });
  /* ⚠️ 35% → 50%：实测 D3 卡片压到人物帽子 —— 只取"最忙的 35% 条带"会把头顶
     （细节密度低于躯干）漏在 bbox 之外。放宽后人物整体进框。 */
  const k = Math.max(2, Math.round(n * 0.5));
  const top = bands.slice().sort(function (a, b) { return b.raw - a.raw; }).slice(0, k);
  let y1 = Infinity, y2 = -Infinity, acc = 0;
  top.forEach(function (b) { y1 = Math.min(y1, b.y); y2 = Math.max(y2, b.y + b.h); acc += b.score; });
  const quiet = bands.slice().sort(function (a, b) { return a.raw - b.raw; })[0] || {};
  return {
    method: "edge-energy", bands: bands,
    bbox: { x: x0, y: y1, w: w, h: y2 - y1, strength: Math.round((acc / k) * 100) / 100 },
    quietBandY: quiet.y == null ? null : quiet.y,
  };
}

async function renderShot(body, deps) {
  const cv = deps.requireCanvas();
  ensureFonts(cv);

  // ---- 背景图 ----
  let buf = null;
  if (body.backgroundBase64) buf = Buffer.from(String(body.backgroundBase64).replace(/^data:[^,]+,/, ""), "base64");
  else if (body.backgroundUrl) {
    const u = String(body.backgroundUrl);
    buf = /^https?:/i.test(u) ? await deps.fetchBuffer(u) : fs.readFileSync(u);
  } else throw new Error("backgroundUrl or backgroundBase64 required");

  const src = await cv.loadImage(buf);
  const W = Number((body.canvas || {}).width) || 1200;
  const H = Number((body.canvas || {}).height) || 1600;
  const canvas = cv.createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const d = body.data || {};
  const _bk = d.brand || {};
  const accent = String(_bk.accent || _bk.primary || "").trim();
  const kitAccent = /^#[0-9A-Fa-f]{3,8}$/.test(accent) ? accent : null;
  const layoutName = String(body.layout || "D1-v1");
  const customLayout = !!LAYOUT_BODY[layoutName];
  const elements = [];
  const overflow = [];
  // ⚠️ 测量必须显式指定字号/字重：ctx.save()/restore() 之后 ctx.font 会回退，
  // 在 restore 之后直接用 ctx.measureText 会拿错字号 → 误报「文字溢出」。实测踩过。
  const measure = (t, px, weight, fam) => {
    ctx.save();
    ctx.font = (weight || "") + " " + px + 'px "' + (fam || "ZernoBodyBold") + '", sans-serif';
    const w = ctx.measureText(String(t == null ? "" : t)).width;
    ctx.restore();
    return w;
  };

  // ---- 1) 品牌栏（letterbox：新增条带，画面等比缩小下移 → 永不遮挡内容）----
  const barH = Math.round(H * (Number(body.barHeightPct) || 6) / 100);
  const innerH = H - barH;
  const sc = Math.min(W / src.width, innerH / src.height);
  const dw = Math.round(src.width * sc), dh = Math.round(src.height * sc);
  const dx = Math.round((W - dw) / 2), dy = barH + Math.round((innerH - dh) / 2);

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, dx, dy, dw, dh);

  // ★ P-E：主体检测（在已绘制好的背景上做，零额外调用）
  const subject = subjectFromCanvas(ctx, dx, dy, dw, dh, 20);
  if (subject && subject.bbox) {
    elements.push({ kind: "subjectBbox", x: subject.bbox.x, y: subject.bbox.y, w: subject.bbox.w, h: subject.bbox.h,
                    strength: subject.bbox.strength, method: subject.method });
  }

  // 品牌栏渐变（采样画面顶部 5 段）
  const SEG = 5, stops = [];
  for (let i = 0; i < SEG; i++) {
    const x0 = dx + Math.floor((dw * i) / SEG);
    const w0 = Math.floor(dw / SEG);
    stops.push(rgb(avgColor(ctx, x0, dy, w0, Math.max(2, Math.round(dh * 0.05)), 6)));
  }
  const g = ctx.createLinearGradient(0, 0, W, barH);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, barH);
  elements.push({ kind: "brandBar", x: 0, y: 0, w: W, h: barH, color: stops.join(" → ") });

  // ---- 2) LOGO（栏内居中）----
  const brand = d.brand || {};
  const logoW = W * (Number(brand.logoWidthPct) || 13.5) / 100;
  const lx = Math.round((W - logoW) / 2);
  const barBg = avgColor(ctx, 0, 0, W, barH, 8);
  let lh = logoW * (ZERNO_GEOM.naturalH / ZERNO_GEOM.naturalW);
  let ly = Math.round((barH - lh) / 2);
  let logoSource = "vector";
  let logoColor = null;
  let logoErr = null;
  const logoUrl = brand.logoUrl ? String(brand.logoUrl) : "";
  if (logoUrl) {
    try {
      const lbuf = /^https?:/i.test(logoUrl) ? await deps.fetchBuffer(logoUrl) : fs.readFileSync(logoUrl);
      const logoImg = await cv.loadImage(lbuf);
      lh = Math.round(logoW * (logoImg.height / logoImg.width));
      ly = Math.round((barH - lh) / 2);
      ctx.drawImage(logoImg, lx, ly, Math.round(logoW), lh);
      logoSource = "image";
      logoColor = "image";
    } catch (e) {
      logoErr = String((e && e.message) || e).slice(0, 140);
    }
  }
  if (logoSource !== "image") {
    lh = logoW * (ZERNO_GEOM.naturalH / ZERNO_GEOM.naturalW);
    ly = Math.round((barH - lh) / 2);
    logoColor = drawZernoLogo(ctx, lx, ly, logoW, brand.color || "auto", lum(barBg));
  }
  elements.push({ kind: "logo", x: lx, y: ly, w: Math.round(logoW), h: Math.round(lh),
                  color: logoColor, source: logoSource, logoUrl: logoUrl, logoError: logoErr });

  // ---- 3) 字号基准 ----
  const pad = Math.round(W * 0.05);
  const contentW = W - pad * 2;
  // 正文起点（画面内）
  const textTop = dy + Math.round(dh * 0.03);

  // ---- 4) 主标题（画面内顶部）----
  let cursorY = textTop;
  if (d.title) {
    const f = fitText(ctx, d.title, contentW, 3, Math.round(W * 0.085), Math.round(W * 0.042), "ZernoHead");
    const lh2 = Math.round(f.fontPx * 1.16);
    const boxH = lh2 * f.lines.length + Math.round(W * 0.03);
    // 半透明衬底提升可读性
    ctx.save();
    // ★ 2026-09-18 二次修：衬底从 0.28 提到 0.46 —— 标题条颜色是「采样画面顶部渐变」的，
    // 雪地/天空这种浅背景采出来是浅蓝灰，白字叠上去对比不足（实测 D1/D3/D5 标题发灰看不清）。
    ctx.fillStyle = "rgba(0,0,0,0.46)";
    roundRect(ctx, pad - Math.round(W * 0.02), cursorY - Math.round(W * 0.012), contentW + Math.round(W * 0.04), boxH, Math.round(W * 0.012));
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.font = "800 " + f.fontPx + 'px "ZernoHead", sans-serif';
    ctx.textBaseline = "top";
    ctx.fillStyle = "#FFFFFF";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = Math.round(W * 0.006);
    f.lines.forEach((ln, i) => {
      ctx.fillText(ln, pad, cursorY + i * lh2);
    });
    ctx.restore();
    elements.push({ kind: "title", x: pad, y: cursorY, w: Math.round(Math.max(...f.lines.map(l => measure(l, f.fontPx, "800", "ZernoHead")))), h: lh2 * f.lines.length, fontPx: f.fontPx, lines: f.lines });
    if (f.overflowed) overflow.push({ element: "title", reason: "超出 " + f.lines.length + " 行/最小字号" });
    cursorY += boxH + Math.round(H * 0.02);
  }

  // 副标题（最多 2 行；不足则自动缩字号，2 行仍放不下才报 overflow）
  // 修：原先 maxLines=1 且只画 lines[0]，长副标题会被右边缘硬截断（实测丢半句）
  if (d.subtitle) {
    const f = fitText(ctx, d.subtitle, contentW, 2, Math.round(W * 0.045), Math.round(W * 0.026), "ZernoBodyBold");
    const slh = Math.round(f.fontPx * 1.28);
    ctx.save();
    ctx.font = "700 " + f.fontPx + 'px "ZernoBodyBold", sans-serif';
    ctx.textBaseline = "top";
    ctx.fillStyle = "#FFFFFF";
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = Math.round(W * 0.008);
    f.lines.forEach((ln, i) => { ctx.fillText(ln, pad, cursorY + i * slh); });
    ctx.restore();
    elements.push({ kind: "subtitle", x: pad, y: cursorY, w: Math.round(Math.max(...f.lines.map(l => measure(l, f.fontPx, "700", "ZernoBodyBold")))), h: slh * f.lines.length, fontPx: f.fontPx, lines: f.lines });
    if (f.overflowed) overflow.push({ element: "subtitle", reason: "超出 2 行/最小字号" });
    cursorY += slh * f.lines.length + Math.round(H * 0.01);
  }

  // ---- 5) 卖点列表（左下，白色半透明卡片）----
  const bullets = Array.isArray(d.bullets) ? d.bullets : [];
  if (bullets.length && !customLayout) {
    const bp = Math.round(W * 0.05);
    let by = H - pad - bullets.length * Math.round(H * 0.045);
    const cardTop = by - Math.round(H * 0.012);
    const cardH = bullets.length * Math.round(H * 0.045) + Math.round(H * 0.024);
    const bw = Math.round(contentW * 0.56);
    ctx.save();
    // ★ 2026-09-18（老猫指出）：原白底 rgba(255,255,255,0.90) 配冰面/雪白背景**完全不突出**。
    // 2026-09-18 二次调整：深绿黑改「深色高级灰 rgba(92,97,104,0.80)」+ 略降不透明度 ——
    // 原方案太深、把背景完全压住了（老猫反馈）。灰调更克制，82% 让背景透出一点，白字对比仍 ~10:1。
    ctx.fillStyle = "rgba(92,97,104,0.80)";
    roundRect(ctx, bp, cardTop, bw, cardH, Math.round(W * 0.012));
    ctx.fill();
    ctx.restore();
    // 自适应字号：逐级缩小直到最长卖点能放进卡片（避免"文字溢出卡片"）
    const innerW = bw - Math.round(W * 0.075);
    let fpx = Math.round(W * 0.032);
    const _measure = (t, px) => { ctx.save(); ctx.font = "700 " + px + 'px "ZernoBodyBold", sans-serif'; const w = ctx.measureText(t).width; ctx.restore(); return w; };
    while (fpx > Math.round(W * 0.020) && bullets.some((b) => _measure(clipBullet(b.text || b, 52), fpx) > innerW)) fpx -= 1;
    // 再按「实际像素宽度」裁剪：固定字符数在等宽差异大的语言（西里尔/中文）下仍会溢出卡片。
    // 二分找能连同省略号一起放下的最长前缀，按词边界收尾 → 保证永不溢出卡片。
    const clipTo = (t) => {
      const s = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
      if (!s) return "";
      if (_measure(s, fpx) <= innerW) return s;
      let lo = 1, hi = s.length, best = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (_measure(s.slice(0, mid) + "…", fpx) <= innerW) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      const cut = s.slice(0, best);
      const sp = cut.lastIndexOf(" ");
      return (sp > best * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-]+$/, "") + "…";
    };
    ctx.save();
    ctx.font = "700 " + fpx + 'px "ZernoBodyBold", sans-serif';
    ctx.textBaseline = "top";
    ctx.fillStyle = "#111111";
    bullets.forEach((b, i) => {
      const t = clipTo(b.text || b);
      const yy = by + i * Math.round(H * 0.045);
      ctx.fillStyle = "#6EE7A0";   // 深底上必须用亮色圆点（原 #0F7B2F 深绿在深底上几乎看不见）
      ctx.beginPath();
      ctx.arc(bp + Math.round(W * 0.028), yy + fpx / 2, Math.round(W * 0.010), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(t, bp + Math.round(W * 0.05), yy);
      elements.push({ kind: "bullet", index: i, x: bp + Math.round(W * 0.05), y: yy, text: t });
    });
    ctx.restore();
    // 越界检查
    const over = bullets.filter((b) => measure(clipTo(b.text || b), fpx, "700", "ZernoBodyBold") > innerW);
    if (over.length) overflow.push({ element: "bullets", reason: over.length + " 条缩到 " + fpx + "px 仍超出卡片宽度" });
  }

  // ---- 6) 参数条（右下，深色卡片 + key/value 成对渲染，杜绝 key/value 错配）----
  const params = Array.isArray(d.params) ? d.params : [];
  if (params.length && !customLayout) {
    const cols = Math.min(2, params.length);
    const rows = Math.ceil(params.length / cols);
    const cw = Math.round(contentW * 0.42);
    const ch = rows * Math.round(H * 0.052) + Math.round(H * 0.02);
    const cx = W - pad - cw;
    const _bRows = bullets.length;
    const cy = bullets.length ? (H - pad - Math.max(ch, _bRows * Math.round(H * 0.045) + Math.round(H * 0.024))) : (H - pad - ch);
    ctx.save();
    ctx.fillStyle = "rgba(92,97,104,0.80)";
    roundRect(ctx, cx, cy, cw, ch, Math.round(W * 0.012));
    ctx.fill();
    ctx.restore();
    const kpx = Math.round(W * 0.0245), vpx = Math.round(W * 0.035);
    params.forEach((p, i) => {
      const r = Math.floor(i / cols), c2 = i % cols;
      const cellW = Math.floor(cw / cols);
      const x = cx + c2 * cellW + Math.round(W * 0.025);
      const y = cy + Math.round(H * 0.012) + r * Math.round(H * 0.052);
      ctx.save();
      ctx.textBaseline = "top";
      ctx.font = "600 " + kpx + 'px "ZernoBody", sans-serif';
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      const kt = String(p.key || "").slice(0, 22);
      ctx.fillText(kt, x, y, Math.round(cellW - W * 0.03));
      ctx.font = "800 " + vpx + 'px "ZernoBodyBold", sans-serif';
      ctx.fillStyle = "#FFFFFF";
      const vt = String(p.value == null ? "" : p.value).slice(0, 24);
      ctx.fillText(vt, x, y + Math.round(kpx * 1.35), Math.round(cellW - W * 0.03));
      ctx.restore();
      elements.push({ kind: "param", index: i, x: x, y: y, key: kt, value: vt });
      if (measure(vt, vpx, "800", "ZernoBodyBold") > cellW - W * 0.03) overflow.push({ element: "param[" + i + "]", reason: "value 超宽", value: vt });
    });
  }

  // ---- 6.5) 自定义图位版式（D2–D5）----
  if (customLayout) {
    LAYOUT_BODY[layoutName]({ ctx: ctx, W: W, H: H, pad: pad, contentW: contentW, kitAccent: kitAccent, dy: dy, dh: dh, cursorY: cursorY, d: d, elements: elements, overflow: overflow, measure: measure, roundRect: roundRect, subject: subject });
  }

  // ---- 7) 输出 ----
  const jpg = await canvas.encode("jpeg", Number((body.output || {}).quality) || 92);
  const outRoot = deps.outputRoot();
  const outDir = path.join(outRoot, deps.safeName(String(body.taskId || ("render_" + Date.now()))));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, deps.safeName(String(body.shotCode || "shot")) + "-render.jpg");
  fs.writeFileSync(outPath, jpg);

  const resp = {
    ok: true, status: "done", layout: body.layout || "D1-v1",
    width: W, height: H,
    bg: { srcW: src.width, srcH: src.height, x: dx, y: dy, w: dw, h: dh },
    barHeightPx: barH,
    productBbox: subject && subject.bbox ? subject.bbox : null,
    subjectBands: subject ? subject.bands.map(function (b) { return b.score; }) : null,
    elements: elements,
    overflow: overflow,
    path: outPath, bytes: jpg.length,
  };
  if (body.returnBase64 === true) resp.imageBase64 = "data:image/jpeg;base64," + jpg.toString("base64");
  return resp;
}

module.exports = { renderShot, ZERNO_GEOM, fitText, drawZernoLogo };
