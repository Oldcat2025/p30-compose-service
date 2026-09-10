/**
 * 数据驱动合版渲染器 —— 读模板几何 + 产品档案出图。
 * 与定型脚本 replicate-garden.js 逐版块同序同参，供像素级回归。
 * 约定：
 *   template = { key, width, topPad, gap, colors, sections: [{type, content, height, g}] }
 *   product  = { brand, photos: {key: path}, <template.key>: {...} }
 *   内容/坐标零硬编码：俄语文案在产品档案、几何在模板、颜色键在模板 colors。
 */
const fs = require("fs");
const path = require("path");
const { createStage, makePhoto } = require("../engine");
const { exportJpg, exportPsd, exportSvg } = require("../export-m0");
const F = require(
  path.join(__dirname, "..", "..", "03-合版引擎-spike", "lib", "fonts"),
);

/** 按几何 spec 画一条文本（spec.x/spec.y 为版块内偏移，加 oy） */
function txt(stage, C, spec, text, oy) {
  return stage.text(
    spec.role,
    spec.weight,
    text,
    spec.x,
    oy + spec.y,
    spec.w,
    spec.h,
    C[spec.color],
    spec.align,
    spec.cap,
  );
}

/** 胶囊标签：色块 + 白字（g.tag: 块 x/y/w/h/r/color + 文 tx/ty/tw/th/cap） */
function tagChip(stage, C, g, text, oy) {
  const t = g.tag;
  stage.rrect(t.x, oy + t.y, t.w, t.h, t.r, C[t.color]);
  stage.text(
    "body",
    "bold",
    text,
    t.tx,
    oy + t.ty,
    t.tw,
    t.th,
    C.white,
    "left",
    t.cap,
  );
}

