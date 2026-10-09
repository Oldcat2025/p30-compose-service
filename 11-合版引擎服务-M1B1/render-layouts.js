'use strict';
const RULES=require('./shot-rules.json').shots;
function fitInline(c,t,maxW,maxLines,startPx,fam){
 const px=startPx,words=String(t||'').trim().split(/\s+/).filter(Boolean),lines=[];let line='',long=false;
 for(const word of words){
  if(c.measure(word,px,'700',fam)>maxW)long=true;
  const next=line?line+' '+word:word;
  if(line&&c.measure(next,px,'700',fam)>maxW){lines.push(line);line=word;}else line=next;
 }
 if(line)lines.push(line);
 return {lines,px,width:Math.max(0,...lines.map(x=>c.measure(x,px,'700',fam))),overflowed:long||lines.length>maxLines};
}
function bodyTop(c){return Math.max(c.cursorY+c.H*.022,c.dy+c.dh*.15);}
/* ★ 2026-10-09（老猫：「多次出现标签遮盖商品主要细节」）：主体避让真正落地。
   render-layer 已用边缘能量法算出主体 bbox（c.subject.bbox）—— 以前 nudgeBlock 是空实现（`return y`），
   版式一律用固定位置，主体正好在那儿时文字就压上去（实测：D1 的参数牌压住电池包；D2 标题压住刀盘特写）。
   现在：文本块在若干候选位置里挑「与主体重叠最少」的那个；本来就不重叠 → 一律不动（版式稳定）；
   有更优且明显更不压的候选才移动；都不行保留原位置（输不出更差的结果）。 */
