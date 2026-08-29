// Generate a self-contained interactive waveform viewer (one .html file, no
// network deps) from grouped FLA capture data. Debugger-grade: canvas render of
// ALL samples, wheel-zoom + drag-pan, bus rows (hex/dec/bin) collapsible to
// individual bits, a time ruler, and a cursor readout panel. Opens in a browser.

// payload: { title, meta:{...}, groups:[{name,width,bitNames,values}], scalars:[{name,values}] }
export function renderViewerHtml(payload) {
  // Safe JSON-in-<script> embedding: JSON is valid JS, only < (for </script>)
  // and the U+2028/2029 line separators need escaping.
  const data = JSON.stringify(payload).split("<").join("\\u003c");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(payload.title || "FLA capture")}</title>
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9}
header{padding:10px 14px;border-bottom:1px solid #21262d;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
header h1{font-size:14px;font-weight:600;margin:0;color:#e6edf3}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:3px 8px;font-size:12px;color:#8b949e}
.chip b{color:#e6edf3;font-weight:600}
.tools{margin-left:auto;display:flex;gap:6px;align-items:center}
button,select{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:5px 9px;font-size:12px;cursor:pointer}
button:hover{background:#30363d}
select{cursor:pointer}
#wrap{position:relative}
canvas{display:block;width:100%;cursor:crosshair}
#readout{position:absolute;top:8px;right:8px;background:rgba(13,17,23,.92);border:1px solid #30363d;border-radius:8px;padding:8px 10px;font-size:12px;min-width:150px;pointer-events:none;opacity:0;transition:opacity .1s}
#readout .s{color:#8b949e;margin-bottom:4px}
#readout .r{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
#readout .r b{color:#58a6ff}
#hint{padding:6px 14px;font-size:11px;color:#6e7681;border-top:1px solid #21262d}
@media (prefers-color-scheme: light){body{background:#fff;color:#1f2328}header,#hint{border-color:#d0d7de}.chip{background:#f6f8fa;border-color:#d0d7de;color:#57606a}.chip b{color:#1f2328}button,select{background:#f6f8fa;color:#1f2328;border-color:#d0d7de}button:hover{background:#eaeef2}#readout{background:rgba(255,255,255,.95);border-color:#d0d7de}}
</style></head>
<body>
<header>
  <h1>${escapeHtml(payload.title || "FLA capture")}</h1>
  <div class="chips" id="chips"></div>
  <div class="tools">
    <span style="font-size:12px;color:#8b949e">radix</span>
    <select id="radix"><option value="16">hex</option><option value="10">dec</option><option value="2">bin</option></select>
    <button id="zout" title="zoom out">−</button>
    <button id="zfit" title="fit all">fit</button>
    <button id="zin" title="zoom in">+</button>
  </div>
</header>
<div id="wrap"><canvas id="cv"></canvas><div id="readout"></div></div>
<div id="hint">scroll = zoom · drag = pan · click a bus name to expand its bits</div>
<script>const DATA = ${data};</script>
<script>${VIEWER_JS}</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Plain (non-interpolated) viewer script. Reads global DATA, renders + interacts.
const VIEWER_JS = String.raw`
(function(){
  var cv=document.getElementById('cv'), ctx=cv.getContext('2d');
  var LABELW=170, RULER=24, BUSH=34, BITH=20, PAD=8;
  var groups=DATA.groups||[], scalars=DATA.scalars||[];
  var N=DATA.meta&&DATA.meta.nSamples || (groups[0]?groups[0].values.length:(scalars[0]?scalars[0].values.length:0));
  var expanded={}; var radix=16;
  var pxPerSample=1, viewStart=0; var dragging=false, dragX=0, dragStart=0;
  // chips
  var meta=DATA.meta||{}; var chips=document.getElementById('chips'); var chipDefs=[['samples',N],['channels',meta.channelCount],['clock',meta.clock],['trigger',meta.trigger]];
  chipDefs.forEach(function(c){ if(c[1]==null)return; var d=document.createElement('span'); d.className='chip'; d.innerHTML=c[0]+' <b>'+c[1]+'</b>'; chips.appendChild(d); });

  function rows(){ var r=[]; groups.forEach(function(g,gi){ r.push({type:'bus',g:g,gi:gi,h:BUSH}); if(expanded[gi]){ for(var b=g.width-1;b>=0;b--) r.push({type:'bit',g:g,bit:b,h:BITH}); } }); scalars.forEach(function(s){ r.push({type:'scalar',s:s,h:BITH}); }); return r; }
  function totalH(){ return RULER + rows().reduce(function(a,r){return a+r.h;},0) + PAD; }

  function fit(){ var w=cv.clientWidth-LABELW-PAD; pxPerSample=Math.max(0.02, w/Math.max(1,N)); viewStart=0; }
  function fmt(v,w){ if(radix===16)return '0x'+(v>>>0).toString(16); if(radix===2)return (v>>>0).toString(2).padStart(w,'0'); return ''+v; }

  function resize(){ var dpr=window.devicePixelRatio||1; var w=cv.clientWidth, h=totalH(); cv.style.height=h+'px'; cv.width=w*dpr; cv.height=h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); draw(); }

  function css(n){ return getComputedStyle(document.body).getPropertyValue(n); }
  function colors(){ var light=matchMedia('(prefers-color-scheme: light)').matches; return light?{bg:'#fff',grid:'#e1e4e8',txt:'#1f2328',mut:'#57606a',wave:'#1a7f37',bus:'#0969da',busfill:'rgba(9,105,218,.07)',cursor:'#cf222e',lbl:'#24292f'}:{bg:'#0d1117',grid:'#21262d',txt:'#e6edf3',mut:'#8b949e',wave:'#3fb950',bus:'#58a6ff',busfill:'rgba(88,166,255,.08)',cursor:'#f85149',lbl:'#c9d1d9'}; }

  function sx(s){ return LABELW + (s - viewStart)*pxPerSample; }
  function visRange(){ var w=cv.clientWidth; var a=Math.max(0,Math.floor(viewStart)-1); var b=Math.min(N, Math.ceil(viewStart + (w-LABELW)/pxPerSample)+1); return [a,b]; }

  function draw(){
    var C=colors(), w=cv.clientWidth, h=totalH();
    ctx.clearRect(0,0,w,h); ctx.fillStyle=C.bg; ctx.fillRect(0,0,w,h);
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace'; ctx.textBaseline='middle';
    var rr=visRange(), a=rr[0], b=rr[1];
    // ruler
    ctx.fillStyle=C.mut; ctx.strokeStyle=C.grid; ctx.beginPath();
    var stepS=niceStep((w-LABELW)/pxPerSample);
    for(var s=Math.ceil(viewStart/stepS)*stepS; s<b; s+=stepS){ var x=sx(s); if(x<LABELW)continue; ctx.moveTo(x,RULER-5); ctx.lineTo(x,h); ctx.fillText(''+s, x+3, RULER/2); }
    ctx.stroke();
    // rows
    var y=RULER; rows().forEach(function(r){ drawRow(r,y,a,b,C); y+=r.h; });
    // label gutter divider + bg over wave underlap
    ctx.fillStyle=C.bg; ctx.fillRect(0,0,LABELW,h);
    y=RULER; ctx.textAlign='left';
    rows().forEach(function(r){ drawLabel(r,y,C); y+=r.h; });
    ctx.strokeStyle=C.grid; ctx.beginPath(); ctx.moveTo(LABELW,0); ctx.lineTo(LABELW,h); ctx.moveTo(0,RULER); ctx.lineTo(w,RULER); ctx.stroke();
    if(cursorS!=null) drawCursor(C,h);
  }
  function niceStep(span){ var raw=span/10, pow=Math.pow(10,Math.floor(Math.log10(raw))); var m=raw/pow; var n=m<1.5?1:m<3?2:m<7?5:10; return Math.max(1,n*pow); }

  function drawLabel(r,y,C){
    ctx.fillStyle=C.lbl;
    if(r.type==='bus'){ ctx.fillText((expanded[r.gi]?'▾ ':'▸ ')+r.g.name, 8, y+r.h/2-6); ctx.fillStyle=C.mut; ctx.fillText('['+(r.g.width-1)+':0]', 8, y+r.h/2+8); }
    else if(r.type==='bit'){ ctx.fillStyle=C.mut; ctx.fillText('  '+(r.g.bitNames[r.bit]||(r.g.name+'['+r.bit+']')), 14, y+r.h/2); }
    else { ctx.fillText(r.s.name, 8, y+r.h/2); }
  }
  function drawRow(r,y,a,b,C){
    if(r.type==='bus') drawBus(r.g,y,r.h,a,b,C);
    else if(r.type==='bit') drawBit(r.g.values,r.bit,1,y,r.h,a,b,C);
    else drawBit(r.s.values,0,1,y,r.h,a,b,C);
  }
  function drawBit(values,bit,one,y,h,a,b,C){
    var hi=y+6, lo=y+h-6; ctx.strokeStyle=C.wave; ctx.lineWidth=1.5; ctx.beginPath();
    var prev=null;
    for(var s=a;s<b;s++){ var v=((values[s]>>bit)&1)?hi:lo; var x0=sx(s), x1=sx(s+1); if(x1<LABELW)continue; if(x0<LABELW)x0=LABELW; if(prev!==null&&prev!==v){ ctx.moveTo(x0,prev); ctx.lineTo(x0,v);} ctx.moveTo(x0,v); ctx.lineTo(x1,v); prev=v; }
    ctx.stroke(); ctx.lineWidth=1;
  }
  function drawBus(g,y,h,a,b,C){
    var top=y+5, bot=y+h-5, mid=(top+bot)/2; ctx.strokeStyle=C.bus; ctx.fillStyle=C.busfill; ctx.lineWidth=1.4;
    var s=a;
    while(s<b){ var v=g.values[s]; var e=s+1; while(e<b && g.values[e]===v) e++;
      var x0=Math.max(LABELW,sx(s)), x1=sx(e); if(x1<LABELW){s=e;continue;}
      ctx.beginPath(); ctx.moveTo(x0+2,top); ctx.lineTo(x1-2,top); ctx.lineTo(x1,mid); ctx.lineTo(x1-2,bot); ctx.lineTo(x0+2,bot); ctx.lineTo(x0,mid); ctx.closePath(); ctx.fill(); ctx.stroke();
      var label=fmt(v,g.width); if((x1-x0)>label.length*7+8){ ctx.fillStyle=C.bus; ctx.textAlign='center'; ctx.fillText(label,(x0+x1)/2,mid); ctx.textAlign='left'; ctx.fillStyle=C.busfill; }
      s=e;
    }
    ctx.lineWidth=1;
  }
  var cursorS=null, cursorX=0;
  function drawCursor(C,h){ var x=sx(cursorS); if(x<LABELW)return; ctx.strokeStyle=C.cursor; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x,RULER); ctx.lineTo(x,h); ctx.stroke(); }

  var ro=document.getElementById('readout');
  function updateReadout(){ if(cursorS==null||cursorS<0||cursorS>=N){ ro.style.opacity=0; return;} var html='<div class="s">sample '+cursorS+'</div>'; groups.forEach(function(g){ html+='<div class="r"><span>'+g.name+'</span><b>'+fmt(g.values[cursorS],g.width)+'</b></div>'; }); scalars.forEach(function(sc){ html+='<div class="r"><span>'+sc.name+'</span><b>'+sc.values[cursorS]+'</b></div>'; }); ro.innerHTML=html; ro.style.opacity=1; }

  cv.addEventListener('mousemove',function(e){ var r=cv.getBoundingClientRect(); var x=e.clientX-r.left; if(x<LABELW){cursorS=null;updateReadout();draw();return;} cursorS=Math.floor(viewStart+(x-LABELW)/pxPerSample); if(dragging){ var dxs=(e.clientX-dragX)/pxPerSample; viewStart=clampStart(dragStart-dxs);} updateReadout(); draw(); });
  cv.addEventListener('mouseleave',function(){cursorS=null;updateReadout();draw();});
  cv.addEventListener('mousedown',function(e){ var r=cv.getBoundingClientRect(); var x=e.clientX-r.left, yy=e.clientY-r.top; if(x<LABELW){ handleLabelClick(yy); return;} dragging=true; dragX=e.clientX; dragStart=viewStart; });
  window.addEventListener('mouseup',function(){dragging=false;});
  cv.addEventListener('wheel',function(e){ e.preventDefault(); var r=cv.getBoundingClientRect(); var x=e.clientX-r.left; if(x<LABELW)x=LABELW; var sAt=viewStart+(x-LABELW)/pxPerSample; var f=e.deltaY<0?1.2:1/1.2; pxPerSample=Math.min(40,Math.max(0.01,pxPerSample*f)); viewStart=clampStart(sAt-(x-LABELW)/pxPerSample); draw(); },{passive:false});
  function clampStart(s){ var w=cv.clientWidth-LABELW; var maxStart=Math.max(0,N-w/pxPerSample); return Math.min(maxStart,Math.max(0,s)); }
  function handleLabelClick(yy){ var y=RULER; var rs=rows(); for(var i=0;i<rs.length;i++){ if(yy>=y&&yy<y+rs[i].h){ if(rs[i].type==='bus'){ expanded[rs[i].gi]=!expanded[rs[i].gi]; resize(); } return;} y+=rs[i].h; } }

  document.getElementById('radix').addEventListener('change',function(e){ radix=+e.target.value; draw(); });
  document.getElementById('zin').onclick=function(){ pxPerSample=Math.min(40,pxPerSample*1.5); viewStart=clampStart(viewStart); draw(); };
  document.getElementById('zout').onclick=function(){ pxPerSample=Math.max(0.01,pxPerSample/1.5); viewStart=clampStart(viewStart); draw(); };
  document.getElementById('zfit').onclick=function(){ fit(); draw(); };
  window.addEventListener('resize',resize);
  fit(); resize();
})();
`;
