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
  "D1-v1": function (c) { return layouts().drawD1(c); },
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
function fitText(ctx,text,maxW,maxLines,startPx,minPx,family,weight) {
  const f=layouts().fitInline({measure:(t,px)=>{ctx.font=(weight||'800')+' '+px+'px "'+family+'",sans-serif';return ctx.measureText(t).width;}},text,maxW,maxLines,startPx,family);
  return {lines:f.lines.slice(0,maxLines),fontPx:startPx,overflowed:f.overflowed};
}

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
    buf = await deps.fetchBuffer(u);
  } else throw new Error("backgroundUrl or backgroundBase64 required");

  const src = await cv.loadImage(buf);
  const W = Number((body.canvas || {}).width) || 1200;
  const H = Number((body.canvas || {}).height) || 1600;
  /* ★ 2026-10-06（审查 E1）：画布尺寸上限。原来对 body.canvas.width/height 零校验，
     `{canvas:{width:100000,height:100000}}` 会在 native 层直接 OOM 杀掉整个进程。
     上限与 image-inspection.js 的 7680 对齐。 */
  const MAX_DIM = 7680;
  if (!(W > 0) || !(H > 0) || W > MAX_DIM || H > MAX_DIM)
    throw new Error("canvas dimensions out of range: " + W + "x" + H + " (max " + MAX_DIM + ")");
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
  const barH = body.shotCode === 'D2' ? 0 : Math.round(H * .06);
  /* ★ 2026-10-09（老猫：「多次出现标签遮盖商品主要细节」）：
     主标题以前是**压在画面顶部**的（半透明黑条 + 白字）——主体一旦在画面顶部就被遮住。
     现在把标题高度先量出来，给它留一条**专属带**：画面只在标题带以下排布 → 标题永不覆盖商品。
     （只改留白与排布，不动任何文案/字号/规则。） */
  const _tf = d.title ? fitText(ctx, d.title, W - Math.round(W * 0.1), 2, Math.round(W * 0.06), Math.round(W * 0.06), "ZernoHead") : null;
  const titleBandH = _tf ? Math.round(_tf.fontPx * 1.16 * _tf.lines.length + W * 0.03 + H * 0.016) : 0;
  const innerH = Math.max(1, H - barH - titleBandH);
  const sc = Math.min(W / src.width, innerH / src.height);
  const dw = Math.round(src.width * sc), dh = Math.round(src.height * sc);
  const dx = Math.round((W - dw) / 2), dy = barH + titleBandH + Math.round((innerH - dh) / 2);

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

  // D2 has no logo. Other slots require the supplied original brand artwork.
  if (body.shotCode !== 'D2') {
    const brand=d.brand||{};
    if(!brand.logoUrl) throw Error('Original logo artwork required');
    const logoImg=await cv.loadImage(await deps.fetchBuffer(String(brand.logoUrl)));
    const logoW=Math.min(W*.135,barH*.80*(logoImg.width/logoImg.height));
    const logoH=logoW*logoImg.height/logoImg.width;
    /* ★ 2026-10-09（老猫：「图片标题和 LOGO 之间相距很近」）：LOGO 在品牌栏内**垂直居中**，
       不再贴到品牌栏下沿（原来中心固定在 4%H，底边几乎顶住标题带）。 */
    const _loY=Math.max(0,Math.round((barH-logoH)/2));
    ctx.drawImage(logoImg,(W-logoW)/2,_loY,logoW,logoH);
    elements.push({kind:'logo',x:(W-logoW)/2,y:_loY,w:logoW,h:logoH,source:'original_image'});
  }

  // ---- 3) 字号基准 ----
  const pad = Math.round(W * 0.05);
  const contentW = W - pad * 2;
  // 正文起点（画面内）
  const textTop = barH + Math.round(H * 0.026);   // ★ 2026-10-09：标题带与 LOGO/品牌栏之间留白加大（原来 0.008H，LOGO 几乎贴住标题）

  // ---- 4) 主标题（画面内顶部）----
  let cursorY = textTop;
  if (d.title) {
    const f = fitText(ctx, d.title, contentW, 2, Math.round(W * 0.06), Math.round(W * 0.06), "ZernoHead");
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
  if (d.subtitle) overflow.push({element:'subtitle',reason:'当前五图规则不使用第三层文字'});
  if (false) {
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

  if (!customLayout && ((d.bullets||[]).length || (d.params||[]).length)) overflow.push({element:'D1',reason:'D1仅允许主标题与原始LOGO'});
  // ---- 6.5) 自定义图位版式（D2–D5）----
  let detailSource=null;
  if(body.shotCode==='D5') {
    const product= d.productReferenceUrl ? await cv.loadImage(await deps.fetchBuffer(d.productReferenceUrl)) : src;
    const top=layouts().bodyTop({cursorY,dy,dh,H}),x=pad+contentW*.45+W*.025,w=W-pad-x,h=H-pad-top;
    const scale=Math.min(w/product.width,h/product.height),pw=product.width*scale,ph=product.height*scale;
    ctx.save();ctx.fillStyle='#F2F5F3';ctx.fillRect(0,top,W,H-top);
    ctx.drawImage(product,x+(w-pw)/2,top+(h-ph)/2,pw,ph);ctx.restore();
    elements.push({kind:'productReference',x:x+(w-pw)/2,y:top+(h-ph)/2,w:pw,h:ph,source:'reference_image'});
  }
  if(body.shotCode==='D2') {if(!d.detailSourceUrl)throw Error('真实细节参考图缺失');detailSource=await cv.loadImage(await deps.fetchBuffer(d.detailSourceUrl));}
  if (customLayout) {
    LAYOUT_BODY[layoutName]({ ctx: ctx, W: W, H: H, pad: pad, contentW: contentW, kitAccent: kitAccent, dy: dy, dh: dh, cursorY: cursorY, d: d, elements: elements, overflow: overflow, measure: measure, roundRect: roundRect, subject: subject, detailSource: detailSource });
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