function subjOf(c){const b=c&&c.subject&&c.subject.bbox;if(!b)return null;const x=Number(b.x),y=Number(b.y),w=Number(b.w),h=Number(b.h);if(![x,y,w,h].every(Number.isFinite)||w<=0||h<=0)return null;return {x:x,y:y,w:w,h:h};}
function ovl(a,b){if(!a||!b)return 0;const ix=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));const iy=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));return (ix*iy)/Math.max(1,Math.min(a.w*a.h,b.w*b.h));}
function bestY(c,rectH,rectX,rectW,planY,opt){
 /* ★ 2026-10-09（老猫：D1『标题文案全挤在上半部分，头重脚轻』）：
    opt.bottomOnly = 只在**画面下半部**找避让位。以前候选位里有"主体上方"，
    主体一在下半部，文字块就整块跳到顶部 → 头重脚轻、还压住标题。
    现在：文字带本来就设计在底部（50% 半透明，轻微交叠可接受），避让只在下半部微调。 */
 const bottomOnly=!!(opt&&opt.bottomOnly);
 const sub=subjOf(c);if(!sub)return planY;
 const ov0=ovl({x:rectX,y:planY,w:rectW,h:rectH},sub);
 if(ov0<=0.02)return planY;
 const cands=[sub.y-rectH-c.H*0.02, sub.y+sub.h+c.H*0.015, Math.max(c.dy+c.dh*0.03,(c.cursorY||0))+c.H*0.01];
 let best=null;
 for(let i=0;i<cands.length;i++){const y=cands[i];
  if(!Number.isFinite(y)||y<c.H*0.02||y+rectH>c.H-c.H*0.012)continue;
  if(bottomOnly&&y<c.H*0.45)continue;   // 下半部之外的候选一律不要
  const ov=ovl({x:rectX,y:y,w:rectW,h:rectH},sub);
  if(!best||ov<best.ov-1e-9)best={y:y,ov:ov};
 }
 if(best&&best.ov<ov0-0.02)return best.y;
 return planY;
}
function nudgeBlock(c,y){return y;} // Layouts reserve fixed text regions; never move text over another text region.
function color(c){return /^#[0-9a-f]{6}$/i.test(c.kitAccent||'')?c.kitAccent:'#245842';}
/* ★ 2026-10-09（老猫：「图片文案标签色块的底色透明度设定 50%，不要挡住产品主体、也不要挡住人物脸部」）：
   题注色块统一改半透明（alpha 0.5）；文字加暗色投影保证在浅色背景上仍可读。
   配合主体避让（bestY）一起用 —— 位置先避开主体，即使轻微交叠也能透出被遮内容。 */
function rgbaOf(hex,a){
 const m=/^#([0-9a-f]{6})$/i.exec(String(hex||'')); if(!m) return 'rgba(36,88,66,'+a+')';
 const n=parseInt(m[1],16); return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
}
function colorA(c,a){return rgbaOf(color(c),a);}
/* 顺序角标（① ② ③）：与 5.4「真实细节与对比依据」里框选的先后顺序一一对应，
   让运营在成品图上就能核对"第N张细节图 = 我框的第N个位置"。 */
function badge(c,text,x,y,size){
 c.ctx.save(); c.ctx.beginPath(); c.ctx.fillStyle='rgba(0,0,0,.55)';
 c.ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2); c.ctx.fill();
 c.ctx.fillStyle='#fff'; c.ctx.font='800 '+Math.round(size*.62)+'px "ZernoBodyBold",sans-serif';
 c.ctx.textAlign='center'; c.ctx.textBaseline='middle';
 c.ctx.fillText(String(text),x+size/2,y+size/2+size*.03); c.ctx.restore();
}
function card(c,x,y,w,h,fill){h=Math.max(0,h);w=Math.max(0,w);if(!w||!h)return;c.ctx.save();c.ctx.fillStyle=fill;c.roundRect(c.ctx,x,y,w,h,c.W*.012);c.ctx.fill();c.ctx.restore();}
function label(c,text,x,y,w,h,kind,index,fill='#fff',px=c.W*.032){
 const f=fitInline(c,text,w,Math.floor(h/(px*1.2)),Math.round(px),'ZernoBodyBold');
 if(f.overflowed)c.overflow.push({element:kind+'['+index+']',reason:'文案过长；请精简文案，禁止缩字或截断'});
 c.ctx.font='700 '+f.px+'px "ZernoBodyBold",sans-serif';c.ctx.textBaseline='top';c.ctx.fillStyle=fill;
 c.ctx.shadowColor='rgba(0,0,0,.5)';c.ctx.shadowBlur=Math.round(c.W*.006);
 // An overflow preview is still returned, but cannot pass QA or be released.
 f.lines.slice(0,Math.max(1,Math.floor(h/(px*1.2)))).forEach((line,i)=>c.ctx.fillText(line,x,y+i*px*1.2));
 c.ctx.restore();c.elements.push({kind,index,x,y,w,h,fontPx:f.px,text:String(text),lines:f.lines});
}
function bullets(c){return (c.d.bullets||[]).map(b=>String(typeof b==='string'?b:b.text||'').trim()).filter(Boolean);}
function drawD1(c){
 const items=bullets(c),params=(c.d.params||[]).map(p=>String(p.key||'')+' '+String(p.value||'')).filter(x=>x.trim());
 if(items.length<RULES.D1.min||items.length>RULES.D1.max)c.overflow.push({element:'D1',reason:'主图需1至3条短卖点，有真实参数时展示一个参数模块'});
 const gap=c.W*.025,left=c.contentW*.56,right=c.contentW-left-gap,rowH=c.H*.08,_rows=Math.max(items.length,params.length),_blockH=_rows*rowH,_planTop=c.H-c.pad-_blockH;
 const top=bestY(c,_blockH-c.H*.009,c.pad,c.contentW,_planTop,{bottomOnly:true});
 if(items.length)card(c,c.pad,top,left,items.length*rowH-c.H*.009,'rgba(55,59,63,.5)');
 items.forEach((t,i)=>{const y=top+i*rowH;label(c,t,c.pad+c.W*.018,y+c.H*.012,left-c.W*.036,rowH-c.H*.018,'heroFeature',i);});
 const x=c.pad+left+gap;
 if(params.length)card(c,x,top,right,params.length*rowH-c.H*.009,'rgba(55,59,63,.5)');
 params.forEach((t,i)=>label(c,t,x+c.W*.018,top+i*rowH+c.H*.012,right-c.W*.036,rowH-c.H*.018,'heroParam',i));
}
function drawD2(c){
 const texts=bullets(c),regions=c.d.detailCrops||[],src=c.detailSource;
 if(!src||regions.length<RULES.D2.min||regions.length>RULES.D2.max||regions.length!==texts.length){c.overflow.push({element:'detailCrops',reason:'需2至4个真实参考图局部，与细节文案逐一对应'});return;}
 /* ★ 2026-10-09 第二轮（老猫逐图反馈）：
    ① 「中间3个细节图不要有多余的白色部分」→ 图片**铺满格子**（按比例放大居中裁切），不再白底留边；
    ② 「文案部分的底色也要透明度50%」→ 题注带 50% 半透明，直接压在图片下沿（不再另占白条）；
    ③ 「按照细节在主体的相应位置放置细节图，而不是并排堆在中间」→ 摆放顺序**跟随细节在参考图上的方位**
       （上→上排、左→左列）；编号 ①②③ 仍等于框选先后顺序（= D2 短句顺序），不随位置变化；
    ④ 网格仍在可用高度里垂直居中（避免下方一片死白）。 */
 const top=bodyTop(c),gap=c.W*.02,cols=regions.length===3?3:2;
 const w=(c.contentW-gap*(cols-1))/cols,rows=Math.ceil(regions.length/cols);
 const h=Math.max(c.H*.16,Math.min(c.H*.44,(c.H-c.pad-top-gap*Math.max(0,rows-1))/rows));
 const gridH=rows*h+(rows-1)*gap,y0=top+Math.max(0,(c.H-c.pad-top-gridH)/2);
 c.ctx.save();c.ctx.fillStyle='rgba(242,245,243,.5)';c.ctx.fillRect(0,top,c.W,c.H-top);c.ctx.restore();
 const order=regions.map(function(r,i){return i;}).sort(function(a,b){
   const ra=regions[a],rb=regions[b];
   if(!ra||!rb)return a-b;
   const bandA=(Number(ra.y)+Number(ra.h)/2)<0.5?0:1,bandB=(Number(rb.y)+Number(rb.h)/2)<0.5?0:1;
   return bandA-bandB||(Number(ra.x)-Number(rb.x))||(a-b);
 });
 order.forEach(function(ri,cell){
  const r=regions[ri];
  if([r.x,r.y,r.w,r.h].some(x=>!Number.isFinite(x))||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x+r.w>1.001||r.y+r.h>1.001)throw Error('Invalid reference crop');
  const x=c.pad+(cell%cols)*(w+gap),y=y0+Math.floor(cell/cols)*(h+gap);
  const sx=r.x*src.width,sy=r.y*src.height,sw=r.w*src.width,sh=r.h*src.height;
  const scale=Math.max(w/sw,h/sh),dw=sw*scale,dh=sh*scale;
  c.ctx.save();c.roundRect(c.ctx,x,y,w,h,c.W*.014);c.ctx.clip();
  c.ctx.drawImage(src,sx,sy,sw,sh,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
  c.ctx.restore();
  const labelH=Math.max(c.H*.072,h*.28);
  card(c,x,y+h-labelH,w,labelH,colorA(c,.5));
  label(c,texts[ri],x+c.W*.016,y+h-labelH+c.H*.008,w-c.W*.032,labelH-c.H*.016,'detailLabel',ri);
  badge(c,String(ri+1),x+c.W*.012,y+c.W*.012,c.W*.048);
  c.elements.push({kind:'detailCrop',index:ri,order:ri+1,cell:cell,x:x,y:y,w:w,h:h,sourceRegion:r,source:'reference_image'});
 });
}
function drawD3(c){
 const items=bullets(c);if(items.length<RULES.D3.min||items.length>RULES.D3.max)c.overflow.push({element:'sceneLabels',reason:'场景图只允许1至2条卖点'});
 const h=c.H*.075,gap=c.H*.014,_planTop=c.H-c.pad-items.length*(h+gap);
 /* ★ 2026-10-09（老猫：D3「文案的底宽长度没办法根据文案长度自动调节，导致很多文案方框空白，并遮盖产品主体」）：
    色块宽度**跟着文案长度走**（原来固定 contentW*.70 → 短句留一大片空壳）。
    量宽用与绘制同一字号/字重；设下限 42% 保证视觉不碎，上限 contentW 防止压主体太多。 */
 const px=Math.round(c.W*.032);
 const widths=items.map(function(t){return Math.min(c.contentW,Math.max(c.contentW*.42,c.measure(t,px,'700','ZernoBodyBold')+c.W*.045));});
 const blockH=items.length*(h+gap)-gap,maxW=Math.max.apply(null,widths.concat([c.contentW*.42]));
 const top=bestY(c,blockH,c.pad,maxW,_planTop,{bottomOnly:true});
 items.forEach(function(t,i){const y=top+i*(h+gap),w=widths[i];card(c,c.pad,y,w,h,colorA(c,.5));label(c,t,c.pad+c.W*.02,y+c.H*.015,w-c.W*.04,h-c.H*.02,'sceneLabel',i);});
}
function drawD4(c){
 const rows=c.d.comparisonFacts||[];
 if(rows.length<RULES.D4.min||rows.length>RULES.D4.max||rows.some(r=>!r.left||!r.right||!r.evidence)){c.overflow.push({element:'comparison',reason:'缺少已确认、有出处的对比事实'});return;}
 const gap=c.W*.025,lw=(c.contentW-gap)*.44,rw=(c.contentW-gap)*.56,rx=c.pad+lw+gap,tagH=c.H*.09,rowH=c.H*.10;
 const top=bestY(c,tagH+rows.length*(rowH+c.H*.008),c.pad,c.contentW,bodyTop(c));
 card(c,c.pad,top,lw,tagH,'rgba(86,91,97,.5)');card(c,rx,top,rw,tagH,colorA(c,.5));
 label(c,c.d.leftTag||'СРАВНЕНИЕ',c.pad+c.W*.02,top+c.H*.015,lw-c.W*.04,tagH-c.H*.02,'compareTag',0);
 label(c,c.d.rightTag||'НАША МОДЕЛЬ',rx+c.W*.02,top+c.H*.015,rw-c.W*.04,tagH-c.H*.02,'compareTag',1);
 /* ★ 2026-10-09（老猫实测 D4）：左栏 40% 宽、行高 160px、字号 0.032W 时**只能放 2 行**，
    而对比事实常需 3 行 → 引擎按上限截断（"…с насадкой для" 这种断句），C8 判 LAYOUT 溢出 —— 判得对。
    修法：① 对比表格字号降到 0.028W；② 上下内边距收紧（.016/.025 → .011/.016）；
          ③ 左右栏比例 40/60 → 44/56（长句多的一侧不再挤）—— 三条合起来每格可容 3 行。 */
 rows.forEach((r,i)=>{
 const y=top+tagH+c.H*.012+i*(rowH+c.H*.008);
 card(c,c.pad,y,lw,rowH,'rgba(248,248,248,.5)');card(c,rx,y,rw,rowH,colorA(c,.5));
 label(c,r.left,c.pad+c.W*.02,y+c.H*.011,lw-c.W*.04,rowH-c.H*.016,'compareLeft',i,'#333',c.W*.028);
 label(c,r.right,rx+c.W*.02,y+c.H*.011,rw-c.W*.04,rowH-c.H*.016,'compareRight',i,'#fff',c.W*.028);
 });
 c.elements.push({kind:'compareBox',x:c.pad,y:top,w:c.contentW,h:tagH+rows.length*(rowH+c.H*.008),leftRatio:.4,rightRatio:.6});
}
function drawD5(c){
 const items=bullets(c);if(items.length<RULES.D5.min||items.length>RULES.D5.max)c.overflow.push({element:'featureCards',reason:'总结图需3至6条已确认优势或参数'});
 const gap=c.W*.025,w=c.contentW*.45,_planTop=bodyTop(c),h=Math.min(c.H*.12,(c.H-c.pad-_planTop-(items.length-1)*gap)/Math.max(1,items.length));
 const top=bestY(c,items.length*h+(items.length-1)*gap,c.pad,w,_planTop,{bottomOnly:true});
 items.forEach((t,i)=>{const x=c.pad,y=top+i*(h+gap);
  card(c,x,y,w,h,colorA(c,.5));label(c,t,x+c.W*.02,y+c.H*.015,w-c.W*.04,h-c.H*.02,'featureCard',i);});
}
module.exports={drawD1,drawD2,drawD3,drawD4,drawD5,fitInline,bodyTop,nudgeBlock,bestY,subjOf};
