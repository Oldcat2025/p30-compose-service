'use strict';
const https = require('https');
const crypto = require('crypto');
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['catait-images-photo-factory.oss-cn-hangzhou.aliyuncs.com',
  'catait-images-us-west-1.oss-us-west-1.aliyuncs.com',   // ★ 2026-10-08：07 迁美西后的新桶
  'ozon.zeabur.app']);
/* ★ 2026-10-08（同一类 bug 的第三处）：桶迁美西后白名单没跟着改 → 新桶的图一律拒收。
   加后缀兜底（任何 *.aliyuncs.com）+ *.alicdn.com，下次迁桶不会再炸；其余约束不变。 */
function hostAllowed(host) {
  return ALLOWED_HOSTS.has(host) || host.endsWith('.aliyuncs.com') || host.endsWith('.alicdn.com');
}
function readImage(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return Promise.reject(new Error('invalid image URL')); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !hostAllowed(u.hostname))
    return Promise.reject(new Error('image host is not allowed'));
  return new Promise((resolve, reject) => {
    const req = https.get(u, {timeout: 20000,headers:{Referer:'https://detail.1688.com/','User-Agent':'Mozilla/5.0'}}, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('image HTTP ' + res.statusCode)); }
      let bytes=0;const chunks=[];
      res.on('data', c => { bytes+=c.length;if(bytes>MAX_BYTES){res.destroy(new Error('image exceeds 10 MB'));return;}chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout',()=>req.destroy(new Error('image fetch timeout')));
    req.on('error',reject);
  });
}
async function inspectImage(body, deps) {
  const buf = body.imageBase64 ? Buffer.from(String(body.imageBase64).replace(/^data:[^,]+,/,''),'base64') : await readImage(body.url);
  if (!buf.length || buf.length>MAX_BYTES) throw new Error('empty or oversized image');
  const png = buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = buf[0]===255 && buf[1]===216 && buf[buf.length-2]===255 && buf[buf.length-1]===217;
  if (!png && !jpeg) throw new Error('unsupported or truncated image file');
  const cv=deps.requireCanvas(), image=await cv.loadImage(buf);
  if (!image.width || !image.height || image.width>7680 || image.height>7680) throw new Error('invalid image dimensions');
  // Drawing forces raster decode before any PASS can be returned.
  const canvas=cv.createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);
  const small=cv.createCanvas(120,120),ctx=small.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,120,120);ctx.drawImage(image,0,0,120,120);
  const pixels=ctx.getImageData(0,0,120,120).data;let border=0,white=0,foreground=0;
  for(let y=0;y<120;y++)for(let x=0;x<120;x++){
    const i=(y*120+x)*4,min=Math.min(pixels[i],pixels[i+1],pixels[i+2]),max=Math.max(pixels[i],pixels[i+1],pixels[i+2]);
    const near=min>=238&&max-min<=12;
    if(!near)foreground++;
    if(x<5||y<5||x>=115||y>=115){border++;if(near)white++;}
  }
  const whiteBackground={borderWhiteRatio:white/border,foregroundRatio:foreground/14400};
  whiteBackground.pass=whiteBackground.borderWhiteRatio>=.96&&whiteBackground.foregroundRatio>=.015&&whiteBackground.foregroundRatio<=.85;
  return {ok:true,decodable:true,width:image.width,height:image.height,bytes:buf.length,
    whiteBackground,
    format:png?'image/png':'image/jpeg',ext:png?'.png':'.jpg',
    contentSha256:crypto.createHash('sha256').update(buf).digest('hex')};
}

/* ★ 2026-10-11（老猫看图反馈：D2 有个细节框落在空白处、和标签对不上）：
   从白底图里**量出产品在画面的实际范围**，再按 N 格切分 —— 零成本、确定性、不调模型。
   与 /v1/inspect-image 同口径判"近白=背景"。返回归一化矩形（0-1），顺序=从上到下、从左到右。 */
async function locateCrops(body, deps) {
  const buf = body.imageBase64 ? Buffer.from(String(body.imageBase64).replace(/^data:[^,]+,/, ''), 'base64') : await readImage(body.url);
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('empty or oversized image');
  const cv = deps.requireCanvas(), image = await cv.loadImage(buf);
  if (!image.width || !image.height || image.width > 7680 || image.height > 7680) throw new Error('invalid image dimensions');
  const N = 120;
  const small = cv.createCanvas(N, N), ctx = small.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, N, N); ctx.drawImage(image, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  let x0 = N, y0 = N, x1 = -1, y1 = -1, fg = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4, mn = Math.min(px[i], px[i + 1], px[i + 2]), mx = Math.max(px[i], px[i + 1], px[i + 2]);
    if (!(mn >= 238 && mx - mn <= 12)) { fg++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || fg < N * N * 0.01) throw new Error('没量到产品（画面几乎全白）—— 请先确认白底图');
  const m = 0.5 / N;
  const bx = Math.max(0, x0 / N - m), by = Math.max(0, y0 / N - m);
  const bw = Math.min(1, (x1 + 1) / N + m) - bx, bh = Math.min(1, (y1 + 1) / N + m) - by;
  const count = Math.max(2, Math.min(4, parseInt(body.count, 10) || 3));
  const rects = [];
  if (count === 3) {                                  /* 上·中 / 中·左 / 下·中右 —— 与老猫定的默认布局同源，但贴着主体 */
    rects.push({x: bx + bw * 0.18, y: by, w: bw * 0.64, h: bh * 0.42});
    rects.push({x: bx, y: by + bh * 0.38, w: bw * 0.52, h: bh * 0.44});
    rects.push({x: bx + bw * 0.40, y: by + bh * 0.58, w: bw * 0.60, h: bh * 0.42});
  } else if (count === 2) {
    rects.push({x: bx, y: by, w: bw * 0.5, h: bh});
    rects.push({x: bx + bw * 0.5, y: by, w: bw * 0.5, h: bh});
  } else {
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++)
      rects.push({x: bx + bw * (c * 0.5), y: by + bh * (r * 0.5), w: bw * 0.5, h: bh * 0.5});
  }
  const clamp = (r) => {
    const x = Math.max(0, Math.min(0.999, r.x)), y = Math.max(0, Math.min(0.999, r.y));
    return {x: +x.toFixed(4), y: +y.toFixed(4), w: +Math.min(1 - x, r.w).toFixed(4), h: +Math.min(1 - y, r.h).toFixed(4)};
  };
  return {ok: true, count, bbox: {x: +bx.toFixed(4), y: +by.toFixed(4), w: +bw.toFixed(4), h: +bh.toFixed(4)},
    foregroundRatio: +(fg / (N * N)).toFixed(4), crops: rects.map(clamp), width: image.width, height: image.height};
}

module.exports={inspectImage,readImage,locateCrops};

