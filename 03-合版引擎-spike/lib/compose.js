/**
 * 合版引擎最小链路（M0-1）：竖版 3:4（1200×1600）高密度俄语信息图
 *
 * 场景模型单一来源：shapes[]（色块/表框/圆形/对勾）+ texts[]（西里尔文字层），
 * JPG(canvas)/PSD(ag-psd)/SVG 全部从同一模型渲染，保证三产物同图一致。
 *
 * 底图为占位（纯色块/渐变，不调外部生图）。园艺工具主题俄语文案（占位）。
 */
const F = require("./fonts");
const TB = require("./textbox");

const W = 1200;
const H = 1600;

// 橙绿品牌配色
const C = {
  orange: "#F07A1A",
  orangeDeep: "#D95F0E",
  green: "#4C8C2B",
  greenDeep: "#38691F",
  ink: "#22281D",
  paper: "#FFFFFF",
  cream: "#FBF6EC",
  soft: "#F3EEDF",
  line: "#E2DAC9",
  muted: "#6A6B5E",
  white: "#FFFFFF",
};

function rrectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawShape(ctx, s) {
  switch (s.type) {
    case "rect":
      ctx.fillStyle = s.color;
      if (s.r) {
        rrectPath(ctx, s.x, s.y, s.w, s.h, s.r);
        ctx.fill();
      } else ctx.fillRect(s.x, s.y, s.w, s.h);
      break;
    case "gradRect": {
      const g = ctx.createLinearGradient(s.x, s.y, s.x, s.y + s.h);
      g.addColorStop(0, s.c0);
      g.addColorStop(1, s.c1);
      ctx.fillStyle = g;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      break;
    }
    case "circle":
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "ring":
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lw || 4;
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "line":
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lw || 2;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      break;
    case "check": {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lw || 6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s.cx - s.r * 0.42, s.cy + s.r * 0.05);
      ctx.lineTo(s.cx - s.r * 0.1, s.cy + s.r * 0.38);
      ctx.lineTo(s.cx + s.r * 0.48, s.cy - s.r * 0.32);
      ctx.stroke();
      break;
    }
    /** [机器人系列] 实心多边形（星/箭头/播放键），可选 glow，save/restore 防泄漏 */
    case "poly": {
      ctx.save();
      if (s.glow) {
        ctx.shadowColor = s.glowColor || s.color;
        ctx.shadowBlur = s.glow;
      }
      ctx.fillStyle = s.color;
      ctx.beginPath();
      s.points.forEach(([px, py], i) =>
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py),
      );
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    /** 描边圆角框（S7 霓虹横幅）：先辉光底描一遍，再正常描一遍 */
    case "rrectStroke": {
      ctx.save();
      if (s.glow) {
        rrectPath(ctx, s.x, s.y, s.w, s.h, s.r);
        ctx.shadowColor = s.glowColor || s.color;
        ctx.shadowBlur = s.glow;
        ctx.lineWidth = (s.lw || 2) * 3;
        ctx.strokeStyle = s.glowColor;
        ctx.stroke();
      }
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      rrectPath(ctx, s.x, s.y, s.w, s.h, s.r);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lw || 2;
      ctx.stroke();
      ctx.restore();
      break;
    }
    /** 描边圆弧（弧度制） */
    case "arc": {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lw || 2;
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.r, s.a0, s.a1);
      ctx.stroke();
      break;
    }
    default:
      break;
  }
}
function drawText(ctx, el) {
  ctx.font = F.fontCss(el.role, el.weight, el.size);
  ctx.fillStyle = el.color;
  ctx.textAlign = el.align || "left";
  ctx.textBaseline = "alphabetic";
  for (const ln of el.lines) {
    ctx.fillText(ln.text, ln.x, ln.baselineY);
  }
}

