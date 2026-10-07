/**
 * M1-B1 合版引擎服务（HTTP 层）
 *
 * 将 数据驱动合版引擎（09-M0-合版样图/compose/renderer.js）包成可被 n8n 通过 HTTP 调用的独立服务。
 * 端点：POST /v1/compose | GET /v1/health | GET /v1/templates
 * 权威依据：06-契约/C4-合版引擎API.md
 *
 * 技术底座判断：
 *   C4 契约写"权威源 = spike 03-合版引擎-spike/lib/export.js"，但 spike 版只处理 shapes+texts，
 *   【没有产品摄影层 images / 背景色块 behindShapes】，出不了客户要的天猫式高密度图。
 *   真正跑通并产出 900×7363（93文字层/7图/0溢出）三产物的是 09 的数据驱动版
 *   （renderer.js + export-m0.js，含产品摄影层 + behindShapes）。故本服务以 09 为底座，spike 仅作参考。
 *
 * 依赖（复用项目25 绝对路径）：@napi-rs/canvas、ag-psd（见 fonts.js ENGINE25_MODULES）。
 * 字体：03-合版引擎-spike/fonts 的 22 个 ttf。
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ---- 引擎底座（09 数据驱动合版，含产品摄影层） ----
const COMPOSE_DIR = path.join(__dirname, "..", "09-M0-合版样图", "compose");
const { renderTemplate, buildStage } = require(path.join(COMPOSE_DIR, "renderer"));
const { exportJpg, exportPsd, exportSvg } = require(path.join(COMPOSE_DIR, "..", "export-m0"));

// ---- 模板档案表（specId → template 模块 + 默认产品档案） ----
// 目前注册 M0 已跑通的 garden(绿/园艺) / home(蓝/家居)。新模板接入 = 加一行。
const TEMPLATE_REGISTRY = {
  "oz-garden-infographic-v1": {
    template: require(path.join(COMPOSE_DIR, "template-garden")),
    product: require(path.join(COMPOSE_DIR, "product-lawnmower")),
  },
  "oz-home-infographic-v1": {
    template: require(path.join(COMPOSE_DIR, "template-home")),
    product: require(path.join(COMPOSE_DIR, "product-lawnmower")),
  },
};

// ---- 配置 ----
const PORT = parseInt(process.env.COMPOSE_PORT || "8200", 10);
const HOST = process.env.COMPOSE_HOST || "0.0.0.0"; // 仅内网，生产由 compose 网络绑定
const COMPOSE_KEY = process.env.COMPOSE_KEY || "dev-compose-key"; // 生产必须覆写
// 产物落盘根目录；生产可由调用方传 outputBaseDir（C4 §2.5）
const OUTPUT_ROOT = path.join(__dirname, "output");

// ---- 幂等 / 并发 ----
const idempotencyCache = new Map(); // key -> {at, response}
const inFlight = new Map(); // key -> Promise
const MAX_CONCURRENT = parseInt(process.env.COMPOSE_MAX_CONCURRENT || "2", 10);
let activeRenders = 0;
const renderQueue = [];
/* ★ 2026-10-06（审查 E1）：画布/图片尺寸上限。与 image-inspection.js 的 7680 同款 ——
   原来 /v1/render-shot 与 /v1/logo-overlay 对 canvas.width/height 零校验，
   `{canvas:{width:100000,height:100000}}` 会在 native 层直接 OOM 杀掉整个进程。 */
const MAX_DIM = 7680;
/* ★ 2026-10-06（审查 E2）：外呼取图的上限与白名单（防 SSRF / 超大文件 / 重定向环）。
   与 image-inspection.js 的 MAX_BYTES / ALLOWED_HOSTS 对齐，另允许显式追加 .alicdn.com。 */
const FETCH_MAX_BYTES = 10 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 20000;
const FETCH_ALLOWED_HOSTS = new Set([
  "catait-images-photo-factory.oss-cn-hangzhou.aliyuncs.com",
  "ozon.zeabur.app",
]);
/* ★ 2026-10-06（审查 E4）：幂等缓存/产物/临时图的保留期与清理。
   原实现只写不删 —— _photos 临时图与 output 产物（每单数 MB~数十 MB）永不清理，磁盘必满。 */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;         // 幂等缓存保留 10 分钟（与命中窗口一致）
const OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;   // 产物保留 24 小时
const PHOTO_RETENTION_MS = 60 * 60 * 1000;         // _photos 临时图保留 1 小时

// ---- 小工具 ----
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// 常量时间比较（防时序侧信道；n8n Function v1 侧只做 X-Compose-Key 简单比较，见 C4 §3）
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function nowIso() {
  return new Date().toISOString();
}

/** 读请求体（限流防止超大 payload） */
function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** 安全文件名（防路径穿越/非法字符） */
function safeName(s) {
  return String(s || "out").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
}

// ---- 数据化工具（B2） ----

/** 深拷贝（防 require 单例被请求间污染） */
function deepClone(o) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(o);
    } catch (e) {
      /* 含函数时回退 */
    }
  }
  return JSON.parse(JSON.stringify(o));
}

/** 深合并：对象递归合并；数组/标量直接替换（override 优先） */
function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override; // 数组整体替换
  if (typeof base === "object" && typeof override === "object") {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const k of Object.keys(override)) {
      out[k] = k in base ? deepMerge(base[k], override[k]) : override[k];
    }
    return out;
  }
  return override;
}

/**
 * 解析 photoLayers → 本地图片文件路径
 * photoLayers: [{ id, source: { type:"url"|"base64", url? , data?, mediaType? }, fit? }]
 * 返回 { id → localPath }，并收集告警（下载失败等）
 */
