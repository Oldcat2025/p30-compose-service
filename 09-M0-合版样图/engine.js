/**
 * M0-3 合版场景引擎：900px 宽长图，累积 texts/shapes/images，三产物同源渲染。
 * 字体注册与西里尔排版复用 03-spike（fonts.js / textbox.js）。
 */
const path = require("path");
const F = require(
  path.join(__dirname, "..", "03-合版引擎-spike", "lib", "fonts"),
);
const TB = require(
  path.join(__dirname, "..", "03-合版引擎-spike", "lib", "textbox"),
);
const { drawShape, drawText } = require(
  path.join(__dirname, "..", "03-合版引擎-spike", "lib", "compose"),
);

const W = 900;
const M = 48; // 左右页边距（M0-0 实测）
const CW = W - M * 2; // 内容宽 804

function createStage() {
  F.registerAll();
  const texts = [];
  const shapes = [];
  const behindShapes = []; // 背景色块（版块底/卡片底），画在照片下层
  const images = [];

  const stage = {
    W,
    M,
    CW,
    texts,
    shapes,
    behindShapes,
    images,

    bgRect(x, y, w, h, color) {
      behindShapes.push({ type: "rect", x, y, w, h, color });
    },
    bgRrect(x, y, w, h, r, color) {
      behindShapes.push({ type: "rect", x, y, w, h, r, color });
    },

    text(role, weight, str, x, y, maxW, maxH, color, align, cap) {
      const el = TB.layoutText({
        id: "t" + texts.length,
        role,
        weight,
        text: str,
        x,
        y,
        maxWidth: maxW,
        maxHeight: maxH || 9999,
        color,
        align: align || "left",
        maxSize: cap && cap.max,
        minSize: cap && cap.min,
        lineFactor: (cap && cap.factor) || 1.18,
      });
      texts.push(el);
      return el;
    },
    rect(x, y, w, h, color) {
      shapes.push({ type: "rect", x, y, w, h, color });
    },
    rrect(x, y, w, h, r, color) {
      shapes.push({ type: "rect", x, y, w, h, r, color });
    },
    circle(cx, cy, r, color) {
      shapes.push({ type: "circle", cx, cy, r, color });
    },
    line(x1, y1, x2, y2, color, lw) {
      shapes.push({ type: "line", x1, y1, x2, y2, color, lw });
    },
    check(cx, cy, r, color, lw) {
      shapes.push({ type: "check", cx, cy, r, color, lw });
    },
    /** [机器人系列新增] 描边圆（流程环/图标圈） */
    ring(cx, cy, r, color, lw) {
      shapes.push({ type: "ring", cx, cy, r, color, lw });
    },
    /** [机器人系列新增] 实心多边形（星/箭头/播放键/心形组合件），points=[[x,y]...] */
    poly(points, color) {
      shapes.push({ type: "poly", points, color });
    },
    /** [机器人系列新增] 描边圆角框（S7 霓虹横幅/S5 标签框）；glow=辉光半径 */
    rrectStroke(x, y, w, h, r, color, lw, glow, glowColor) {
      shapes.push({
        type: "rrectStroke",
        x,
        y,
        w,
        h,
        r,
        color,
        lw,
        glow: glow || 0,
        glowColor: glowColor || color,
      });
    },
    /** [机器人系列新增] 描边圆弧（弧度制 a0→a1，S3 连接线/S5 环形流程） */
    arc(cx, cy, r, a0, a1, color, lw) {
      shapes.push({ type: "arc", cx, cy, r, a0, a1, color, lw });
    },
    image(cv, x, y, w, h, radius) {
      images.push({ cv, x, y, w, h, radius: radius || 0 });
    },
  };
  return stage;
}

/** 圆角矩形路径 */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 把源图画到目标 canvas，cover 居中裁切 + 可选圆角 */
function drawCover(ctx, cv, x, y, w, h, radius) {
  const sw = cv.width,
    sh = cv.height;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale,
    dh = sh * scale;
  const dx = x + (w - dw) / 2,
    dy = y + (h - dh) / 2;
  ctx.save();
  if (radius) {
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.clip();
  }
  ctx.drawImage(cv, dx, dy, dw, dh);
  ctx.restore();
}

/** 加载产品图 → 已 cover/圆角绘制好的 w×h canvas（摄影层） */
async function makePhoto(stage, srcPath, x, y, w, h, radius) {
  const { loadImage } = require(
    path.join(F.ENGINE25_MODULES, "@napi-rs/canvas"),
  );
  const loaded = await loadImage(srcPath);
  const cv = F.createCanvas(Math.round(w), Math.round(h));
  const ctx = cv.getContext("2d");
  drawCover(ctx, loaded, 0, 0, w, h, radius);
  stage.image(cv, x, y, w, h, 0);
  return cv;
}

/** 整图渲染（JPG 用）：bg → 背景色块(版块/卡片底) → 摄影层 → 前景形状层 → 文字层 */
function renderScene(ctx, stage, bg) {
  ctx.fillStyle = bg || "#FFFFFF";
  ctx.fillRect(0, 0, stage.W, stage.H);
  for (const s of stage.behindShapes || []) drawShape(ctx, s);
  for (const im of stage.images) ctx.drawImage(im.cv, im.x, im.y, im.w, im.h);
  for (const s of stage.shapes) drawShape(ctx, s);
  for (const t of stage.texts) drawText(ctx, t);
}

module.exports = {
  createStage,
  roundRectPath,
  drawCover,
  makePhoto,
  renderScene,
  W,
  M,
  CW,
};
