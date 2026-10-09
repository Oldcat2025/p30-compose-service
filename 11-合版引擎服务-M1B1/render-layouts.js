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
function bestY(c,rectH,rectX,rectW,planY){
 const sub=subjOf(c);if(!sub)return planY;
 const ov0=ovl({x:rectX,y:planY,w:rectW,h:rectH},sub);
 if(ov0<=0.02)return planY;
 const cands=[sub.y-rectH-c.H*0.02, sub.y+sub.h+c.H*0.015, Math.max(c.dy+c.dh*0.03,(c.cursorY||0))+c.H*0.01];
 let best=null;
 for(let i=0;i<cands.length;i++){const y=cands[i];
  if(!Number.isFinite(y)||y<c.H*0.02||y+rectH>c.H-c.H*0.012)continue;
  const ov=ovl({x:rectX,y:y,w:rectW,h:rectH},sub);
  if(!best||ov<best.ov-1e-9)best={y:y,ov:ov};
 }
 if(best&&best.ov<ov0-0.02)return best.y;
 return planY;
}
function nudgeBlock(c,y){return y;} // Layouts reserve fixed text regions; never move text over another text region.
function color(c){return /^#[0-9a-f]{6}$/i.test(c.kitAccent||'')?c.kitAccent:'#245842';}
function card(c,x,y,w,h,fill){h=Math.max(0,h);w=Math.max(0,w);if(!w||!h)return;c.ctx.save();c.ctx.fillStyle=fill;c.roundRect(c.ctx,x,y,w,h,c.W*.012);c.ctx.fill();c.ctx.restore();}
function label(c,text,x,y,w,h,kind,index,fill='#fff',px=c.W*.032){
 const f=fitInline(c,text,w,Math.floor(h/(px*1.2)),Math.round(px),'ZernoBodyBold');
 if(f.overflowed)c.overflow.push({element:kind+'['+index+']',reason:'文案过长；请精简文案，禁止缩字或截断'});
 c.ctx.save();c.ctx.font='700 '+f.px+'px "ZernoBodyBold",sans-serif';c.ctx.textBaseline='top';c.ctx.fillStyle=fill;
 // An overflow preview is still returned, but cannot pass QA or be released.
 f.lines.slice(0,Math.max(1,Math.floor(h/(px*1.2)))).forEach((line,i)=>c.ctx.fillText(line,x,y+i*px*1.2));
 c.ctx.restore();c.elements.push({kind,index,x,y,w,h,fontPx:f.px,text:String(text),lines:f.lines});
}
function bullets(c){return (c.d.bullets||[]).map(b=>String(typeof b==='string'?b:b.text||'').trim()).filter(Boolean);}
function drawD1(c){
 const items=bullets(c),params=(c.d.params||[]).map(p=>String(p.key||'')+' '+String(p.value||'')).filter(x=>x.trim());
 if(items.length<RULES.D1.min||items.length>RULES.D1.max)c.overflow.push({element:'D1',reason:'主图需1至3条短卖点，有真实参数时展示一个参数模块'});
 const gap=c.W*.025,left=c.contentW*.56,right=c.contentW-left-gap,rowH=c.H*.08,_rows=Math.max(items.length,params.length),_blockH=_rows*rowH,_planTop=c.H-c.pad-_blockH;
 const top=bestY(c,_blockH-c.H*.009,c.pad,c.contentW,_planTop);
 if(items.length)card(c,c.pad,top,left,items.length*rowH-c.H*.009,'rgba(55,59,63,.76)');
 items.forEach((t,i)=>{const y=top+i*rowH;label(c,t,c.pad+c.W*.018,y+c.H*.012,left-c.W*.036,rowH-c.H*.018,'heroFeature',i);});
 const x=c.pad+left+gap;
 if(params.length)card(c,x,top,right,params.length*rowH-c.H*.009,'rgba(55,59,63,.93)');
 params.forEach((t,i)=>label(c,t,x+c.W*.018,top+i*rowH+c.H*.012,right-c.W*.036,rowH-c.H*.018,'heroParam',i));
}
function drawD2(c){
 const texts=bullets(c),regions=c.d.detailCrops||[],src=c.detailSource;
 if(!src||regions.length<RULES.D2.min||regions.length>RULES.D2.max||regions.length!==texts.length){c.overflow.push({element:'detailCrops',reason:'需2至4个真实参考图局部，与细节文案逐一对应'});return;}
 const top=bodyTop(c),gap=c.W*.02,w=c.contentW*.28,rows=Math.ceil(regions.length/2),h=Math.min(c.H*.32,(c.H-c.pad-top-gap)/rows);
 c.ctx.save();c.ctx.fillStyle='#F2F5F3';c.ctx.fillRect(0,top,c.W,c.H-top);
 const centerW=c.contentW-2*w-2*gap,centerH=c.H-c.pad-top,sc=Math.min(centerW/src.width,centerH/src.height),pw=src.width*sc,ph=src.height*sc;
 c.ctx.drawImage(src,(c.W-pw)/2,top+(centerH-ph)/2,pw,ph);c.ctx.restore();
 c.elements.push({kind:'productReference',x:(c.W-pw)/2,y:top+(centerH-ph)/2,w:pw,h:ph,source:'reference_image'});
 regions.forEach((r,i)=>{
  if([r.x,r.y,r.w,r.h].some(x=>!Number.isFinite(x))||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x+r.w>1.001||r.y+r.h>1.001)throw Error('Invalid reference crop');
  const x=i%2===0?c.pad:c.W-c.pad-w,y=top+Math.floor(i/2)*(h+gap),labelH=c.H*.10,ih=h-labelH;
  card(c,x,y,w,h,'#fff');
  const sx=r.x*src.width,sy=r.y*src.height,sw=r.w*src.width,sh=r.h*src.height;
  const scale=Math.min(w/sw,ih/sh),dw=sw*scale,dh=sh*scale;
  c.ctx.drawImage(src,sx,sy,sw,sh,x+(w-dw)/2,y+(ih-dh)/2,dw,dh);
  card(c,x,y+ih,w,labelH,color(c));
  label(c,texts[i],x+c.W*.015,y+ih+c.H*.01,w-c.W*.03,labelH-c.H*.02,'detailLabel',i);
  c.elements.push({kind:'detailCrop',index:i,x,y,w,h:ih,sourceRegion:r,source:'reference_image'});
 });
}
function drawD3(c){
 const items=bullets(c);if(items.length<RULES.D3.min||items.length>RULES.D3.max)c.overflow.push({element:'sceneLabels',reason:'场景图只允许1至2条卖点'});
 const w=c.contentW*.70,h=c.H*.075,gap=c.H*.014,_planTop=c.H-c.pad-items.length*(h+gap);
 const top=bestY(c,items.length*(h+gap)-gap,c.pad,w,_planTop);
 items.forEach((t,i)=>{const y=top+i*(h+gap);card(c,c.pad,y,w,h,color(c));label(c,t,c.pad+c.W*.02,y+c.H*.015,w-c.W*.04,h-c.H*.02,'sceneLabel',i);});
}
function drawD4(c){
 const rows=c.d.comparisonFacts||[];
 if(rows.length<RULES.D4.min||rows.length>RULES.D4.max||rows.some(r=>!r.left||!r.right||!r.evidence)){c.overflow.push({element:'comparison',reason:'缺少已确认、有出处的对比事实'});return;}
 const gap=c.W*.025,lw=(c.contentW-gap)*.44,rw=(c.contentW-gap)*.56,rx=c.pad+lw+gap,tagH=c.H*.09,rowH=c.H*.10;
 const top=bestY(c,tagH+rows.length*(rowH+c.H*.008),c.pad,c.contentW,bodyTop(c));
 card(c,c.pad,top,lw,tagH,'#565b61');card(c,rx,top,rw,tagH,color(c));
 label(c,c.d.leftTag||'СРАВНЕНИЕ',c.pad+c.W*.02,top+c.H*.015,lw-c.W*.04,tagH-c.H*.02,'compareTag',0);
 label(c,c.d.rightTag||'НАША МОДЕЛЬ',rx+c.W*.02,top+c.H*.015,rw-c.W*.04,tagH-c.H*.02,'compareTag',1);
 /* ★ 2026-10-09（老猫实测 D4）：左栏 40% 宽、行高 160px、字号 0.032W 时**只能放 2 行**，
    而对比事实常需 3 行 → 引擎按上限截断（"…с насадкой для" 这种断句），C8 判 LAYOUT 溢出 —— 判得对。
    修法：① 对比表格字号降到 0.028W；② 上下内边距收紧（.016/.025 → .011/.016）；
          ③ 左右栏比例 40/60 → 44/56（长句多的一侧不再挤）—— 三条合起来每格可容 3 行。 */
 rows.forEach((r,i)=>{
 const y=top+tagH+c.H*.012+i*(rowH+c.H*.008);
 card(c,c.pad,y,lw,rowH,'rgba(248,248,248,0.96)');card(c,rx,y,rw,rowH,color(c));
 label(c,r.left,c.pad+c.W*.02,y+c.H*.011,lw-c.W*.04,rowH-c.H*.016,'compareLeft',i,'#333',c.W*.028);
 label(c,r.right,rx+c.W*.02,y+c.H*.011,rw-c.W*.04,rowH-c.H*.016,'compareRight',i,'#fff',c.W*.028);
 });
 c.elements.push({kind:'compareBox',x:c.pad,y:top,w:c.contentW,h:tagH+rows.length*(rowH+c.H*.008),leftRatio:.4,rightRatio:.6});
}
function drawD5(c){
 const items=bullets(c);if(items.length<RULES.D5.min||items.length>RULES.D5.max)c.overflow.push({element:'featureCards',reason:'总结图需3至6条已确认优势或参数'});
 const gap=c.W*.025,w=c.contentW*.45,_planTop=bodyTop(c),h=Math.min(c.H*.12,(c.H-c.pad-_planTop-(items.length-1)*gap)/Math.max(1,items.length));
 const top=bestY(c,items.length*h+(items.length-1)*gap,c.pad,w,_planTop);
 items.forEach((t,i)=>{const x=c.pad,y=top+i*(h+gap);
  card(c,x,y,w,h,color(c));label(c,t,x+c.W*.02,y+c.H*.015,w-c.W*.04,h-c.H*.02,'featureCard',i);});
}
module.exports={drawD1,drawD2,drawD3,drawD4,drawD5,fitInline,bodyTop,nudgeBlock,bestY,subjOf};