async function resolvePhotoLayers(photoLayers, workDir, warnings, strict) {
  const resolved = {};
  if (!Array.isArray(photoLayers) || photoLayers.length === 0) return resolved;
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  for (const layer of photoLayers) {
    const id = layer && layer.id;
    if (!id) continue;
    const src = layer.source || {};
    try {
      let buf = null;
      let ext = ".jpg";
      if (src.type === "base64" && src.data) {
        let b64 = String(src.data);
        const m = b64.match(/^data:([^;]+);base64,([\s\S]*)$/);
        if (m) {
          ext = "." + (m[1].split("/")[1] || "jpg").replace("jpeg", "jpg");
          b64 = m[2];
        } else if (src.mediaType) {
          ext = "." + (src.mediaType.split("/")[1] || "jpg").replace("jpeg", "jpg");
        }
        buf = Buffer.from(b64, "base64");
        // C4 §3：inline base64 限小资产（<200KB）——大 AI 图应走 url
        if (buf.length > 1024 * 1024) {
          warnings.push({ severity: "warn", kind: "photo-inline-large", zoneId: id, message: "inline base64 >1MB; prefer url" });
        }
      } else if (src.type === "url" && src.url) {
        buf = await fetchUrlBuffer(src.url);
        const gu = String(src.url);
        if (/\.png(\?|$)/i.test(gu)) ext = ".png";
        else if (/\.webp(\?|$)/i.test(gu)) ext = ".webp";
      } else if (src.type === "path" && src.path) {
        // 本地路径（同机部署/调试）
        if (fs.existsSync(src.path)) {
          resolved[id] = src.path;
          continue;
        }
        throw new Error("local path not found: " + src.path);
      } else {
        throw new Error("unsupported photo source");
      }
      if (!buf || buf.length === 0) throw new Error("empty image data");
      const outPath = path.join(workDir, "photo_" + safeName(id) + ext);
      fs.writeFileSync(outPath, buf);
      resolved[id] = outPath;
    } catch (e) {
      warnings.push({
        severity: "warn",
        kind: "photo-fetch-failed",
        zoneId: id,
        message: String(e.message || e),
        detail: { id, sourceType: src.type },
      });
      // ★ 2026-10-06（审查 E5）：strictPhoto=true 时不再静默回退默认产品档案的照片
      //   （否则生成图里是别的商品，保真风险），改为直接失败让调用方处理。
      if (strict) throw new Error("照片下载失败（strictPhoto=true，不静默回退默认图）: " + id + " — " + String(e.message || e));
      // 不致命：保留默认产品档案的该照片（占位兜底）
    }
  }
  return resolved;
}

/** 下载 URL → Buffer（超时 + 大小上限 + 重定向跟随） */
function fetchUrlBuffer(url, timeoutMs = 20000, maxBytes = 30 * 1024 * 1024, depth = 0) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? require("https") : require("http");
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      /* ★ 2026-10-06（审查 E5）：原来只拦 >=400，3xx 会被当成功读进 body ——
         图床 302 到 HTML 页时，就把 HTML 当 .jpg 写盘（伪图片，下游解码失败）。
         现在：3xx 带 Location → 跟随（≤3 跳）；3xx 无 Location → 报错；最终必须 2xx。 */
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= 3) { reject(new Error("too many redirects for " + url)); return; }
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (_) { reject(new Error("bad redirect for " + url)); return; }
        return fetchUrlBuffer(next, timeoutMs, maxBytes, depth + 1).then(resolve, reject);
      }
      if (res.statusCode && res.statusCode >= 300) {
        reject(new Error("HTTP " + res.statusCode + " for " + url));
        res.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new Error("image too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("download timeout"));
    });
    req.on("error", reject);
  });
}

// ---- 文案缺字预检（C4 §4.3 missing-glyph） ----
/**
 * 文案来自 API/AI（copy 由 n8n 传入），可能混入字体不支持的字符（中文/emoji/其它语言）
 * → 渲染成豆腐块（.notdef），且 canvas 不会报错。必须在渲染前确定性检出并告警，
 * 否则豆腐块会静默流到成品图（违反 PRD "零豆腐块" 硬指标）。
 *
 * 判定方式：opentype.js 读 TTF cmap，charToGlyphIndex(ch)===0 即字体无该字形
 * （不靠 measureText —— .notdef 也有正宽度，会误判；与 font-cmap.js 同口径）。
 */