const HANDLERS = {
  /** 概述：胶囊 + 大标题 + 一行简述 */
  overview(stage, C, g, c, oy) {
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.sub, c.sub, oy);
  },

  /** 首页：胶囊 + 满幅场景大图 + 居中标题/描述 */
  async heroPhoto(stage, C, g, c, oy, photos) {
    tagChip(stage, C, g, c.tag, oy);
    await makePhoto(
      stage,
      photos[c.photo],
      g.photo.x,
      oy + g.photo.y,
      g.photo.w,
      g.photo.h,
      g.photo.r,
    );
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.desc, c.desc, oy);
  },

  /** 文字描述：整版浅底（behind）+ 胶囊 + 正文 */
  textBlock(stage, C, g, c, oy) {
    const b = g.bg;
    if (b.behind) stage.bgRect(b.x, oy + b.y, b.w, b.h, C[b.color]);
    else stage.rect(b.x, oy + b.y, b.w, b.h, C[b.color]);
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.body, c.text, oy);
  },

  /** 卖点：胶囊 + 标题 + N 行（图标方块 + 对勾 + 粗标题 + 描述） */
  bullets(stage, C, g, c, oy) {
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    c.items.forEach((it, i) => {
      const ry = oy + g.itemYs[i];
      stage.rrect(g.icon.x, ry, g.icon.w, g.icon.h, g.icon.r, C[g.icon.color]);
      stage.check(
        g.icon.checkX,
        ry + g.icon.checkOff,
        g.icon.checkR,
        C.white,
        5,
      );
      txt(stage, C, { ...g.head, y: g.head.offY }, it[0], ry);
      txt(stage, C, { ...g.desc, y: g.desc.offY }, it[1], ry);
    });
  },

  /** 细节图文：竖线 + 胶囊 + 标题 + 左大图 + 右 N 组（组间空档取自 g.groupH/groupD） */
  async detailSplit(stage, C, g, c, oy, photos) {
    const v = g.vline;
    stage.rect(v.x, oy + v.y, v.w, v.h, C[v.color]);
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    await makePhoto(
      stage,
      photos[c.photo],
      g.photo.x,
      oy + g.photo.y,
      g.photo.w,
      g.photo.h,
      g.photo.r,
    );
    c.groups.forEach((grp, i) => {
      txt(
        stage,
        C,
        { ...g.head, x: g.textX, y: g.groupH[i], w: g.textW, h: g.head.h },
        grp[0],
        oy,
      );
      txt(
        stage,
        C,
        { ...g.desc, x: g.textX, y: g.groupD[i], w: g.textW, h: g.dHeights[i] },
        grp[1],
        oy,
      );
    });
  },

  /** 场景网格：胶囊 + 标题 + cols×rows 图 + caption */
  async photoGrid(stage, C, g, c, oy, photos) {
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    const perRow = g.cols.length;
    for (let i = 0; i < c.photos.length; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = g.cols[col];
      const y = oy + g.rowYs[row];
      await makePhoto(
        stage,
        photos[c.photos[i]],
        x,
        y,
        g.colW,
        g.imgH,
        g.photoR,
      );
      txt(
        stage,
        C,
        { ...g.cap, x, y: g.rowYs[row] + g.capOff },
        c.captions[i] || "",
        oy,
      );
    }
  },

  /** 参数表：胶囊 + 标题 + 面板 + 斑马行（行高按行数均分面板） */
  paramTable(stage, C, g, c, oy) {
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    const p = g.panel;
    const py = oy + p.y;
    stage.rrect(p.x, py, p.w, p.h, p.r, C[p.color]);
    const rows = c.rows;
    const rowH = g.rowAreaH / rows.length;
    const rowTop = py + g.rowTopOff;
    rows.forEach((r, i) => {
      const ry = rowTop + i * rowH;
      if (i % 2 === 0)
        stage.rect(g.zebra.x, ry, g.zebra.w, rowH, C[g.zebra.color]);
      txt(stage, C, { ...g.key, y: ry - oy + g.key.offY }, r[0], oy);
      txt(stage, C, { ...g.val, y: ry - oy + g.val.offY }, r[1], oy);
    });
  },

  /** 安装卡片：胶囊 + 标题 + 2×N 圆角框卡片（序号圆 + 小标题 + 描述） */
  stepCards(stage, C, g, c, oy) {
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    const gd = g.grid;
    const colW = gd.cardW + gd.gapX;
    const rowH = gd.cardH + gd.gapY;
    c.cards.forEach((card, i) => {
      const x = gd.x0 + (i % gd.cols) * colW;
      const yy = oy + gd.y0 + Math.floor(i / gd.cols) * rowH;
      const f = g.frame;
      stage.rrect(x, yy, gd.cardW, gd.cardH, f.r, C[f.color]);
      stage.rrect(
        x + f.inset,
        yy + f.inset,
        gd.cardW - f.inset * 2,
        gd.cardH - f.inset * 2,
        f.innerR,
        C[f.innerColor],
      );
      const n = g.num;
      stage.circle(x + n.cxOff, yy + n.cyOff, n.r, C[n.color]);
      stage.text(
        "num",
        "bold",
        String(i + 1),
        x + n.txOff,
        yy + n.tyOff,
        n.tw,
        n.th,
        C.white,
        "center",
        n.cap,
      );
      txt(
        stage,
        C,
        {
          ...g.head,
          x: x + g.head.xOff,
          y: g.head.yOff,
          w: gd.cardW - g.head.wOff,
        },
        card[0],
        yy,
      );
      txt(
        stage,
        C,
        {
          ...g.desc,
          x: x + g.desc.xOff,
          y: g.desc.yOff,
          w: gd.cardW - g.desc.wOff,
        },
        card[1],
        yy,
      );
    });
  },

  /** 竞品对比：胶囊 + 标题 + 容器面板 + 满宽表头条三列 + 斑马表体三列 */
  compareTable(stage, C, g, c, oy) {
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    const ct = g.container;
    const cy = oy + ct.y;
    stage.rrect(ct.x, cy, ct.w, ct.h, ct.r, C[ct.color]);
    const hd = g.head;
    const headY = cy + hd.yOff;
    stage.rrect(ct.x, headY, ct.w, hd.h, hd.r, C[hd.color]);
    hd.cells.forEach((cell, i) => {
      stage.text(
        "body",
        "bold",
        c.head[i],
        cell.x,
        headY + hd.textOffY,
        cell.w,
        hd.textH,
        C[cell.color],
        cell.align,
        cell.cap,
      );
    });
    const rows = c.rows;
    const rowH = (ct.h - hd.yOff - hd.h - g.body.padBottom) / rows.length;
    const bodyTop = headY + hd.h;
    rows.forEach((r, i) => {
      const ry = bodyTop + i * rowH;
      if (i % 2 === 0)
        stage.rect(
          g.body.zebra.x,
          ry,
          g.body.zebra.w,
          rowH,
          C[g.body.zebra.color],
        );
      g.body.cols.forEach((col, j) => {
        stage.text(
          "body",
          col.weight,
          r[j],
          col.x,
          ry + g.body.textOffY,
          col.w,
          g.body.textH,
          C[col.color],
          col.align,
          col.cap,
        );
      });
    });
  },

  /** 品牌故事：胶囊 + 满幅大图 + 居中标题/正文/服务行 + 满宽品牌横幅 */
  async brandStory(stage, C, g, c, oy, photos) {
    tagChip(stage, C, g, c.tag, oy);
    await makePhoto(
      stage,
      photos[c.photo],
      g.photo.x,
      oy + g.photo.y,
      g.photo.w,
      g.photo.h,
      g.photo.r,
    );
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.body, c.body, oy);
    txt(stage, C, g.service, c.service, oy);
    const b = g.banner;
    const by = oy + b.y;
    stage.rect(0, by, 900, b.h, C[b.color]);
    stage.text(
      "display",
      "bold",
      c.bannerTitle,
      b.titleX,
      by + b.titleYOff,
      b.titleW,
      b.titleH,
      C[b.titleColor],
      "left",
      b.titleCap,
    );
    c.bannerLines.forEach((ln, i) => {
      stage.text(
        "body",
        "regular",
        ln,
        b.lineX,
        by + b.lineYOff + i * b.linePitch,
        b.lineW,
        b.lineH,
        C[b.lineColor],
        "left",
        b.lineCap,
      );
    });
  },

  /** home 首页：顶部细条 + 品牌行/标题/副题 + 大图 + 三统计卡 */
  async homeHero(stage, C, g, c, oy, photos) {
    const b = g.topBar;
    stage.rect(b.x, oy + b.y, b.w, b.h, C[b.color]);
    txt(stage, C, g.brandLine, c.brandLine, oy);
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.sub, c.sub, oy);
    await makePhoto(
      stage,
      photos[c.photo],
      g.photo.x,
      oy + g.photo.y,
      g.photo.w,
      g.photo.h,
      g.photo.r,
    );
    const cd = g.cards;
    c.cards.forEach((card, i) => {
      const x = cd.x0 + i * (cd.cardW + cd.gap);
      const cy = oy + cd.y;
      stage.rrect(x, cy, cd.cardW, cd.cardH, cd.r, C[cd.color]);
      txt(
        stage,
        C,
        { ...cd.num, x, y: cd.y + cd.num.yOff, w: cd.cardW },
        card[0],
        oy,
      );
      txt(
        stage,
        C,
        { ...cd.label, x, y: cd.y + cd.label.yOff, w: cd.cardW },
        card[1],
        oy,
      );
    });
  },

  /** home 梗概：整版横幅底 + 标签胶囊 + 标题 + 正文 */
  homeSummary(stage, C, g, c, oy) {
    const b = g.bg;
    stage.bgRect(b.x, oy + b.y, b.w, b.h, C[b.color]);
    tagChip(stage, C, g, c.tag, oy);
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.body, c.text, oy);
  },

  /** home 核心功能：整版浅底 + 标题/副题 + 左图 + 右 N 行（胶囊+标题+描述） */
  async homeFeatures(stage, C, g, c, oy, photos) {
    const b = g.bg;
    stage.bgRect(b.x, oy + b.y, b.w, b.h, C[b.color]);
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.sub, c.sub, oy);
    await makePhoto(
      stage,
      photos[c.photo],
      g.photo.x,
      oy + g.photo.y,
      g.photo.w,
      g.photo.h,
      g.photo.r,
    );
    const r = g.rows;
    c.rows.forEach((row, i) => {
      const ry = oy + r.ys[i];
      stage.rrect(r.x, ry, r.chip.w, r.chip.h, r.chip.r, C[r.chip.color]);
      stage.text(
        "body",
        "bold",
        row[0],
        r.x,
        ry + r.chip.textY,
        r.chip.textW,
        r.chip.textH,
        C.white,
        "center",
        r.chip.cap,
      );
      txt(stage, C, { ...r.head, y: r.head.yOff }, row[1], ry);
      txt(stage, C, { ...r.desc, y: r.desc.yOff }, row[2], ry);
    });
  },

  /** home 细节描述：标题 + N 组纵排（图 + 标题 + 描述） */
  async homeDetailRows(stage, C, g, c, oy, photos) {
    txt(stage, C, g.title, c.title, oy);
    const r = g.rows;
    for (let i = 0; i < c.items.length; i++) {
      const it = c.items[i];
      const ry = oy + r.ys[i];
      await makePhoto(
        stage,
        photos[it.photo],
        r.x,
        ry,
        r.w,
        r.photoH,
        r.photoR,
      );
      txt(
        stage,
        C,
        { ...r.head, x: r.textX, y: r.head.yOff, w: r.textW },
        it.head,
        ry,
      );
      txt(
        stage,
        C,
        { ...r.desc, x: r.textX, y: r.desc.yOff, w: r.textW },
        it.desc,
        ry,
      );
    }
  },

  /** home 场景网格：整版深蓝底 + 标题/副题 + 2×2 白卡图（bgRrect 卡底 + 图 + caption） */
  async homeSceneGrid(stage, C, g, c, oy, photos) {
    const b = g.bg;
    stage.bgRect(b.x, oy + b.y, b.w, b.h, C[b.color]);
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.sub, c.sub, oy);
    for (let i = 0; i < c.photos.length; i++) {
      const col = i % g.cols.length;
      const row = Math.floor(i / g.cols.length);
      const x = g.cols[col];
      const y = oy + g.rowYs[row];
      stage.bgRrect(x, y, g.cardW, g.cardH, g.cardR, C[g.cardColor]);
      await makePhoto(
        stage,
        photos[c.photos[i]],
        x,
        y,
        g.cardW,
        g.cardH - g.imgPadBottom,
        g.photoR,
      );
      txt(
        stage,
        C,
        { ...g.cap, x, y: g.rowYs[row] + g.capOff },
        c.captions[i] || "",
        oy,
      );
    }
  },

  /** home 参数表：标题/副题 + 无面板斑马两列（行高固定） */
  homeParamTable(stage, C, g, c, oy) {
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.sub, c.sub, oy);
    c.rows.forEach((row, i) => {
      const ry = oy + g.top + i * g.rowH;
      if (i % 2 === 0)
        stage.rect(
          g.zebra.x,
          ry + g.zebra.yOff,
          g.zebra.w,
          g.rowH,
          C[g.zebra.color],
        );
      txt(
        stage,
        C,
        { ...g.key, y: g.top + i * g.rowH + g.key.yOff },
        row[0],
        oy,
      );
      txt(
        stage,
        C,
        { ...g.val, y: g.top + i * g.rowH + g.val.yOff },
        row[1],
        oy,
      );
    });
  },

  /** home 使用教程：标题/副题 + N 步（序号圆+数字+标题+描述）+ 底部分隔线 */
  homeSteps(stage, C, g, c, oy) {
    txt(stage, C, g.title, c.title, oy);
    txt(stage, C, g.sub, c.sub, oy);
    c.items.forEach((s, i) => {
      const y = oy + g.ys[i];
      stage.circle(
        g.circle.x,
        y + g.circle.yOff,
        g.circle.r,
        C[g.circle.color],
      );
      stage.text(
        "num",
        "bold",
        String(i + 1),
        g.num.x,
        y + g.num.yOff,
        g.num.w,
        g.num.h,
        C.white,
        "center",
        g.num.cap,
      );
      txt(stage, C, { ...g.head, y: g.head.yOff }, s[0], y);
      txt(stage, C, { ...g.desc, y: g.desc.yOff }, s[1], y);
    });
    const ln = g.line;
    stage.line(ln.x1, oy + ln.y, ln.x2, oy + ln.y, C[ln.color], ln.w);
  },

  /** home 品牌故事：大标题 + N 段正文 + 横图 + 底部圆角横幅（左品牌 + 右服务行） */
  async homeBrandStory(stage, C, g, c, oy, photos) {
    txt(stage, C, g.title, c.title, oy);
    c.paragraphs.forEach((p, i) => {
      txt(stage, C, { ...g.body, y: g.body.y + i * g.body.pitch }, p, oy);
    });
    await makePhoto(
      stage,
      photos[c.photo],
      g.photo.x,
      oy + g.photo.y,
      g.photo.w,
      g.photo.h,
      g.photo.r,
    );
    const b = g.banner;
    stage.rrect(b.x, oy + b.y, b.w, b.h, b.r, C[b.color]);
    stage.text(
      "display",
      "bold",
      c.bannerTitle,
      b.titleX,
      oy + b.titleY,
      b.titleW,
      b.titleH,
      C[b.titleColor],
      "left",
      b.titleCap,
    );
    stage.text(
      "body",
      "regular",
      c.bannerLine,
      b.lineX,
      oy + b.lineY,
      b.lineW,
      b.lineH,
      C[b.lineColor],
      "right",
      b.lineCap,
    );
  },
};

