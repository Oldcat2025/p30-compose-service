/**
 * 西里尔字体注册中心（M0-2 / M1-B3 共用）
 *
 * - 每个静态 TTF 用 GlobalFonts.registerFromPath 注册，别名 = 该字体真实 PostScript 名
 *   （canvas 渲染用别名；PSD 文本层 style.font.name 用同一 PS 名，两端一致）
 * - Bebas Neue 无西里尔（cmap 实测 0/66），仅用于纯拉丁/数字英雄数字；
 *   含西里尔的大数字一律走 Oswald。
 *
 * 依赖从项目25 的 node_modules 绝对路径加载（复用已装二进制，免重装）。
 */
const path = require("path");
const fs = require("fs");

const ENGINE25_MODULES =
  process.env.COMPOSE_NODE_MODULES ||
  "D:/N8NProjects/25 电商详情页面批量套版生成/engine/node_modules";
const { createCanvas, GlobalFonts } = require(
  path.join(ENGINE25_MODULES, "@napi-rs/canvas"),
);

const FONTS_DIR = path.join(__dirname, "..", "fonts");

// role + weight -> { file, ps(别名=PS名) }
const REGISTRY = [
  // 大标题 / 卖点大字：Montserrat
  {
    role: "display",
    weight: "black",
    file: "Montserrat-Black.ttf",
    ps: "Montserrat-Black",
    cyrillic: true,
  },
  {
    role: "display",
    weight: "extrabold",
    file: "Montserrat-ExtraBold.ttf",
    ps: "Montserrat-ExtraBold",
    cyrillic: true,
  },
  {
    role: "display",
    weight: "bold",
    file: "Montserrat-Bold.ttf",
    ps: "Montserrat-Bold",
    cyrillic: true,
  },
  {
    role: "display",
    weight: "semibold",
    file: "Montserrat-SemiBold.ttf",
    ps: "Montserrat-SemiBold",
    cyrillic: true,
  },
  {
    role: "display",
    weight: "medium",
    file: "Montserrat-Medium.ttf",
    ps: "Montserrat-Medium",
    cyrillic: true,
  },
  {
    role: "display",
    weight: "regular",
    file: "Montserrat-Regular.ttf",
    ps: "Montserrat-Regular",
    cyrillic: true,
  },
  // 正文 / 参数 / 表格：Golos Text
  {
    role: "body",
    weight: "extrabold",
    file: "GolosText-ExtraBold.ttf",
    ps: "GolosText-ExtraBold",
    cyrillic: true,
  },
  {
    role: "body",
    weight: "bold",
    file: "GolosText-Bold.ttf",
    ps: "GolosText-Bold",
    cyrillic: true,
  },
  {
    role: "body",
    weight: "semibold",
    file: "GolosText-SemiBold.ttf",
    ps: "GolosText-SemiBold",
    cyrillic: true,
  },
  {
    role: "body",
    weight: "medium",
    file: "GolosText-Medium.ttf",
    ps: "GolosText-Medium",
    cyrillic: true,
  },
  {
    role: "body",
    weight: "regular",
    file: "GolosText-Regular.ttf",
    ps: "GolosText-Regular",
    cyrillic: true,
  },
  // 窄体数字 / 密集参数：Oswald（含西里尔）
  {
    role: "num",
    weight: "bold",
    file: "Oswald-Bold.ttf",
    ps: "Oswald-Bold",
    cyrillic: true,
  },
  {
    role: "num",
    weight: "semibold",
    file: "Oswald-SemiBold.ttf",
    ps: "Oswald-SemiBold",
    cyrillic: true,
  },
  {
    role: "num",
    weight: "medium",
    file: "Oswald-Medium.ttf",
    ps: "Oswald-Medium",
    cyrillic: true,
  },
  {
    role: "num",
    weight: "regular",
    file: "Oswald-Regular.ttf",
    ps: "Oswald-Regular",
    cyrillic: true,
  },
  // 英雄大数字：Bebas Neue（仅拉丁/数字，无西里尔）
  {
    role: "hero",
    weight: "regular",
    file: "BebasNeue-Regular.ttf",
    ps: "BebasNeue-Regular",
    cyrillic: false,
  },
];

let registered = false;
const byKey = {};

function registerAll() {
  if (registered) return;
  for (const f of REGISTRY) {
    const fp = path.join(FONTS_DIR, f.file);
    if (!fs.existsSync(fp)) {
      byKey[`${f.role}/${f.weight}`] = {
        ...f,
        ok: false,
        error: "file missing",
      };
      continue;
    }
    try {
      const ok = GlobalFonts.registerFromPath(fp, f.ps);
      byKey[`${f.role}/${f.weight}`] = { ...f, ok: !!ok };
    } catch (e) {
      byKey[`${f.role}/${f.weight}`] = { ...f, ok: false, error: e.message };
    }
  }
  registered = true;
}

/** 取字体描述符 {ps, file, role, weight, cyrillic} */
function font(role, weight) {
  registerAll();
  return byKey[`${role}/${weight}`] || null;
}

/** canvas ctx.font 字符串，px 为像素字号 */
function fontCss(role, weight, px) {
  const f = font(role, weight);
  const fam = f && f.ok ? f.ps : "sans-serif";
  return `${px}px "${fam}"`;
}

/**
 * 为可能含西里尔的字符串选字体：hero(Bebas) 遇西里尔自动回退 num(Oswald)。
 */
function pickFontForText(role, weight, text) {
  const f = font(role, weight);
  const hasCyr = /[Ѐ-ӿ]/.test(text || "");
  if (f && f.role === "hero" && hasCyr) {
    return font("num", "bold") || f;
  }
  return f;
}

module.exports = {
  createCanvas,
  GlobalFonts,
  registerAll,
  font,
  fontCss,
  pickFontForText,
  REGISTRY,
  FONTS_DIR,
  ENGINE25_MODULES,
};