let _glyphFonts = null;
function glyphFonts() {
  if (_glyphFonts) return _glyphFonts;
  const op = require(process.env.COMPOSE_OPENTYPE_PATH || path.join(__dirname, "..", "03-合版引擎-spike", "node_modules", "opentype.js"));
  const FD = path.join(__dirname, "..", "03-合版引擎-spike", "fonts");
  // 引擎各 role 的主力字体（西里尔全覆盖）；取并集做最宽松判定，避免误报
  const files = ["GolosText-Regular.ttf", "GolosText-Bold.ttf", "Montserrat-Black.ttf", "Montserrat-Bold.ttf", "Oswald-Regular.ttf", "BebasNeue-Regular.ttf"];
  _glyphFonts = files.map((f) => {
    try {
      return op.loadSync(path.join(FD, f));
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
  return _glyphFonts;
}

function glyphCovered(ch) {
  // 控制字符/空白不判
  if (ch === "\n" || ch === "\r" || ch === "\t" || ch === " ") return true;
  const code = ch.codePointAt(0);
  if (code < 0x20) return true;
  for (const f of glyphFonts()) {
    try {
      if (f.charToGlyphIndex(ch) !== 0) return true;
    } catch (e) {
      /* skip */
    }
  }
  return false;
}

/** 递归收集对象里所有字符串中字体不支持的字符 */
function collectMissingGlyphs(obj, missing, depth) {
  if (depth > 6 || obj == null) return;
  if (typeof obj === "string") {
    for (const ch of obj) {
      if (!glyphCovered(ch)) missing.add(ch);
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const it of obj) collectMissingGlyphs(it, missing, depth + 1);
    return;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) collectMissingGlyphs(obj[k], missing, depth + 1);
  }
}

// ---- 输入适配：C4 请求体 → (template, product) ----
/**
 * C4 请求：{ specId 或 spec, canvas.ratio, lang, photoLayers[], copy{}, brand{}, outputs{}, taskId, idempotencyKey }
 *
 * B2 数据化：把 copy / photoLayers / brand 覆盖到已注册模板的默认产品档案上，
 * 让"换产品/换文案/换配色"不必改引擎代码 —— M1-C7 n8n 传真实产品数据即出图。
 *
 * 覆盖语义（与 09 引擎的 section 模型对齐）：
 *   - brand.palette   → { 色键: "#hex" } 覆盖 template.colors（换品类只换色，如园艺绿→家居蓝）
 *   - copy            → 按 section 键深合并（部分覆盖即可）：{ overview:{title:"..."}, bullets:{items:[...]}, ... }
 *                       若 copy 自带与 specId 同名键（如 { garden:{...} }）则以该键为整包内容
 *   - photoLayers[]   → { id, source:{url|base64|path} } 解析成本地图片，覆盖 product.photos[id]
 *
 * 诚实边界：C4 §2.3 的扁平 copy 结构（kicker/title_line_1/table_compare…）是"单图位信息图"模型，
 *   而 09 引擎是多版块长图（10 section）。故本项目按【section 键覆盖】实现数据化；
 *   契约 §2.3 需据此升版（见规格说明）。
 */
async function adaptRequest(body) {
  const specId = body.specId;
  if (!TEMPLATE_REGISTRY[specId]) {
    const err = new Error("template not found: " + specId);
    err.code = "TEMPLATE_NOT_FOUND";
    err.httpStatus = 404;
    throw err;
  }
  const entry = TEMPLATE_REGISTRY[specId];
  const warnings = [];

  // ① 深拷贝，避免污染注册表单例
  const template = deepClone(entry.template);
  const product = deepClone(entry.product);
  const tk = template.key; // 模板对应的 product 内容键（garden / home）

  // ② brand.palette 覆盖模板配色
  if (body.brand && body.brand.palette && typeof body.brand.palette === "object") {
    template.colors = deepMerge(template.colors || {}, body.brand.palette);
  }

  // ③ copy 覆盖产品档案内容（section 键深合并）
  if (body.copy && typeof body.copy === "object") {
    let copyOverride = body.copy;
    // 允许 copy 自带模板键整包（{ garden: {...} }）或直接用 section 键
    if (copyOverride[tk] && typeof copyOverride[tk] === "object") {
      copyOverride = copyOverride[tk];
    }
    // 扁平结构适配：C6 输出 {title, bullets:[], details} → 模板 section 结构
    // （C4 契约 §2.3 的扁平结构已过时，引擎实为 section 结构，此处做服务端兼容映射）
    const flatBullets = Array.isArray(copyOverride.bullets);
    const sectionBullets = copyOverride.bullets && !flatBullets;
    const isSectionShape =
      copyOverride.overview || sectionBullets || copyOverride.description ||
      copyOverride.hero || copyOverride.detail || copyOverride.compare ||
      copyOverride.scene || copyOverride.params || copyOverride.install;
    if (!isSectionShape) {
      const flat = copyOverride;
      const mapped = {};
      if (flat.title) mapped.overview = { title: String(flat.title) };
      if (flat.sub) mapped.overview = Object.assign(mapped.overview || {}, { sub: String(flat.sub) });
      if (Array.isArray(flat.bullets) && flat.bullets.length) {
        mapped.bullets = { items: flat.bullets.map(function (b) { return [String(b), ""]; }) };
      }
      if (flat.details) mapped.description = { text: String(flat.details) };
      copyOverride = mapped;
    }
    const baseContent = product[tk] || {};
    product[tk] = deepMerge(baseContent, copyOverride);
  }

  // ④ photoLayers 覆盖照片
  if (Array.isArray(body.photoLayers) && body.photoLayers.length > 0) {
    const workDir = path.join(
      OUTPUT_ROOT,
      "_photos",
      safeName(body.taskId || "task") + "_" + Date.now(),
    );
    const resolved = await resolvePhotoLayers(body.photoLayers, workDir, warnings, body.strictPhoto === true);
    product.photos = Object.assign({}, product.photos, resolved);
  }

  // ⑤ 文案缺字预检：只扫渲染文本（product[tk] 内容 + brand 名），排除 photos 路径（含中文目录不影响渲染）
  const missing = new Set();
  collectMissingGlyphs(product[tk], missing, 0);
  if (typeof product.brand === "string") collectMissingGlyphs(product.brand, missing, 0);
  if (missing.size > 0) {
    const chars = Array.from(missing);
    warnings.push({
      severity: "warn",
      kind: "missing-glyph",
      zoneId: "copy",
      message:
        "文案含字体不支持字符（将渲染为豆腐块，需人工/合规拦截）：" + chars.join(" "),
      detail: { chars, count: chars.length },
    });
    // strict 模式：缺字直接判失败，不产出带豆腐块的图（合规硬要求场景可开）
    if (body.strictGlyph === true) {
      const err = new Error("copy contains unsupported glyphs: " + chars.join(" "));
      err.code = "COPY_INVALID";
      err.httpStatus = 422;
      throw err;
    }
  }

  return { template, product, warnings };
}

// ---- 真正渲染一单（供幂等/并发调度） ----
/** 由实际像素宽高推算最接近的常见比例串（审查 E5：报告 ratio 用生效值，不用请求回显值） */
function ratioOf(w, h) {
  w = Number(w) || 0; h = Number(h) || 0;
  if (!w || !h) return null;
  const r = w / h;
  const CAND = [["1:1", 1], ["3:4", 3 / 4], ["4:3", 4 / 3], ["4:5", 4 / 5], ["9:16", 9 / 16], ["16:9", 16 / 9], ["2:3", 2 / 3]];
  let best = CAND[0], bd = Infinity;
  for (const [name, val] of CAND) { const d = Math.abs(r - val); if (d < bd) { bd = d; best = [name, val]; } }
  // 长图（远超所有常见比例）如实给像素比
  if (bd > 0.25) return w + ":" + h;
  return best[0];
}
async function doCompose(body) {
  const t0 = Date.now();
  const { template, product, warnings: adaptWarnings } = await adaptRequest(body);
  const specId = body.specId;
  const taskId = body.taskId || "task_noid";

  // 唯一输出前缀：taskId + specId + 时间戳，保证并发不互相覆盖
  const prefix =
    safeName(taskId) + "--" + safeName(specId) + "--" + Date.now();
  // 产物目录：C4 §2.5 允许调用方给 outputBaseDir；缺省落服务 output/<taskId>/

  const wantJpg = !body.outputs || body.outputs.jpg === undefined || body.outputs.jpg.enabled !== false;
  const wantPsd = !body.outputs || body.outputs.psd === undefined || body.outputs.psd.enabled !== false;
  const wantSvg = !body.outputs || body.outputs.svg === undefined || body.outputs.svg.mode !== "none";

  // 确保产物目录存在（renderTemplate 写文件时目录必须已建）
  const taskOutDir = path.join(OUTPUT_ROOT, safeName(taskId));
  if (!fs.existsSync(taskOutDir)) fs.mkdirSync(taskOutDir, { recursive: true });
  const outDir = taskOutDir;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const { stage, stats } = await renderTemplate(template, product, outDir, prefix);

  // 回读产物元数据（字节/分辨率/文字层）
  const readMeta = (file) => {
    const p = path.join(outDir, file);
    return { url: p, path: p, exists: fs.existsSync(p), bytes: fs.existsSync(p) ? fs.statSync(p).size : 0 };
  };
  const outputs = {};
  if (wantJpg) outputs.jpg = { ...readMeta(prefix + ".jpg"), width: stage.W, height: stage.H };
  if (wantPsd) outputs.psd = { ...readMeta(prefix + ".psd"), width: stage.W, height: stage.H };
  if (wantSvg) outputs.svg = { ...readMeta(prefix + ".svg"), width: stage.W, height: stage.H, textNodes: stage.texts.length };

  // warnings：溢出/缺字（C4 §4.3）+ 适配层告警（照片下载失败等）
  const warnings = [];
  for (const w of adaptWarnings || []) warnings.push(w);
  for (const t of stage.texts) {
    if (t.overflow) {
      warnings.push({
        severity: "warn",
        kind: "overflow",
        zoneId: t.id,
        message: "text shrank to min size in box",
        detail: { fittedSize: t.size, minSize: t.minSize, overflow: true },
      });
    }
  }

  return {
    ok: true,
    taskId,
    idempotencyKey: body.idempotencyKey || null,
    status: warnings.length ? "succeeded_with_warnings" : "succeeded",
    specId,
    /* ★ 2026-10-06（审查 E5）：ratio 原样回显请求值，但引擎实际恒 900 宽（长图），
       回显值与生效值不符（报告字段=回显非生效值）。改为按实际 stage 尺寸算。 */
    canvas: { ratio: ratioOf(stage.W, stage.H), requested_ratio: (body.canvas && body.canvas.ratio) || null, width: stage.W, height: stage.H },
    outputs,
    warnings,
    metrics: { renderMs: Date.now() - t0, size: stats.size, texts: stats.texts, images: stats.images, overflow: stats.overflow },
  };
}

// ---- 并发调度（限制 canvas 内存峰值） ----
// ★ 2026-10-06（审查 E1）：原来只有 /v1/compose 走这个队列，logo-overlay / render-shot 直接执行，
//   大画布请求可绕过并发上限 → native 层 OOM 杀进程。现改成通用任务队列，三个重端点统一排队。
function scheduleRender(fn) {
  return new Promise((resolve, reject) => {
    renderQueue.push({ fn, resolve, reject });
    pump();
  });
}
function scheduleCompose(body) {
  return scheduleRender(() => doCompose(body));
}
function pump() {
  while (activeRenders < MAX_CONCURRENT && renderQueue.length > 0) {
    const job = renderQueue.shift();
    activeRenders++;
    Promise.resolve()
      .then(() => job.fn())
      .then((r) => job.resolve(r))
      .catch((e) => job.reject(e))
      .finally(() => {
        activeRenders--;
        pump();
      });
  }
  if (activeRenders === 0 && renderQueue.length === 0) maybeSweep();
}

/* ★ 2026-10-06（审查 E4）：惰性清理 —— 队列空闲时最多每 10 分钟跑一次：
   ① 过期幂等缓存；② _photos 临时图（按目录 mtime）；③ output 产物（按目录 mtime）。 */
let _lastSweep = 0;
function sweepDir(dir, maxAgeMs) {
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > maxAgeMs) {
          if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
          else fs.unlinkSync(p);
          removed++;
        }
      } catch (_) { /* 单个条目失败不影响整体 */ }
    }
  } catch (_) { /* 目录不存在/权限问题忽略 */ }
  return removed;
}
function maybeSweep() {
  const now = Date.now();
  if (now - _lastSweep < 10 * 60 * 1000) return;
  _lastSweep = now;
  // 幂等缓存过期
  let c = 0;
  for (const [k, v] of idempotencyCache) { if (now - v.at > IDEMPOTENCY_TTL_MS) { idempotencyCache.delete(k); c++; } }
  const ph = sweepDir(path.join(OUTPUT_ROOT, "_photos"), PHOTO_RETENTION_MS);
  const out = sweepDir(OUTPUT_ROOT, OUTPUT_RETENTION_MS);
  if (c || ph || out) console.log("[sweep] idempotency=%d photos=%d outputs=%d", c, ph, out);
}