/** 组装 stage：按模板顺序渲染版块，版块间加 gap（末版块后不加） */
async function buildStage(template, product, extraHandlers) {
  F.registerAll();
  const stage = createStage();
  const C = template.colors;
  const P = product[template.key];
  if (!P)
    throw new Error("product has no content for template: " + template.key);
  let oy = template.topPad;
  const n = template.sections.length;
  for (let i = 0; i < n; i++) {
    const s = template.sections[i];
    const handler =
      (extraHandlers && extraHandlers[s.type]) || HANDLERS[s.type];
    if (!handler) throw new Error("unknown section type: " + s.type);
    const c = P[s.content];
    if (!c) throw new Error("product missing content: " + s.content);
    await handler(stage, C, s.g, c, oy, product.photos);
    oy += s.height + (s.tailPad || 0) + (i < n - 1 ? template.gap : 0);
  }
  stage.H = Math.ceil(oy);
  return stage;
}

/** 出三产物 + ASCII 摘要（供回归验证），outDir 必须由入口显式给出 */
/** 出三产物 + ASCII 摘要（供回归验证），outDir 必须由入口显式给出 */
async function renderTemplate(
  template,
  product,
  outDir,
  prefix,
  extraHandlers,
) {
  const stage = await buildStage(template, product, extraHandlers);
  const overflows = stage.texts.filter((t) => t.overflow);
  const bg = template.colors.bg;
  const jpg = await exportJpg(stage, bg);
  fs.writeFileSync(path.join(outDir, prefix + ".jpg"), jpg);
  const psd = await exportPsd(stage, bg);
  fs.writeFileSync(path.join(outDir, prefix + ".psd"), psd);
  const svg = await exportSvg(stage, bg);
  fs.writeFileSync(path.join(outDir, prefix + ".svg"), svg, "utf8");
  const stats = {
    size: stage.W + "x" + stage.H,
    texts: stage.texts.length,
    shapes: stage.shapes.length,
    behind: stage.behindShapes.length,
    images: stage.images.length,
    overflow: overflows.length,
    jpgBytes: jpg.length,
    psdBytes: psd.length,
    svgBytes: Buffer.byteLength(svg, "utf8"),
  };
  fs.writeFileSync(
    path.join(outDir, prefix + "-verify.txt"),
    Object.entries(stats)
      .map(([k, v]) => k + "=" + v)
      .join("\n") + "\n",
    "utf8",
  );
  return { stage, stats };
}

module.exports = { buildStage, renderTemplate, HANDLERS };