function buildScene() {
  F.registerAll();
  const shapes = [];
  const texts = [];

  const rect = (x, y, w, h, color) =>
    shapes.push({ type: "rect", x, y, w, h, color });
  const rrectP = (x, y, w, h, r, color) =>
    shapes.push({ type: "rect", x, y, w, h, r, color });
  const gradRect = (x, y, w, h, c0, c1) =>
    shapes.push({ type: "gradRect", x, y, w, h, c0, c1 });
  const circle = (cx, cy, r, color) =>
    shapes.push({ type: "circle", cx, cy, r, color });
  const ring = (cx, cy, r, color, lw) =>
    shapes.push({ type: "ring", cx, cy, r, color, lw });
  const line = (x1, y1, x2, y2, color, lw) =>
    shapes.push({ type: "line", x1, y1, x2, y2, color, lw });
  const check = (cx, cy, r, color, lw) =>
    shapes.push({ type: "check", cx, cy, r, color, lw });

  const text = (
    id,
    role,
    weight,
    str,
    x,
    y,
    maxWidth,
    maxHeight,
    color,
    align,
    sizeCap,
  ) => {
    const el = TB.layoutText({
      id,
      role,
      weight,
      text: str,
      x,
      y,
      maxWidth,
      maxHeight,
      color,
      align: align || "left",
      maxSize: sizeCap && sizeCap.max,
      minSize: sizeCap && sizeCap.min,
    });
    texts.push(el);
    return el;
  };

  // ---------- ① 顶部英雄色带（橙→深橙渐变，AI 摄影层占位） ----------
  gradRect(0, 0, W, 500, C.orange, C.orangeDeep);
  circle(1085, 110, 150, C.green);
  ring(1085, 110, 150, C.white, 6);
  rrectP(70, 56, 390, 52, 26, C.green);
  text(
    "kicker",
    "body",
    "bold",
    "GARDEN PRO · САДОВАЯ ТЕХНИКА",
    96,
    68,
    350,
    38,
    C.white,
    "left",
    { max: 25, min: 16 },
  );
  text(
    "title1",
    "display",
    "black",
    "ИЗНОСОСТОЙКИЙ",
    70,
    138,
    740,
    100,
    C.white,
    "left",
    { max: 78, min: 44 },
  );
  text(
    "title2",
    "display",
    "black",
    "РАВНОМЕРНЫЙ ПОЛИВ",
    70,
    244,
    820,
    100,
    C.white,
    "left",
    { max: 78, min: 44 },
  );
  rrectP(70, 386, 560, 74, 18, C.cream);
  text(
    "subtitle",
    "display",
    "extrabold",
    "Радиус полива до 8 м",
    98,
    402,
    508,
    56,
    C.orangeDeep,
    "left",
    { max: 44, min: 26 },
  );

  // 英雄大数字卡片（Bebas 纯数字 8 + Oswald 西里尔 метров）
  rrectP(770, 296, 360, 196, 24, C.white);
  text(
    "heronum",
    "hero",
    "regular",
    "8",
    786,
    308,
    150,
    150,
    C.green,
    "center",
    { max: 140, min: 80 },
  );
  text(
    "herounit",
    "num",
    "bold",
    "метров",
    956,
    372,
    150,
    60,
    C.ink,
    "center",
    { max: 52, min: 28 },
  );
  text(
    "herolabel",
    "body",
    "bold",
    "радиус действия",
    786,
    446,
    330,
    36,
    C.muted,
    "center",
    { max: 25, min: 16 },
  );

  // ---------- ② 优势区（对勾清单） ----------
  rrectP(70, 540, 330, 54, 16, C.green);
  text(
    "sec1",
    "display",
    "extrabold",
    "ПРЕИМУЩЕСТВА",
    92,
    552,
    300,
    40,
    C.white,
    "left",
    { max: 33, min: 20 },
  );

  const bullets = [
    "Мощный двигатель 2200 Вт для густой травы",
    "Равномерный полив без пропусков сектора",
    "Регулировка высоты скашивания 20–70 мм",
    "Износостойкий металлический корпус",
    "Тихий ход и малый вес — всего 12 кг",
  ];
  let by = 624;
  bullets.forEach((b, i) => {
    circle(102, by + 28, 28, C.green);
    check(102, by + 28, 28, C.white, 7);
    text("bullet" + i, "body", "semibold", b, 156, by, 780, 64, C.ink, "left", {
      max: 32,
      min: 18,
    });
    by += 72;
  });

  // ---------- ③ 参数对比表（3 列，西里尔） ----------
  rrectP(70, 998, 410, 54, 16, C.orange);
  text(
    "sec2",
    "display",
    "extrabold",
    "СРАВНЕНИЕ ХАРАКТЕРИСТИК",
    92,
    1010,
    380,
    40,
    C.white,
    "left",
    { max: 32, min: 18 },
  );

  const tx = 70,
    ty = 1080;
  const c1 = 340,
    c2 = 400,
    c3 = 320;
  const rowH = 44;
  const cols = [tx, tx + c1, tx + c1 + c2];
  const tableW = c1 + c2 + c3;
  const rows = [
    ["Параметр", "Наша модель", "Обычная косилка"],
    ["Мощность", "2200 Вт", "1200 Вт"],
    ["Радиус полива", "до 8 м", "до 3 м"],
    ["Ширина захвата", "40 см", "32 см"],
    ["Травосборник", "50 л", "30 л"],
    ["Вес", "12 кг", "18 кг"],
    ["Гарантия", "24 мес", "12 мес"],
  ];
  rows.forEach((r, i) => {
    const ry = ty + i * rowH;
    rect(
      tx,
      ry,
      tableW,
      rowH,
      i === 0 ? C.greenDeep : i % 2 === 1 ? C.cream : C.soft,
    );
    line(tx, ry, tx + tableW, ry, C.line, 2);
    text(
      "tp" + i,
      "body",
      "semibold",
      r[0],
      cols[0] + 16,
      ry + 10,
      c1 - 28,
      rowH - 12,
      i === 0 ? C.white : C.ink,
      "left",
      { max: 24, min: 14 },
    );
    text(
      "ta" + i,
      "body",
      "bold",
      r[1],
      cols[1] + 12,
      ry + 10,
      c2 - 24,
      rowH - 12,
      i === 0 ? C.white : C.greenDeep,
      "center",
      { max: 24, min: 14 },
    );
    text(
      "tb" + i,
      "body",
      "bold",
      r[2],
      cols[2] + 12,
      ry + 10,
      c3 - 24,
      rowH - 12,
      i === 0 ? C.white : C.muted,
      "center",
      { max: 24, min: 14 },
    );
  });
  line(tx, ty, tx, ty + rows.length * rowH, C.greenDeep, 3);
  line(tx + tableW, ty, tx + tableW, ty + rows.length * rowH, C.greenDeep, 3);
  for (let k = 1; k < 3; k++)
    line(cols[k], ty, cols[k], ty + rows.length * rowH, C.line, 2);
  line(
    tx,
    ty + rows.length * rowH,
    tx + tableW,
    ty + rows.length * rowH,
    C.greenDeep,
    3,
  );

  // ---------- ④ 圆形数字标号（3 步） ----------
  const steps = [
    "Заливка и подготовка",
    "Запуск и равномерный полив",
    "Уборка и хранение",
  ];
  const stepY = 1456;
  const stepXs = [250, 600, 950];
  steps.forEach((s, i) => {
    circle(stepXs[i], stepY, 40, C.orange);
    ring(stepXs[i], stepY, 40, C.white, 4);
    text(
      "stepnum" + i,
      "num",
      "bold",
      String(i + 1),
      stepXs[i] - 38,
      stepY - 38,
      76,
      76,
      C.white,
      "center",
      { max: 44, min: 26 },
    );
    text(
      "steplbl" + i,
      "body",
      "semibold",
      s,
      stepXs[i] - 150,
      stepY + 56,
      300,
      48,
      C.ink,
      "center",
      { max: 24, min: 15 },
    );
  });

  // ---------- ⑤ 底部品牌条 ----------
  rect(0, H - 44, W, 44, C.greenDeep);
  text(
    "footer",
    "body",
    "bold",
    "GARDEN PRO — техника для российского сада",
    0,
    H - 40,
    W,
    34,
    C.white,
    "center",
    { max: 23, min: 15 },
  );

  return { W, H, shapes, texts, colors: C };
}

function renderMain(ctx, scene) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, scene.W, scene.H);
  for (const s of scene.shapes) drawShape(ctx, s);
  for (const t of scene.texts) drawText(ctx, t);
  const overflowWarnings = scene.texts
    .filter((t) => t.overflow)
    .map((t) => t.overflowWarning);
  return { overflowWarnings, textCount: scene.texts.length };
}

module.exports = { buildScene, renderMain, drawShape, drawText, W, H, C };