// ---- LOGO 后处理贴图（决策 D-3：禁止 AI 重绘，生成后精确贴图）----
// 几何来源：09-M0-合版样图/compose/sections-robot/s4.js 的 g.bolt（闪电多边形 + ZERNO 字标）
// 自然尺寸 160×40（宽 160 = 18 多边形 + 30 间距 + 130 字标 → 4:1），按画布宽百分比等比缩放
const ZERNO_GEOM = {
  pts: [[9, 0], [0, 22], [7, 22], [4, 40], [18, 15], [10, 15]],
  boltW: 18,          // 闪电多边形横向占位
  gap: 10,            // 闪电 → 字标的安全间距（原模板 textDx=30 仅留 12px，视觉上会粘连）
  textDy: 8,          // 字标相对闪电顶部的下移（让字标与闪电视觉重心对齐）
  textH: 30,          // 字标字号（自然尺度）
  naturalW: 160,      // 自然总宽 = boltW 18 + gap 10 + 字标 130 ≈ 158，取整 160
};

function requireCanvas() {
  const cands = [
    "@napi-rs/canvas",
    "/app/node_modules/@napi-rs/canvas",
    path.join(__dirname, "node_modules", "@napi-rs", "canvas"),
    "D:/N8NProjects/25 电商详情页面批量套版生成/engine/node_modules/@napi-rs/canvas",
  ];
  for (const c of cands) { try { return require(c); } catch (e) { /* next */ } }
  throw new Error("CANVAS_LIB_NOT_FOUND");
}

