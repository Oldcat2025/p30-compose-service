/**
 * M0-3 三产物导出：JPG（扁平）/ PSD（背景 + 产品图层 + 形状层 + 每条西里尔真文本层双写）/ SVG（矢量文字 + 位图 <image>）
 * 全部从同一 stage 模型渲染，保证三产物同图一致。
 */
const path = require("path");
const F = require(
  path.join(__dirname, "..", "03-合版引擎-spike", "lib", "fonts"),
);
const { drawShape, drawText } = require(
  path.join(__dirname, "..", "03-合版引擎-spike", "lib", "compose"),
);
const { renderScene } = require("./engine");
const agPsd = require(path.join(F.ENGINE25_MODULES, "ag-psd"));

let _psdInit = false;
function psdInit() {
  if (!_psdInit) {
    agPsd.initializeCanvas(F.createCanvas);
    _psdInit = true;
  }
}

function parseColor(color) {
  const hex = String(color || "#FFFFFF").replace("#", "");
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return { r: 255, g: 255, b: 255 };
}

const CSS_WEIGHT = {
  black: 900,
  extrabold: 800,
  bold: 700,
  semibold: 600,
  medium: 500,
  regular: 400,
};
const BASE_FAMILY = {
  display: "Montserrat",
  body: "Golos Text",
  num: "Oswald",
  hero: "Bebas Neue",
};

async function exportJpg(stage, bg) {
  const cv = F.createCanvas(stage.W, stage.H);
  renderScene(cv.getContext("2d"), stage, bg);
  return cv.toBuffer("image/jpeg", { quality: 0.92 });
}

function buildTextLayerCanvas(el) {
  const pad = Math.ceil(el.size * 0.3) + 6;
  const w = Math.ceil(el.maxWidth) + pad * 2;
  const h = Math.ceil(el.boxHeight) + pad * 2;
  const cv = F.createCanvas(w, h);
  const ctx = cv.getContext("2d");
  ctx.font = F.fontCss(el.role, el.weight, el.size);
  ctx.fillStyle = el.color;
  ctx.textAlign = el.align || "left";
  ctx.textBaseline = "alphabetic";
  for (const ln of el.lines) {
    const ix = el.align === "center" ? pad + el.maxWidth / 2 : pad;
    const iy = ln.baselineY - el.y + pad;
    ctx.fillText(ln.text, ix, iy);
  }
  return { canvas: cv, pad };
}

