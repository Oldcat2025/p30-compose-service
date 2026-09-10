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
async function resolvePhotoLayers(photoLayers, workDir, warnings) {
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
      // 不致命：保留默认产品档案的该照片（占位兜底）
    }
  }
  return resolved;
}

/** 下载 URL → Buffer（超时 + 大小上限） */
function fetchUrlBuffer(url, timeoutMs = 20000, maxBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? require("https") : require("http");
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
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
    const resolved = await resolvePhotoLayers(body.photoLayers, workDir, warnings);
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
    canvas: { ratio: body.canvas && body.canvas.ratio ? body.canvas.ratio : (stage.W / stage.H < 1 ? "3:4" : "1:1"), width: stage.W, height: stage.H },
    outputs,
    warnings,
    metrics: { renderMs: Date.now() - t0, size: stats.size, texts: stats.texts, images: stats.images, overflow: stats.overflow },
  };
}

// ---- 并发调度（限制 canvas 内存峰值） ----
function scheduleCompose(body) {
  return new Promise((resolve, reject) => {
    renderQueue.push({ body, resolve, reject });
    pump();
  });
}
function pump() {
  while (activeRenders < MAX_CONCURRENT && renderQueue.length > 0) {
    const job = renderQueue.shift();
    activeRenders++;
    doCompose(job.body)
      .then((r) => job.resolve(r))
      .catch((e) => job.reject(e))
      .finally(() => {
        activeRenders--;
        pump();
      });
  }
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

    const key = body.idempotencyKey || "k_" + (body.taskId || crypto.randomBytes(8).toString("hex"));
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

  if (url.pathname === "/") {
    return json(res, 200, { ok: true, service: "p30-compose-engine", version: "0.1.0", endpoints: ["POST /v1/compose", "GET /v1/health", "GET /v1/templates"] });
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