function fontsDirPath() {
  const cands = [
    path.join(__dirname, "..", "03-合版引擎-spike", "fonts"),
    "/app/03-合版引擎-spike/fonts",
    "D:/N8NProjects/30 Ozon俄区AI工作流系统/03-合版引擎-spike/fonts",
  ];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return null;
}

function fetchBuffer(u, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    /* ★ 2026-10-06（审查 E2）：原来这里无超时、无大小上限、3xx 递归无深度限制、也不校验 host
       → SSRF（可拉内网地址 / 云元数据 / 超大文件拖垮内存）。
       现在：host 白名单 + 重定向深度上限 + 超时 + 大小上限。 */
    let parsed;
    try { parsed = new URL(String(u)); } catch (_) { return reject(new Error("invalid image url: " + String(u).slice(0, 80))); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return reject(new Error("unsupported protocol: " + parsed.protocol));
    if (parsed.username || parsed.password) return reject(new Error("credentials in url not allowed"));
    const host = parsed.hostname;
    if (!(FETCH_ALLOWED_HOSTS.has(host) || host.endsWith(".alicdn.com")))
      return reject(new Error("image host is not allowed: " + host));
    if (depth > FETCH_MAX_REDIRECTS) return reject(new Error("too many redirects"));

    const mod = parsed.protocol === "https:" ? require("https") : require("http");
    const req = mod.get(parsed, { timeout: FETCH_TIMEOUT_MS }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();   // 释放上游响应，避免 socket 泄漏
        let next;
        try { next = new URL(r.headers.location, u).toString(); } catch (_) { return reject(new Error("bad redirect location")); }
        return fetchBuffer(next, depth + 1).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error("HTTP " + r.statusCode + " for " + host)); }
      let bytes = 0; const chunks = [];
      r.on("data", (c) => {
        bytes += c.length;
        if (bytes > FETCH_MAX_BYTES) { req.destroy(new Error("image exceeds " + (FETCH_MAX_BYTES / 1048576) + " MB")); return; }
        chunks.push(c);
      });
      r.on("end", () => resolve(Buffer.concat(chunks)));
      r.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("image fetch timeout")));
    req.on("error", reject);
  });
}

// ---- M2 渲染层：生图与排版解耦（确定性文字/LOGO 叠加）----
// 设计见 01 项目设计与开发文档/项目30-M2-生图与排版解耦-技术设计-v1.0.md
let _renderLayer = null;
function renderLayer() {
  if (!_renderLayer) {
    try { _renderLayer = require(path.join(__dirname, "render-layer.js")); }
    catch (e) { _renderLayer = require("./render-layer"); }
  }
  return _renderLayer;
}

