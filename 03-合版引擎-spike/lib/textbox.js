/**
 * 西里尔文字排版原型（M0-1 / M1-B3）
 *
 * 能力：
 *   - wrap() 按宽度自动换行（按词折行；超长单词按字符硬切，俄语长复合词兜底）
 *   - fit()  字号自适应：从 maxSize 递减，直到文字块在给定宽高内放下；
 *            即便缩到 minSize 仍放不下，返回 overflow=true 告警标志
 *   - layout() 产出带逐行基线坐标的渲染模型，供 canvas / PSD / SVG 三端同源使用
 *
 * 设计原则：文字元素只算一次几何，JPG/PSD/SVG 都从同一模型渲染，保证三产物一致。
 */
const F = require("./fonts");

let _measureCtx = null;
function measureCtx() {
  if (!_measureCtx) {
    F.registerAll();
    _measureCtx = F.createCanvas(8, 8).getContext("2d");
  }
  return _measureCtx;
}

function setFont(ctx, role, weight, sizePx) {
  ctx.font = F.fontCss(role, weight, sizePx);
}

/** 词宽（px） */
function wordWidth(role, weight, sizePx, word) {
  const ctx = measureCtx();
  setFont(ctx, role, weight, sizePx);
  return ctx.measureText(word).width;
}

/**
 * 按宽度折行。
 * @returns { lines: string[], width:number }  width=最长行宽
 */
function wrap(role, weight, sizePx, text, maxWidth) {
  const ctx = measureCtx();
  setFont(ctx, role, weight, sizePx);
  const paragraphs = String(text).split("\n");
  const lines = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let cur = "";
    for (const w of words) {
      // 单个词超宽 → 硬切（俄语长复合词 / 长 URL 兜底）
      let word = w;
      while (ctx.measureText(word).width > maxWidth && word.length > 1) {
        // 找能放下的最长前缀
        let cut = word.length - 1;
        while (cut > 1 && ctx.measureText(word.slice(0, cut)).width > maxWidth)
          cut--;
        const head = word.slice(0, cut);
        if (cur) {
          lines.push(cur);
          cur = "";
        }
        lines.push(head);
        word = word.slice(cut);
      }
      const trial = cur ? cur + " " + word : word;
      if (ctx.measureText(trial).width <= maxWidth) {
        cur = trial;
      } else {
        if (cur) lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
  }

  let width = 0;
  for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
  return { lines, width };
}

/**
 * 字号自适应。
 * @returns {ok, role, weight, size, lines, width, height, overflow, tried}
 */
function fit(role, weight, text, maxWidth, maxHeight, opts = {}) {
  const maxSize = opts.maxSize || 72;
  const minSize = opts.minSize || 16;
  const lineFactor = opts.lineFactor || 1.18;
  const step = opts.step || 2;

  let best = null;
  let tried = [];
  for (let size = maxSize; size >= minSize; size -= step) {
    const { lines, width } = wrap(role, weight, size, text, maxWidth);
    const height = lines.length * size * lineFactor;
    tried.push({
      size,
      lines: lines.length,
      width: Math.round(width),
      height: Math.round(height),
    });
    if (width <= maxWidth && height <= maxHeight) {
      best = { size, lines, width, height };
      break;
    }
    best = { size, lines, width, height }; // 记录最小字号结果（可能仍溢出）
  }
  const overflow = best.width > maxWidth + 0.5 || best.height > maxHeight + 0.5;
  return {
    ok: true,
    role,
    weight,
    size: best.size,
    lines: best.lines,
    width: Math.round(best.width * 10) / 10,
    height: Math.round(best.height * 10) / 10,
    overflow,
    lineFactor,
    tried,
  };
}

/**
 * 生成一个文字元素的完整布局模型（含逐行基线坐标）。
 * 坐标约定：x,y = 文本框左上角；align=left|center|right。
 * 返回的 lines 带 {text, x, baselineY}（x 为该行绘制起点/锚点）。
 */
function layoutText(el) {
  const { role, weight, text, x, y, maxWidth, maxHeight, align = "left" } = el;
  const r = fit(role, weight, text, maxWidth, maxHeight || 9999, {
    maxSize: el.maxSize,
    minSize: el.minSize,
    lineFactor: el.lineFactor,
  });
  const bl = r.size * 0.85; // 首行基线（近似 ascent）
  const lineH = r.size * r.lineFactor;
  const lines = r.lines.map((t, i) => {
    let lx;
    if (align === "center") lx = x + maxWidth / 2;
    else if (align === "right") lx = x + maxWidth;
    else lx = x;
    return { text: t, x: lx, baselineY: Math.round(y + bl + i * lineH) };
  });
  return {
    ...el,
    role: r.role,
    weight: r.weight,
    size: r.size,
    fitWidth: r.width,
    boxHeight: r.height,
    overflow: r.overflow,
    overflowWarning: r.overflow
      ? `text overflow: "${String(text).slice(0, 24)}…" box ${maxWidth}x${maxHeight}`
      : null,
    lines,
  };
}

module.exports = { wrap, fit, layoutText, wordWidth, setFont, measureCtx };