async function exportPsd(stage, bg) {
  psdInit();
  const children = [];
  const bgCv = F.createCanvas(stage.W, stage.H);
  const bctx = bgCv.getContext("2d");
  bctx.fillStyle = bg;
  bctx.fillRect(0, 0, stage.W, stage.H);
  for (const s of stage.behindShapes || []) drawShape(bctx, s); // 版块/卡片底色（在照片下层）
  children.push({ name: "[背景]", canvas: bgCv, left: 0, top: 0 });

  // 产品摄影层（AI 层，每层独立）
  for (let i = 0; i < stage.images.length; i++) {
    const im = stage.images[i];
    children.push({
      name: "[图] 产品摄影 " + (i + 1),
      canvas: im.cv,
      left: Math.round(im.x),
      top: Math.round(im.y),
    });
  }

  // 形状层（色块/表框/圆/对勾/分隔线，栅格）
  const shapeCv = F.createCanvas(stage.W, stage.H);
  const sctx = shapeCv.getContext("2d");
  for (const s of stage.shapes) drawShape(sctx, s);
  children.push({
    name: "[形状] 色块/表格/图标",
    canvas: shapeCv,
    left: 0,
    top: 0,
  });

  // 文字层：每条一层，canvas(所见) + text(可编辑真文本) 双写
  for (const el of stage.texts) {
    if (!el.lines || el.lines.length === 0) continue; // 空文本（如空描述）跳过文字层，避免 lines[0] 越界
    const { canvas, pad } = buildTextLayerCanvas(el);
    const fnt = F.font(el.role, el.weight);
    const psName = (fnt && fnt.ps) || "ArialMT";
    const alignMap = { left: "left", center: "center", right: "right" };
    const tx = el.align === "center" ? el.x + el.maxWidth / 2 : el.x;
    const ty = el.lines[0].baselineY;
    children.push({
      name: "[文字] " + el.id,
      left: Math.round(el.x - pad),
      top: Math.round(el.y - pad),
      canvas,
      text: {
        text: el.lines.map((l) => l.text).join("\n"),
        transform: [1, 0, 0, 1, tx, ty],
        style: {
          font: { name: psName },
          fontSize: el.size,
          fillColor: parseColor(el.color),
        },
        paragraphStyle: { justification: alignMap[el.align] || "left" },
      },
    });
  }

  return agPsd.writePsdBuffer(
    { width: stage.W, height: stage.H, children },
    { invalidateTextLayers: true },
  );
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function shapeSvg(s, idx, defs) {
  switch (s.type) {
    case "rect":
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"${s.r ? ` rx="${s.r}"` : ""} fill="${s.color}"/>`;
    case "circle":
      return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${s.color}"/>`;
    case "line":
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.color}" stroke-width="${s.lw || 2}"/>`;
    case "check": {
      const pts = [
        [s.cx - s.r * 0.42, s.cy + s.r * 0.05],
        [s.cx - s.r * 0.1, s.cy + s.r * 0.38],
        [s.cx + s.r * 0.48, s.cy - s.r * 0.32],
      ]
        .map((p) => p.map((n) => Math.round(n * 10) / 10).join(","))
        .join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.lw || 6}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    /** [机器人系列] 多边形/描边框/圆环/圆弧 —— 三产物同源 SVG 分支 */
    case "poly": {
      const pts = s.points
        .map((p) => p.map((n) => Math.round(n * 10) / 10).join(","))
        .join(" ");
      const f = s.glow ? ` filter="url(#g${idx})"` : "";
      if (s.glow)
        defs.push(
          `<filter id="g${idx}" x="-50%" y="-50%" width="200%" height="200%">` +
            `<feGaussianBlur stdDeviation="${(s.glow / 2).toFixed(1)}"/></filter>`,
        );
      return `<polygon points="${pts}" fill="${s.color}"${f}/>`;
    }
    case "rrectStroke": {
      const f = s.glow ? ` filter="url(#g${idx})"` : "";
      if (s.glow)
        defs.push(
          `<filter id="g${idx}" x="-50%" y="-50%" width="200%" height="200%">` +
            `<feGaussianBlur stdDeviation=" ${(s.glow / 2).toFixed(1)}"/></filter>`,
        );
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="none" stroke="${s.color}" stroke-width="${s.lw || 2}"${f}/>`;
    }
    case "ring":
      return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="none" stroke="${s.color}" stroke-width="${s.lw || 4}"/>`;
    case "arc": {
      const x0 = s.cx + s.r * Math.cos(s.a0);
      const y0 = s.cy + s.r * Math.sin(s.a0);
      const x1 = s.cx + s.r * Math.cos(s.a1);
      const y1 = s.cy + s.r * Math.sin(s.a1);
      const large = s.a1 - s.a0 > Math.PI ? 1 : 0;
      const r10 = (n) => Math.round(n * 10) / 10;
      return `<path d="M ${r10(x0)} ${r10(y0)} A ${s.r} ${s.r} 0 ${large} 1 ${r10(x1)} ${r10(y1)}" fill="none" stroke="${s.color}" stroke-width="${s.lw || 2}"/>`;
    }
    default:
      return "";
  }
}
function textSvg(el) {
  if (!el.lines || el.lines.length === 0) return ""; // 空文本跳过，避免 lines[0] 越界
  const family = BASE_FAMILY[el.role] || "sans-serif";
  const weight = CSS_WEIGHT[el.weight] || 400;
  const anchor =
    el.align === "center" ? "middle" : el.align === "right" ? "end" : "start";
  const x = el.lines[0].x;
  const y = el.lines[0].baselineY;
  const lineH = Math.round(el.size * (el.lineFactor || 1.18));
  const attr = `font-family="${family}, 'Golos Text', sans-serif" font-weight="${weight}" font-size="${el.size}" fill="${el.color}" text-anchor="${anchor}"`;
  const tspans = el.lines
    .map((ln, i) =>
      i === 0
        ? xmlEsc(ln.text)
        : `<tspan x="${Math.round(ln.x)}" dy="${lineH}">${xmlEsc(ln.text)}</tspan>`,
    )
    .join("");
  return `<text x="${Math.round(x)}" y="${y}" ${attr}>${tspans}</text>`;
}

async function exportSvg(stage, bg) {
  const defs = [];
  const imgSvg = [];
  for (const im of stage.images) {
    const uri = im.cv.toDataURL("image/jpeg", 0.9);
    imgSvg.push(
      `<image x="${Math.round(im.x)}" y="${Math.round(im.y)}" width="${Math.round(im.w)}" height="${Math.round(im.h)}" href="${uri}"/>`,
    );
  }
  const behindSvgAll = (stage.behindShapes || [])
    .map((s, i) => shapeSvg(s, "b" + i, defs))
    .filter(Boolean);
  const shapeSvgAll = stage.shapes
    .map((s, i) => shapeSvg(s, i, defs))
    .filter(Boolean);
  const textSvgAll = stage.texts.map(textSvg);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${stage.W}" height="${stage.H}" viewBox="0 0 ${stage.W} ${stage.H}">
<rect x="0" y="0" width="${stage.W}" height="${stage.H}" fill="${bg}"/>
${behindSvgAll.join("\n")}
${imgSvg.join("\n")}
${shapeSvgAll.join("\n")}
${textSvgAll.join("\n")}
</svg>
`;
}

module.exports = { exportJpg, exportPsd, exportSvg };