/** 在给定图像上精确贴 ZERNO LOGO；返回输出路径与实测几何 */
async function logoOverlay(body) {
  const cv = requireCanvas();
  if (!global.__zernoFontReg) {
    const fd = fontsDirPath();
    if (fd) {
      try { cv.GlobalFonts.registerFromPath(path.join(fd, "Montserrat-Black.ttf"), "ZernoDisplay"); } catch (e) { /* 用兜底字体族 */ }
    }
    global.__zernoFontReg = true;
  }
  const logo = Object.assign({ widthPct: 13.5, yPct: 4, anchor: "top-center", color: "auto" }, body.logo || {});
  let buf = null;
  if (body.imageBase64) buf = Buffer.from(String(body.imageBase64).replace(/^data:[^,]+,/, ""), "base64");
  else if (body.imageUrl) {
    const u = String(body.imageUrl);
    buf = /^https?:/i.test(u) ? await fetchBuffer(u) : fs.readFileSync(u);
  } else throw new Error("imageUrl or imageBase64 required");

  const src = await cv.loadImage(buf);
  const W = src.width, H = src.height;
  /* ★ 2026-10-06（审查 E1）：图片尺寸上限，防 native 层 OOM。 */
  if (!(W > 0) || !(H > 0) || W > MAX_DIM || H > MAX_DIM)
    throw new Error("image dimensions out of range: " + W + "x" + H + " (max " + MAX_DIM + ")");
  const canvas = cv.createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src, 0, 0, W, H);

  // ---- 品牌安全区预处理：抹掉 AI 可能自己画的 LOGO，避免「双 LOGO/重影」----
  // 做法：把安全区降采样到极小再放大回去（等价强模糊）——消除细节、保留底色/光照，不依赖模型听话
  let clearedSafeArea = false;
  let safeAreaMode = "off";
  let safeAreaHeightPct = 0;
  if (body.safeAreaClear !== false) {
    // 抹平带高度：只需覆盖 LOGO 自身占位（默认 y 4% + LOGO 高约 3.5%）+ 余量，
    // 取 max(10%, logo 底部 + 2%) —— 设太大（曾用 16%）会误伤模型排在 ~14% 处的主标题
    // 闪电多边形纵向占位（pts 的 y 最大值为 40）——ZERNO_GEOM 里没有 naturalH 字段，勿臆造
    const _boltNaturalH = 40;
    const _targetWpx = (Number(logo.widthPct) / 100) * W;   // 目标 LOGO 宽（px）
    const _scale = _targetWpx / ZERNO_GEOM.naturalW;        // 缩放系数（无量纲）= 目标宽 ÷ 自然宽
    const _logoBottomPct = Number(logo.yPct) + (_boltNaturalH * _scale * 100) / H;
    // 最小可行带高：只需盖住 LOGO 自身（约 y 4%→6.5%）+ 0.7% 余量。
    // 曾用 10%/16% → 模型把主标题排在 ~8% 处时会被误切。
    // overlay 模式：抹平区必须贴住 LOGO 自身占位（下限 6.8%），否则误切标题；
    // bar 模式：品牌栏是"新增"的、不占画面，故可放心加高到 12% 以彻底清掉模型自画的 logo。
    const _minPct = (body.layout === 'bar') ? 12 : 6.8;
    safeAreaHeightPct = Math.round(Math.max(_minPct, _logoBottomPct + 0.3) * 10) / 10;
    const cw = W, chh = Math.round(H * (safeAreaHeightPct / 100));
    if (cw > 2 && chh > 2) {
      safeAreaMode = (body.safeAreaMode === "blur") ? "blur" : "gradient";
      if (safeAreaMode === "blur") {
        // 强模糊（降采样再放大）：痕迹较明显，仅在需要时启用
        const kx = Math.max(1, Math.round(cw / 40)), ky = Math.max(1, Math.round(chh / 40));
        const tiny = cv.createCanvas(kx, ky);
        tiny.getContext("2d").drawImage(canvas, 0, 0, cw, chh, 0, 0, kx, ky);
        ctx.imageSmoothingEnabled = true;
        if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
        ctx.drawImage(tiny, 0, 0, kx, ky, 0, 0, cw, chh);
      } else {
        // 默认：采样横带自上而下 5 段的平均色，做纵向渐变填充
        // —— 抹掉 LOGO/泄漏文字等一切细节，同时保留该区原有的色调渐进，看不出接缝
        let stops = null;
        try {
          const data = ctx.getImageData(0, 0, cw, chh).data;
          const SEG = 5;
          stops = [];
          for (let s = 0; s < SEG; s++) {
            const y0 = Math.floor((chh * s) / SEG), y1 = Math.floor((chh * (s + 1)) / SEG);
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0; y < y1; y++) {
              for (let x = 0; x < cw; x += 4) {
                const i = (y * cw + x) * 4;
                r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
              }
            }
            if (n) stops.push("rgb(" + Math.round(r / n) + "," + Math.round(g / n) + "," + Math.round(b / n) + ")");
          }
        } catch (e) { stops = null; }
        if (stops && stops.length) {
          const grad = ctx.createLinearGradient(0, 0, 0, chh);
          for (let s = 0; s < stops.length; s++) grad.addColorStop(s / (stops.length - 1), stops[s]);
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, cw, chh);
        }
      }
      clearedSafeArea = true;
    }
  }

  // ================= 方案 B：品牌栏（letterbox）=================
  // 背景：模型每次都把大标题排到画面最顶部（实测无视"标题须在某百分比以下"的提示词指令），
  // 覆盖式抹平必然周期性误切标题。改为「顶部新增一条品牌栏 + 画面等比缩小下移」，
  // 结构上保证不遮任何内容，输出尺寸不变（仍为原画布尺寸）。
  let barLayout = false;
  if (body.layout === 'bar') {
    const barH = Math.max(24, Math.round(H * (Number(body.barHeightPct) || 6) / 100));
    const innerW = W, innerH = H - barH;
    const sc = Math.min(innerW / W, innerH / H);
    const dw = Math.round(W * sc), dh = Math.round(H * sc);
    const dx = Math.round((W - dw) / 2), dy = barH + Math.round((innerH - dh) / 2);
    // 用源图顶部几行平均色做整幅底色，避免留白突兀
    let baseCol = 'rgb(255,255,255)';
    try {
      const dd = ctx.getImageData(0, 0, W, Math.max(1, Math.round(H * 0.02))).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < dd.length; i += 16) { r += dd[i]; g += dd[i + 1]; b += dd[i + 2]; n++; }
      if (n) baseCol = 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')';
    } catch (e) {}
    ctx.fillStyle = baseCol;
    ctx.fillRect(0, 0, W, H);
    // 画面等比缩小后下移
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    // 必须从源图 src 重绘（不能 drawImage(canvas,...) —— 那是把 canvas 画到自己身上，
    // 而上面的底色填充已把画面盖掉，结果输出纯色块）
    ctx.drawImage(src, dx, dy, dw, dh);
    // ⚠️ 关键顺序：上面从 src 重绘会覆盖掉先前对 canvas 做的抹平，
    // 所以 bar 模式必须在「重绘之后」对内嵌区域重新抹平一次（覆盖模型自画 logo 的落点）。
    try {
      const chh2 = Math.max(2, Math.round(dh * 0.115));
      const dd2 = ctx.getImageData(dx, dy, dw, chh2).data;
      const SEG2 = 5, st2 = [];
      for (let s = 0; s < SEG2; s++) {
        const y0 = Math.floor((chh2 * s) / SEG2), y1 = Math.floor((chh2 * (s + 1)) / SEG2);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < dw; x += 4) {
            const i = (y * dw + x) * 4; r += dd2[i]; g += dd2[i + 1]; b += dd2[i + 2]; n++;
          }
        }
        if (n) st2.push('rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')');
      }
      if (st2.length) {
        const g3 = ctx.createLinearGradient(0, dy, 0, dy + chh2);
        for (let s = 0; s < st2.length; s++) g3.addColorStop(s / (st2.length - 1), st2[s]);
        ctx.fillStyle = g3;
        ctx.fillRect(dx, dy, dw, chh2);
      }
      clearedSafeArea = true;
    } catch (e) {}

    // 品牌栏渐变（采样自画面顶部 5 段的色调）
    try {
      const src = ctx.getImageData(dx, dy, dw, Math.max(1, Math.round(dh * 0.06))).data;
      const SEG = 5, stops = [];
      for (let s = 0; s < SEG; s++) {
        const x0 = Math.floor((dw * s) / SEG), x1 = Math.floor((dw * (s + 1)) / SEG);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < Math.round(dh * 0.06); y += 2) {
          for (let x = x0; x < x1; x += 3) {
            const i = (y * dw + x) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
          }
        }
        if (n) stops.push('rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')');
      }
      if (stops.length) {
        const g2 = ctx.createLinearGradient(0, 0, W, barH);
        for (let s = 0; s < stops.length; s++) g2.addColorStop(s / (stops.length - 1), stops[s]);
        ctx.fillStyle = g2; ctx.fillRect(0, 0, W, barH);
      }
    } catch (e) {}
    barLayout = true;
  }

  const lw = (W * Number(logo.widthPct)) / 100;
  const s = lw / ZERNO_GEOM.naturalW;
  const lx = logo.anchor === "top-center" ? (W - lw) / 2 : (Number(logo.xPct || 0) / 100) * W;
  const ly = (H * Number(logo.yPct)) / 100;

  // 背景自适应配色：采样 LOGO 区域平均亮度决定用白还是深色，避免浅底白字看不清
  let drawColor = logo.color;
  let sampledLum = null;
  if (!drawColor || drawColor === "auto") {
    const boxW = Math.max(1, Math.round(lw));
    const boxH = Math.max(1, Math.round((ZERNO_GEOM.textDy + ZERNO_GEOM.textH) * s));
    const bx = Math.max(0, Math.min(W - boxW, Math.round(lx)));
    const by = Math.max(0, Math.min(H - boxH, Math.round(ly)));
    let lum = 0;
    try {
      const px = ctx.getImageData(bx, by, boxW, boxH).data;
      let n = 0, sum = 0;
      for (let i = 0; i < px.length; i += 4) { sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; }
      lum = n ? sum / n / 255 : 0;
    } catch (e) { lum = 0; }
    drawColor = lum > 0.62 ? "#111111" : "#FFFFFF";
    sampledLum = Math.round(lum * 1000) / 1000;
  }

  ctx.save();
  ctx.fillStyle = drawColor;
  ctx.beginPath();
  ZERNO_GEOM.pts.forEach(([px, py], i) => {
    const X = lx + px * s, Y = ly + py * s;
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.font = Math.round(ZERNO_GEOM.textH * s) + 'px "ZernoDisplay", sans-serif';
  ctx.textBaseline = "top";
  ctx.fillText("ZERNO", lx + (ZERNO_GEOM.boltW + ZERNO_GEOM.gap) * s, ly + ZERNO_GEOM.textDy * s);
  ctx.restore();

  const jpg = await canvas.encode("jpeg", 92);   // @napi-rs/canvas 的 encode() 返回 Promise，必须 await
  const outDir = path.join(OUTPUT_ROOT, safeName(String(body.taskId || ("logo_" + Date.now()))));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, safeName(String(body.shotCode || "shot")) + "-logo.jpg");
  fs.writeFileSync(outPath, jpg);
  // C5 管线用：需要把合成结果作为字节回传（下游要 binary），并按「稳/结果保留」原则容错
  const resp = {
    ok: true, status: "done",
    srcWidth: W, srcHeight: H,
    logoWidthPx: Math.round(lw), logoX: Math.round(lx), logoY: Math.round(ly),
    logoWidthPct: Number(logo.widthPct), logoYPct: Number(logo.yPct),
    logoScale: Math.round(s * 1000) / 1000,
    clearedSafeArea: clearedSafeArea, safeAreaMode: safeAreaMode, layout: barLayout ? 'bar' : 'overlay',
    safeAreaHeightPct: safeAreaHeightPct,
    logoColor: drawColor, bgLuminance: sampledLum,
    boltWidthPx: Math.round(ZERNO_GEOM.boltW * s), gapPx: Math.round(ZERNO_GEOM.gap * s),
    path: outPath, bytes: jpg.length,
  };
  if (body.returnBase64 === true) resp.imageBase64 = "data:image/jpeg;base64," + jpg.toString("base64");
  return resp;
}

