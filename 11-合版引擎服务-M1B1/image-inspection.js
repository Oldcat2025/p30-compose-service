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
module.exports={inspectImage,readImage};