// ---- 路由 ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // 鉴权：所有 /v1/* 走 X-Compose-Key（内网共享密钥，见 C4 §3）
  if (url.pathname.startsWith("/v1/")) {
    if (!timingSafeEqual(req.headers["x-compose-key"], COMPOSE_KEY)) {
      return json(res, 401, { ok: false, status: "failed", error: { code: "UNAUTHORIZED", message: "missing/invalid X-Compose-Key", httpStatus: 401, retryable: false } });
    }
  }

  if (req.method === "GET" && url.pathname === "/v1/health") {
    return json(res, 200, {
      ok: true,
      status: "healthy",
      version: "0.1.0",
      fonts: {
        profile: "ozon-cyrillic-v1",
        loaded: require(path.join(__dirname, "..", "03-合版引擎-spike", "lib", "fonts")).REGISTRY.length,
        cyrillicCoverage: "66/66 Montserrat/Golos/Oswald/Manrope; Bebas digits-only",
      },
      templates: Object.keys(TEMPLATE_REGISTRY).length,
      uptimeSec: Math.floor(process.uptime()),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/templates") {
    return json(res, 200, {
      ok: true,
      templates: Object.keys(TEMPLATE_REGISTRY).map((id) => ({
        specId: id,
        width: TEMPLATE_REGISTRY[id].template.width,
        colors: TEMPLATE_REGISTRY[id].template.colors,
      })),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/compose") {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (e) {
      return json(res, 400, { ok: false, status: "failed", error: { code: "BAD_REQUEST", message: "invalid json body: " + e.message, httpStatus: 400, retryable: false } });
    }

    // 参数校验（C4 §2.1 必填）
    if (!body.specId && !body.spec) {
      return json(res, 400, { ok: false, status: "failed", error: { code: "BAD_REQUEST", message: "specId or spec required", httpStatus: 400, retryable: false } });
    }
    if (!body.idempotencyKey && !body.taskId) {
      // 幂等键可选但推荐；无 key 时按 taskId 做近似幂等
    }

    /* ★ 2026-10-06（审查 E3）：原来无 idempotencyKey 时 key = "k_" + taskId ——
       同一个 taskId 改了 payload 再发（比如改文案/换图），10 分钟内会**返回旧缓存产物**且标 succeeded（假成功）。
       现在把请求体哈希并进 key：同 taskId 改内容 → 不同 key → 重渲染；
       同 taskId 同内容（真正的重试）→ 同 key → 命中缓存，幂等语义保留。 */
    const _bodyHash = crypto.createHash("sha1").update(JSON.stringify(body || {})).digest("hex").slice(0, 16);
    const key = body.idempotencyKey || ("k_" + (body.taskId || crypto.randomBytes(8).toString("hex")) + "_" + _bodyHash);
    const now = Date.now();
    const cached = idempotencyCache.get(key);
    if (cached && now - cached.at < 10 * 60 * 1000) {
      return json(res, 200, cached.response);
    }
    if (inFlight.has(key)) {
      try {
        const r = await inFlight.get(key);
        return json(res, 200, r);
      } catch (e) {
        // fallthrough to re-render
      }
    }

    const p = scheduleCompose(body);
    inFlight.set(key, p);
    try {
      const result = await p;
      idempotencyCache.set(key, { at: Date.now(), response: result });
      return json(res, 200, result);
    } catch (e) {
      // C4 §4.4 错误码映射
      const KNOWN = { TEMPLATE_NOT_FOUND: 404, COPY_INVALID: 422, BAD_REQUEST: 400, SPEC_INVALID: 400 };
      const code = KNOWN[e.code] ? e.code : "RENDER_ERROR";
      const httpStatus = e.httpStatus || KNOWN[code] || 500;
      const retryable = code === "RENDER_ERROR";
      return json(res, httpStatus, { ok: false, status: "failed", error: { code, message: String(e.message || e), httpStatus, retryable } });
    } finally {
      inFlight.delete(key);
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/logo-overlay") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { ok: false, status: "failed", error: { code: "BAD_REQUEST", message: "invalid json body: " + e.message, httpStatus: 400, retryable: false } });
    }
    try {
      const r = await scheduleRender(() => logoOverlay(body));
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { ok: false, status: "failed", error: { code: "LOGO_OVERLAY_ERROR", message: String((e && e.message) || e), httpStatus: 500, retryable: true } });
    }
  }

  // 最终文件检查：真实下载/解码/指纹，不按调用方声明推导尺寸。
  if (req.method === 'POST' && url.pathname === '/v1/inspect-image') {
    try {
      const body = JSON.parse(await readBody(req, 15 * 1024 * 1024));
      const result = await require('./image-inspection').inspectImage(body, {requireCanvas});
      return json(res, 200, result);
    } catch (e) {
      return json(res, 422, {ok:false,decodable:false,error:{code:'IMAGE_INVALID',message:String(e.message || e)}});
    }
  }

  // ---- M2：渲染层端点（把数据确定性叠到「零文字」背景图上）----
  if (req.method === "POST" && url.pathname === "/v1/render-shot") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { ok: false, status: "failed", error: { code: "BAD_REQUEST", message: "invalid json body: " + e.message, httpStatus: 400, retryable: false } });
    }
    try {
      const r = await scheduleRender(() => renderLayer().renderShot(body, {
        requireCanvas: requireCanvas,
        fetchBuffer: require('./image-inspection').readImage,
        outputRoot: function () { return OUTPUT_ROOT; },
        safeName: safeName,
      }));
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { ok: false, status: "failed", error: { code: "RENDER_SHOT_ERROR", message: String((e && e.message) || e), httpStatus: 500, retryable: true } });
    }
  }

  if (url.pathname === "/") {
    return json(res, 200, { ok: true, service: "p30-compose-engine", version: "0.2.0", endpoints: ["POST /v1/compose", "POST /v1/logo-overlay", "POST /v1/render-shot", "GET /v1/health", "GET /v1/templates"] });
  }

  return json(res, 404, { ok: false, status: "failed", error: { code: "NOT_FOUND", message: "no route " + url.pathname, httpStatus: 404, retryable: false } });
});

if (!fs.existsSync(OUTPUT_ROOT)) fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log("[compose-engine] listening on " + HOST + ":" + PORT);
  console.log("[compose-engine] templates: " + Object.keys(TEMPLATE_REGISTRY).join(", "));
  console.log("[compose-engine] output root: " + OUTPUT_ROOT);
});

// 长驻服务器健壮性：无 tty / stdin 被关闭（Docker、后台进程、CI）时，
// node 主进程默认会随 stdin EOF 退出。显式保持 stdin，避免服务被意外终止。
try {
  process.stdin.resume();
} catch (e) {
  // stdin 不可用（某些容器）时忽略，不阻塞启动
}
