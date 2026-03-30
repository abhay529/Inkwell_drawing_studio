(() => {
"use strict";

/* ======================================================
   INKWELL — script.js
   Figma-like pen: click=corner, drag=bezier handle,
   Ctrl+drag=adjust handle, Ctrl+Z=undo last anchor
   ====================================================== */

const dpr = window.devicePixelRatio || 1;
/* CANVAS_SCALE: internal canvas is this many times denser than the screen.
   At CSS zoom=CANVAS_SCALE the drawing is pixel-perfect (1:1 source:screen).
   Higher = better zoom quality, more memory. 3 is a good balance. */
const CANVAS_SCALE = 3;
const CANVAS_DPR   = dpr * CANVAS_SCALE;  // total scale factor applied to ctx
const VW  = () => window.innerWidth;
const VH  = () => window.innerHeight;

/* ── DOM ── */
const viewport     = document.getElementById("viewport");
const canvasStack   = document.getElementById("canvasStack");
const preview       = document.getElementById("previewCanvas");
const pCtx          = preview.getContext("2d");
const zoomBadge     = document.getElementById("zoomBadge");
const imageInput    = document.getElementById("imageInput");
const dropZone      = document.getElementById("dropZone");
const layersList    = document.getElementById("layersList");
const undoBtn       = document.getElementById("undoBtn");
const redoBtn       = document.getElementById("redoBtn");
const clearBtn      = document.getElementById("clearBtn");
const brushSzSldr   = document.getElementById("brushSize");
const brushDot      = document.getElementById("brushDot");
const brushLbl      = document.getElementById("brushLabel");
const brushToolBtn  = document.getElementById("brushTool");
const brushSubPanel = document.getElementById("brushSubPanel");
const penBtn        = document.getElementById("penTool");
const bucketBtn     = document.getElementById("bucketTool");
const eraserBtn     = document.getElementById("eraserTool");
const importBtn     = document.getElementById("importBtn");
const exportPng     = document.getElementById("exportPng");
const exportSvg     = document.getElementById("exportSvg");
const toastEl       = document.getElementById("toast");
const penHint       = document.getElementById("penHint");
const colorPalette  = document.getElementById("colorPalette");
const colorPicker   = document.getElementById("colorPicker");

/* ── Global state ── */
let tool       = "brush";
let brushStyle = "round";
let brushSize  = 8;
let color      = "#FFFFFF";
let drawing    = false;
let lastX = 0, lastY = 0;
let mouseX = 0, mouseY = 0;   // canvas-space
let rawMouseX = 0, rawMouseY = 0; // screen-space (for cursor element)
let ctrlHeld   = false;
let spaceHeld  = false;

/* ──────────────────────────────────────
   ZOOM / PAN STATE
────────────────────────────────────── */
let zoom   = 1;
let panX   = 0;
let panY   = 0;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

/** Convert screen (clientX/Y) → canvas coordinates */
function screenToCanvas(sx, sy) {
  return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
}

/** Apply the current zoom/pan as a CSS transform on the viewport */
function applyTransform() {
  viewport.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  const pct = Math.round(zoom * 100);
  zoomBadge.textContent = pct + "%";
  zoomBadge.classList.toggle("zoomed", zoom !== 1);
}

/** Zoom centred on a screen point (sx, sy) */
function zoomAt(sx, sy, factor) {
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
  panX = sx - (sx - panX) * (newZoom / zoom);
  panY = sy - (sy - panY) * (newZoom / zoom);
  zoom = newZoom;
  applyTransform();
}

/** Reset view */
function resetView() { zoom=1; panX=0; panY=0; applyTransform(); showToast("View reset"); }

/* ── Pan with Space+drag or middle-mouse ── */
let panning = false, panStart = {x:0,y:0}, panOrigin = {x:0,y:0};

function startPan(sx, sy) { panning=true; panStart={x:sx,y:sy}; panOrigin={x:panX,y:panY}; document.body.style.cursor="grabbing"; }
function movePan(sx, sy)  { if(!panning) return; panX=panOrigin.x+(sx-panStart.x); panY=panOrigin.y+(sy-panStart.y); applyTransform(); }
function endPan()          { panning=false; document.body.style.cursor="none"; }

/* Scroll behaviour:
   Ctrl/Cmd + scroll → zoom centred on cursor
   Shift       + scroll → pan horizontally
   plain scroll        → pan vertically          */
document.addEventListener("wheel", e => {
  e.preventDefault();

  if (e.ctrlKey || e.metaKey) {
    // Zoom
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(e.clientX, e.clientY, factor);
  } else if (e.shiftKey) {
    // Horizontal pan  (deltaY drives it so regular scroll wheels work too)
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    panX -= delta;
    applyTransform();
  } else {
    // Vertical pan
    panY -= e.deltaY;
    applyTransform();
  }
}, { passive: false });

/* Pinch-to-zoom (touch) */
let lastPinchDist = null;
document.addEventListener("touchstart", e => { if(e.touches.length===2) lastPinchDist=null; }, {passive:true});
document.addEventListener("touchmove", e => {
  if (e.touches.length===2) {
    const d = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
    if (lastPinchDist) {
      const cx=(e.touches[0].clientX+e.touches[1].clientX)/2, cy=(e.touches[0].clientY+e.touches[1].clientY)/2;
      zoomAt(cx, cy, d/lastPinchDist);
    }
    lastPinchDist=d;
  }
}, {passive:true});

/* Middle-mouse pan */
document.addEventListener("mousedown", e => { if(e.button===1){e.preventDefault();startPan(e.clientX,e.clientY);} });
document.addEventListener("mousemove", e => { if(panning) movePan(e.clientX,e.clientY); });
document.addEventListener("mouseup",   e => { if(e.button===1) endPan(); });

/* ── Layer system ── */
let layers      = [];
let activeId    = null;
let layerIdCtr  = 0;
let undoStacks  = {};
let redoStacks  = {};
let vectorPaths = {};
const MAX_UNDO  = 30;

/* ══════════════════════════════════════
   CANVAS HELPERS
══════════════════════════════════════ */
function makeCanvas() {
  const c = document.createElement("canvas");
  // Physical pixels = logical size × CANVAS_DPR so zoom quality is CANVAS_SCALE× better
  c.width  = VW() * CANVAS_DPR;
  c.height = VH() * CANVAS_DPR;
  // CSS size = same as viewport so viewport CSS transform still works correctly
  Object.assign(c.style, {
    position:"absolute", top:"0", left:"0",
    width:"100%", height:"100%",
    touchAction:"none", pointerEvents:"none"
  });
  const cx = c.getContext("2d");
  // Scale by CANVAS_DPR so logical drawing coords remain 0..VW / 0..VH
  cx.scale(CANVAS_DPR, CANVAS_DPR);
  cx.lineCap = "round"; cx.lineJoin = "round";
  return { canvas: c, ctx: cx };
}

function resizeCanvas(canvas, ctx) {
  const imgD = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width  = VW() * CANVAS_DPR;
  canvas.height = VH() * CANVAS_DPR;
  ctx.scale(CANVAS_DPR, CANVAS_DPR);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.putImageData(imgD, 0, 0);
}

/* ══════════════════════════════════════
   LAYER MANAGEMENT
══════════════════════════════════════ */
function addDrawLayer(name) {
  const id = ++layerIdCtr;
  const { canvas, ctx } = makeCanvas();
  if (layers.filter(l => l.type === "draw").length === 0) {
    ctx.fillStyle = "#0d0d11"; ctx.fillRect(0, 0, VW(), VH());
  }
  canvasStack.appendChild(canvas);
  const layer = { id, name: name || `Layer ${id}`, type:"draw", canvas, ctx, visible:true, opacity:1 };
  layers.unshift(layer);
  undoStacks[id]  = [];
  redoStacks[id]  = [];
  vectorPaths[id] = [];
  reorderDOM(); setActiveLayer(id); renderPanel();
  return layer;
}

function addTraceLayer(url, fileName) {
  const id  = ++layerIdCtr;
  const img = new Image(); img.src = url;
  const { canvas, ctx } = makeCanvas();
  img.onload = () => { drawTraceImage(ctx, img, 0.3); renderPanel(); };
  canvasStack.appendChild(canvas);
  const layer = { id, name: fileName || "Trace", type:"trace",
                  canvas, ctx, visible:true, opacity:0.3, img, imgSrc:url };
  layers.unshift(layer);
  addDrawLayer("Layer " + (layerIdCtr));
  reorderDOM(); renderPanel();
  showToast("Trace layer added — draw on the layer above");
}

function drawTraceImage(cx, img, opacity) {
  cx.save(); cx.setTransform(1,0,0,1,0,0); cx.clearRect(0,0,cx.canvas.width,cx.canvas.height); cx.restore();
  const asp = img.width/img.height, cAsp = VW()/VH();
  let dw,dh,dx,dy;
  if (asp>cAsp){dw=VW();dh=VW()/asp;dx=0;dy=(VH()-dh)/2;}
  else         {dh=VH();dw=VH()*asp;dx=(VW()-dw)/2;dy=0;}
  cx.globalAlpha=opacity; cx.drawImage(img,dx,dy,dw,dh); cx.globalAlpha=1;
}

function setActiveLayer(id) {
  const l = layers.find(x => x.id===id && x.type==="draw");
  if (!l) return;
  activeId = id; renderPanel(); updateURBtns();
}

function getActive() { return layers.find(l => l.id===activeId); }

function deleteLayer(id) {
  if (layers.length<=1){showToast("Can't delete last layer");return;}
  const l=layers.find(x=>x.id===id); if(l) l.canvas.remove();
  layers=layers.filter(x=>x.id!==id);
  delete undoStacks[id]; delete redoStacks[id]; delete vectorPaths[id];
  if (activeId===id){ const n=layers.find(l=>l.type==="draw"); if(n) setActiveLayer(n.id); }
  reorderDOM(); renderPanel(); showToast("Layer deleted");
}

function toggleVis(id) {
  const l=layers.find(x=>x.id===id); if(!l) return;
  l.visible=!l.visible; l.canvas.style.display=l.visible?"block":"none"; renderPanel();
}

function setTraceOpacity(id, val) {
  const l=layers.find(x=>x.id===id); if(!l||l.type!=="trace") return;
  l.opacity=val; drawTraceImage(l.ctx, l.img, val);
}

function reorderDOM() {
  [...layers].reverse().forEach(l => canvasStack.appendChild(l.canvas));
}

/* ══════════════════════════════════════
   LAYERS PANEL
══════════════════════════════════════ */
function renderPanel() {
  layersList.innerHTML="";
  layers.forEach(l => {
    const item=document.createElement("div");
    item.className="layer-item"+(l.id===activeId?" active":"");
    item.dataset.id=l.id;

    if (l.type==="trace"&&l.imgSrc) {
      const img=document.createElement("img"); img.src=l.imgSrc; img.className="layer-thumb-img"; item.appendChild(img);
    } else {
      const wrap=document.createElement("div"); wrap.className="layer-thumb";
      const tc=document.createElement("canvas"); tc.width=72; tc.height=56;
      tc.getContext("2d").drawImage(l.canvas,0,0,72,56);
      wrap.appendChild(tc); item.appendChild(wrap);
    }

    const info=document.createElement("div"); info.className="layer-info";
    const nameEl=document.createElement("div"); nameEl.className="layer-name";
    nameEl.textContent=l.name; nameEl.title="Double-click to rename";
    nameEl.addEventListener("dblclick",e=>{e.stopPropagation();doRename(l.id,nameEl);});
    info.appendChild(nameEl);

    if (l.type==="trace") {
      const badge=document.createElement("span"); badge.className="layer-type-badge trace"; badge.textContent="TRACE"; info.appendChild(badge);
      const row=document.createElement("div"); row.className="trace-opacity";
      const sl=document.createElement("input"); sl.type="range"; sl.className="trace-slider"; sl.min=0.02;sl.max=1;sl.step=0.01;sl.value=l.opacity;
      const pct=document.createElement("span"); pct.className="trace-pct"; pct.textContent=Math.round(l.opacity*100)+"%";
      sl.addEventListener("input",()=>{setTraceOpacity(l.id,parseFloat(sl.value));pct.textContent=Math.round(sl.value*100)+"%";});
      sl.addEventListener("click",e=>e.stopPropagation());
      row.appendChild(sl); row.appendChild(pct); info.appendChild(row);
    }
    item.appendChild(info);

    const vis=document.createElement("button"); vis.className="layer-vis"+(l.visible?"":" hidden-eye");
    vis.innerHTML=l.visible
      ?`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      :`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M6.53 6.53A9 9 0 0 0 1 12s4 8 11 8a9 9 0 0 0 5.47-1.53"/></svg>`;
    vis.title=l.visible?"Hide":"Show";
    vis.addEventListener("click",e=>{e.stopPropagation();toggleVis(l.id);});
    item.appendChild(vis);

    if (l.type==="draw") {
      item.style.cursor="pointer";
      item.addEventListener("click",()=>setActiveLayer(l.id));
    }
    layersList.appendChild(item);
  });
}

function doRename(id, el) {
  const l=layers.find(x=>x.id===id); if(!l) return;
  const inp=document.createElement("input"); inp.className="layer-name-input"; inp.value=l.name;
  el.replaceWith(inp); inp.focus(); inp.select();
  inp.addEventListener("blur",()=>{l.name=inp.value.trim()||l.name;renderPanel();});
  inp.addEventListener("keydown",e=>{if(e.key==="Enter")inp.blur();e.stopPropagation();});
  inp.addEventListener("click",e=>e.stopPropagation());
}

document.getElementById("addLayerBtn").addEventListener("click",()=>addDrawLayer());
document.getElementById("deleteLayerBtn").addEventListener("click",()=>{if(activeId)deleteLayer(activeId);});

/* ══════════════════════════════════════
   UNDO / REDO (layer-scoped)
══════════════════════════════════════ */
function saveState(id) {
  const l=layers.find(x=>x.id===id); if(!l||l.type!=="draw") return;
  const st=undoStacks[id]||(undoStacks[id]=[]);
  if(st.length>=MAX_UNDO) st.shift();
  st.push(l.canvas.toDataURL()); redoStacks[id]=[];
  updateURBtns(); refreshThumb(id);
}

function updateURBtns() {
  undoBtn.disabled = !activeId||(undoStacks[activeId]||[]).length<=1;
  redoBtn.disabled = !activeId||!(redoStacks[activeId]||[]).length;
}

function applyState(id, src) {
  const l=layers.find(x=>x.id===id); if(!l) return;
  const img=new Image();
  img.onload=()=>{
    l.ctx.save(); l.ctx.setTransform(1,0,0,1,0,0);
    l.ctx.clearRect(0,0,l.canvas.width,l.canvas.height);
    l.ctx.drawImage(img,0,0); l.ctx.restore();
    l.ctx.lineCap="round"; l.ctx.lineJoin="round";
    updateURBtns(); refreshThumb(id);
  };
  img.src=src;
}

function refreshThumb(id) {
  const tc=document.querySelector(`.layer-item[data-id="${id}"] .layer-thumb canvas`);
  if(!tc) return;
  const l=layers.find(x=>x.id===id); if(!l) return;
  tc.width=72; tc.height=56; tc.getContext("2d").drawImage(l.canvas,0,0,72,56);
}

function undo() {
  if(!activeId) return;
  const us=undoStacks[activeId]||[]; const rs=redoStacks[activeId]||(redoStacks[activeId]=[]);
  if(us.length<=1) return; rs.push(us.pop()); applyState(activeId,us[us.length-1]);
}
function redo() {
  if(!activeId) return;
  const us=undoStacks[activeId]||(undoStacks[activeId]=[]); const rs=redoStacks[activeId]||[];
  if(!rs.length) return; const s=rs.pop(); us.push(s); applyState(activeId,s);
}
undoBtn.addEventListener("click",undo);
redoBtn.addEventListener("click",redo);

/* ══════════════════════════════════════
   PEN TOOL — Figma-like bezier
   Each anchor: { x, y, cp1x, cp1y, cp2x, cp2y, smooth }
   - Click         → sharp corner (no handles)
   - Click + drag  → smooth anchor, drag sets outgoing handle
   - Ctrl + drag existing anchor → adjust its handle
   - Ctrl+Z        → removes last anchor from current path
   - Enter / dbl   → finish path
══════════════════════════════════════ */
const pen = {
  active:    false,       // path in progress
  points:    [],          // [{x,y, cp1x,cp1y, cp2x,cp2y, smooth}]
  color:     "#FFFFFF",
  width:     2,
  dragging:  false,       // mouse held after placing anchor
  dragIdx:   -1,          // which anchor is being handle-dragged
  closed:    false,

  /* start dragging an anchor handle */
  startDrag(idx) {
    this.dragging = true;
    this.dragIdx  = idx;
  },

  /* update handle while dragging */
  updateDrag(mx, my) {
    const pt = this.points[this.dragIdx];
    if (!pt) return;
    // outgoing handle
    pt.cp2x = mx; pt.cp2y = my;
    // mirror = incoming handle (smooth)
    pt.cp1x = 2*pt.x - mx; pt.cp1y = 2*pt.y - my;
    pt.smooth = true;
  },

  /* add a new anchor on click */
  addPoint(x, y) {
    const pt = { x, y, cp1x:x, cp1y:y, cp2x:x, cp2y:y, smooth:false };
    this.points.push(pt);
    this.startDrag(this.points.length-1);
    // auto-close near first anchor
    if (this.points.length>2) {
      const fp=this.points[0];
      if (Math.hypot(x-fp.x, y-fp.y)<16) {
        this.points.pop(); this.closed=true; this.dragging=false;
        commitPen(); return;
      }
    }
  },

  /* pop last anchor (Ctrl+Z in pen mode) */
  undoPoint() {
    if (!this.active) return false;
    if (this.points.length===0) { this.cancel(); return true; }
    this.points.pop();
    this.dragging=false; this.dragIdx=-1;
    if (this.points.length===0) this.active=false;
    renderPenOverlay(); return true;
  },

  cancel() {
    this.active=false; this.points=[]; this.dragging=false; this.dragIdx=-1; this.closed=false;
    clearPrev(); penHint.classList.remove("visible");
  }
};

/* helpers */
function ptNear(ax,ay,bx,by,r=14){ return Math.hypot(ax-bx,ay-by)<r; }

/* ── Rendering the pen path on preview canvas ── */
function renderPenOverlay() {
  clearPrev();
  if (!pen.active && !pen.points.length) return;
  const pts = pen.points;
  if (!pts.length) return;

  /* ── Draw the bezier path so far ── */
  pCtx.save();
  pCtx.strokeStyle = pen.color;
  pCtx.lineWidth   = pen.width;
  pCtx.lineCap     = "round";
  pCtx.lineJoin    = "round";
  pCtx.globalAlpha = 1;

  if (pts.length >= 2) {
    pCtx.beginPath();
    pCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i-1], cur = pts[i];
      pCtx.bezierCurveTo(prev.cp2x, prev.cp2y, cur.cp1x, cur.cp1y, cur.x, cur.y);
    }
    pCtx.stroke();
  }

  /* ── Ghost line: last anchor → mouse (with live bezier preview) ── */
  if (pts.length >= 1 && !pen.dragging) {
    const last = pts[pts.length-1];
    pCtx.beginPath();
    pCtx.setLineDash([5,5]);
    pCtx.strokeStyle = "rgba(255,255,255,0.25)";
    pCtx.lineWidth   = 1.5;
    /* preview the curve the next segment would make */
    pCtx.moveTo(last.x, last.y);
    pCtx.bezierCurveTo(last.cp2x, last.cp2y, mouseX, mouseY, mouseX, mouseY);
    pCtx.stroke();
    pCtx.setLineDash([]);
  }

  /* ── Handle lines (show while dragging active anchor) ── */
  pts.forEach((pt, i) => {
    if (!pt.smooth) return;
    pCtx.beginPath();
    pCtx.strokeStyle="rgba(255,255,255,0.3)"; pCtx.lineWidth=1;
    pCtx.moveTo(pt.cp1x,pt.cp1y); pCtx.lineTo(pt.x,pt.y); pCtx.stroke();
    pCtx.beginPath();
    pCtx.moveTo(pt.x,pt.y); pCtx.lineTo(pt.cp2x,pt.cp2y); pCtx.stroke();
    /* handle dots */
    [pt.cp1x,pt.cp1y,pt.cp2x,pt.cp2y].reduce((acc,v,i,a)=>{
      if(i%2===0){
        pCtx.beginPath(); pCtx.arc(a[i],a[i+1],3,0,Math.PI*2);
        pCtx.fillStyle="rgba(255,255,255,0.7)"; pCtx.fill();
      }
    },null);
  });

  /* ── Show live handle while drag-placing ── */
  if (pen.dragging && pen.dragIdx>=0) {
    const pt=pts[pen.dragIdx];
    if(pt&&pt.smooth){
      pCtx.beginPath(); pCtx.strokeStyle="rgba(129,140,248,0.7)"; pCtx.lineWidth=1.2;
      pCtx.moveTo(pt.cp1x,pt.cp1y); pCtx.lineTo(pt.x,pt.y); pCtx.stroke();
      pCtx.beginPath(); pCtx.moveTo(pt.x,pt.y); pCtx.lineTo(pt.cp2x,pt.cp2y); pCtx.stroke();
      /* handle ends */
      [[pt.cp1x,pt.cp1y],[pt.cp2x,pt.cp2y]].forEach(([hx,hy])=>{
        pCtx.beginPath(); pCtx.arc(hx,hy,4,0,Math.PI*2);
        pCtx.fillStyle="rgba(124,111,252,0.85)"; pCtx.fill();
        pCtx.strokeStyle="#fff"; pCtx.lineWidth=1.2; pCtx.stroke();
      });
    }
  }

  /* ── Anchor dots ── */
  pts.forEach((pt, i) => {
    const isFirst = i===0;
    const closeable = isFirst && pts.length>2;
    pCtx.beginPath(); pCtx.arc(pt.x, pt.y, closeable?7:4, 0, Math.PI*2);
    pCtx.fillStyle = isFirst ? "rgba(74,222,128,0.9)" : "rgba(124,111,252,0.85)";
    pCtx.fill(); pCtx.strokeStyle="#fff"; pCtx.lineWidth=closeable?2:1.5; pCtx.stroke();
  });

  pCtx.restore();
}

/* ── Commit pen path onto active layer canvas ── */
function commitPen() {
  if (pen.points.length<2) { pen.cancel(); return; }
  const al=getActive(); if(!al) return;
  const cx=al.ctx, pts=pen.points;
  cx.beginPath();
  cx.strokeStyle=pen.color; cx.lineWidth=pen.width;
  cx.lineCap="round"; cx.lineJoin="round";
  cx.globalCompositeOperation="source-over"; cx.globalAlpha=1;
  cx.moveTo(pts[0].x, pts[0].y);
  for (let i=1;i<pts.length;i++) {
    const prev=pts[i-1], cur=pts[i];
    cx.bezierCurveTo(prev.cp2x,prev.cp2y, cur.cp1x,cur.cp1y, cur.x,cur.y);
  }
  if (pen.closed) cx.closePath();
  cx.stroke();

  /* store for SVG export */
  if (!vectorPaths[al.id]) vectorPaths[al.id]=[];
  vectorPaths[al.id].push({ points:[...pen.points], color:pen.color, width:pen.width, closed:pen.closed });

  pen.cancel();
  saveState(al.id);
  showToast("Path committed ✓");
}

function clearPrev() {
  pCtx.save(); pCtx.setTransform(1,0,0,1,0,0);
  pCtx.clearRect(0,0,preview.width,preview.height); pCtx.restore();
}

/* ══════════════════════════════════════
   BRUSH ENGINE
══════════════════════════════════════ */
function startBrush(p, al) {
  drawing=true; const cx=al.ctx;
  if (tool==="eraser") {
    cx.globalCompositeOperation="destination-out"; cx.strokeStyle="rgba(0,0,0,1)"; cx.globalAlpha=1;
    cx.lineWidth=brushSize; cx.lineCap="round"; cx.lineJoin="round";
    cx.beginPath(); cx.moveTo(p.x,p.y); cx.lineTo(p.x+.1,p.y+.1); cx.stroke(); return;
  }
  cx.globalCompositeOperation="source-over"; cx.strokeStyle=color; cx.lineWidth=brushSize;
  switch(brushStyle) {
    case "round":
      cx.globalAlpha=1; cx.lineCap="round"; cx.lineJoin="round";
      cx.beginPath(); cx.moveTo(p.x,p.y); cx.lineTo(p.x+.1,p.y+.1); cx.stroke(); break;
    case "pencil":
      cx.globalAlpha=0.65; cx.lineCap="round"; cx.lineJoin="round";
      cx.beginPath(); cx.moveTo(p.x,p.y); cx.lineTo(p.x+.1,p.y+.1); cx.stroke(); break;
    case "marker":
      cx.globalAlpha=0.35; cx.lineCap="square"; cx.lineJoin="miter"; cx.lineWidth=brushSize*1.6;
      cx.beginPath(); cx.moveTo(p.x,p.y); cx.lineTo(p.x+.1,p.y+.1); cx.stroke(); break;
    case "spray":
      cx.globalAlpha=1; doSpray(p,cx); break;
    case "calligraphy":
      cx.globalAlpha=1; drawCalligraphy(cx,p.x,p.y,p.x+.1,p.y+.1); break;
  }
}

function continueBrush(p, al) {
  const cx=al.ctx;
  if (tool==="eraser"||brushStyle==="round"||brushStyle==="pencil"||brushStyle==="marker") {
    cx.lineTo(p.x,p.y); cx.stroke();
  } else if (brushStyle==="spray") { doSpray(p,cx); }
  else if (brushStyle==="calligraphy") { drawCalligraphy(cx,lastX,lastY,p.x,p.y); }
}

function doSpray(p,cx) {
  const n=Math.ceil(brushSize*2.5); cx.fillStyle=color;
  for(let i=0;i<n;i++){const a=Math.random()*Math.PI*2,d=Math.random()*brushSize;cx.fillRect(p.x+Math.cos(a)*d,p.y+Math.sin(a)*d,1.5,1.5);}
}

function drawCalligraphy(cx,x1,y1,x2,y2) {
  const ang=Math.PI/5,hw=brushSize/2,ddx=Math.cos(ang)*hw,ddy=Math.sin(ang)*hw;
  cx.fillStyle=color; cx.globalAlpha=1;
  cx.beginPath(); cx.moveTo(x1-ddx,y1-ddy); cx.lineTo(x1+ddx,y1+ddy);
  cx.lineTo(x2+ddx,y2+ddy); cx.lineTo(x2-ddx,y2-ddy); cx.closePath(); cx.fill();
}

/* ══════════════════════════════════════
   PAINT BUCKET
══════════════════════════════════════ */
function bucketFill(p, al) {
  const cx=al.ctx;
  // p.x/p.y are logical canvas coords (0..VW). Physical pixel = logical * CANVAS_DPR
  const sx=Math.round(p.x*CANVAS_DPR), sy=Math.round(p.y*CANVAS_DPR);
  const cw=al.canvas.width, ch=al.canvas.height;
  const imgD=cx.getImageData(0,0,cw,ch); const data=imgD.data;
  const idx=(sy*cw+sx)*4;
  const tR=data[idx],tG=data[idx+1],tB=data[idx+2],tA=data[idx+3];
  const [fR,fG,fB]=hexRgb(color);
  if(tR===fR&&tG===fG&&tB===fB&&tA===255){showToast("Already this color");return;}
  const tol=48,visited=new Uint8Array(cw*ch),q=[sx,sy];
  const ok=i=>Math.abs(data[i]-tR)<=tol&&Math.abs(data[i+1]-tG)<=tol&&Math.abs(data[i+2]-tB)<=tol&&Math.abs(data[i+3]-tA)<=tol;
  while(q.length){
    const cy=q.pop(),qx=q.pop();
    if(qx<0||qx>=cw||cy<0||cy>=ch)continue;
    const pi=cy*cw+qx; if(visited[pi])continue; visited[pi]=1;
    const di=pi*4; if(!ok(di))continue;
    data[di]=fR;data[di+1]=fG;data[di+2]=fB;data[di+3]=255;
    q.push(qx-1,cy,qx+1,cy,qx,cy-1,qx,cy+1);
  }
  cx.save();cx.setTransform(1,0,0,1,0,0);cx.putImageData(imgD,0,0);cx.restore();
  saveState(al.id); showToast("Filled ✓");
}

function hexRgb(h){const v=h.replace("#","");return[parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16)];}

/* ══════════════════════════════════════
   POINTER EVENTS — all on document
══════════════════════════════════════ */
function getPos(e) {
  let sx, sy;
  if (e.touches && e.touches.length) { sx=e.touches[0].clientX; sy=e.touches[0].clientY; }
  else { sx=e.clientX; sy=e.clientY; }
  rawMouseX=sx; rawMouseY=sy;   // keep screen coords for cursor
  return screenToCanvas(sx, sy);
}
function isUI(e){ return !!e.target.closest(".toolbar-left,.layers-panel,.pen-hint,.toast"); }

document.addEventListener("mousedown",  e=>{ if(e.button!==0) return; if(spaceHeld){startPan(e.clientX,e.clientY);return;} if(!isUI(e)) onDown(getPos(e),e); });
document.addEventListener("mousemove",  e=>{ if(panning){movePan(e.clientX,e.clientY);return;} const p=screenToCanvas(e.clientX,e.clientY); rawMouseX=e.clientX;rawMouseY=e.clientY; onMove(p); });
document.addEventListener("mouseup",    e=>{ if(e.button===0){if(panning&&spaceHeld){endPan();return;} onUp(e);} });
document.addEventListener("touchstart", e=>{ if(e.touches.length===1&&!isUI(e)){e.preventDefault();onDown(getPos(e),e);}},{passive:false});
document.addEventListener("touchmove",  e=>{ if(e.touches.length===1){e.preventDefault();const p=getPos(e);onMove(p);}},{passive:false});
document.addEventListener("touchend",   e=>onUp(e));
document.addEventListener("dblclick",   e=>{ if(!isUI(e)&&tool==="pen") commitPen(); });

function onDown(p, e) {
  mouseX=p.x; mouseY=p.y; lastX=p.x; lastY=p.y;

  if (tool==="pen") {
    /* Ctrl+click on existing anchor → drag its handle */
    if (ctrlHeld) {
      // hit radius in canvas-space shrinks as you zoom in (stays 16px on screen)
      const hitR = 16 / zoom;
      for (let i=pen.points.length-1;i>=0;i--) {
        if (ptNear(p.x,p.y,pen.points[i].x,pen.points[i].y,hitR)) {
          pen.startDrag(i); return;
        }
      }
    }
    if (!pen.active) { pen.active=true; pen.color=color; pen.width=brushSize; pen.closed=false; pen.points=[]; }
    pen.addPoint(p.x, p.y);
    penHint.classList.add("visible");
    renderPenOverlay(); return;
  }

  const al=getActive(); if(!al) return;
  switch(tool) {
    case "brush": case "eraser": startBrush(p,al); break;
    case "bucket": bucketFill(p,al); break;
  }
}

function onMove(p) {
  mouseX=p.x; mouseY=p.y;
  updateCursor();  // uses rawMouseX/Y — always screen-space

  if (tool==="pen") {
    if (pen.dragging && pen.dragIdx>=0) pen.updateDrag(p.x, p.y);
    renderPenOverlay(); return;
  }

  if (!drawing) return;
  const al=getActive(); if(!al) return;
  continueBrush(p,al);
  lastX=p.x; lastY=p.y;
}

function onUp(e) {
  if (tool==="pen") {
    pen.dragging=false; renderPenOverlay(); return;
  }
  if (!drawing) return;
  drawing=false;
  const al=getActive(); if(!al) return;
  al.ctx.globalCompositeOperation="source-over"; al.ctx.globalAlpha=1; al.ctx.closePath();
  saveState(activeId);
}

/* ══════════════════════════════════════
   TOOL SELECTION
══════════════════════════════════════ */
const allToolBtns=[brushToolBtn,penBtn,bucketBtn,eraserBtn];
function setTool(t,btn){
  tool=t; allToolBtns.forEach(b=>b.classList.remove("active")); btn.classList.add("active");
  if(t!=="pen"){ pen.cancel(); }
  if(t!=="brush") brushSubPanel.classList.remove("open");
  penHint.classList.toggle("visible",t==="pen"&&pen.active);
  if(t==="brush") brushSubPanel.classList.add("open");
}

brushToolBtn.addEventListener("click",()=>{ if(tool==="brush") brushSubPanel.classList.toggle("open"); else setTool("brush",brushToolBtn); });
brushSubPanel.querySelectorAll(".sub-btn").forEach(btn=>{
  btn.addEventListener("click",e=>{e.stopPropagation(); brushSubPanel.querySelectorAll(".sub-btn").forEach(b=>b.classList.remove("active")); btn.classList.add("active"); brushStyle=btn.dataset.style; setTool("brush",brushToolBtn);});
});
penBtn.addEventListener("click",()=>setTool("pen",penBtn));
bucketBtn.addEventListener("click",()=>setTool("bucket",bucketBtn));
eraserBtn.addEventListener("click",()=>setTool("eraser",eraserBtn));
document.addEventListener("click",e=>{ if(!e.target.closest("#brushWrap")) brushSubPanel.classList.remove("open"); });

/* ══════════════════════════════════════
   COLOR
══════════════════════════════════════ */
colorPalette.querySelectorAll(".color-swatch").forEach(s=>{
  s.addEventListener("click",()=>{
    colorPalette.querySelectorAll(".color-swatch").forEach(x=>x.classList.remove("active")); s.classList.add("active"); color=s.dataset.color;
    if(tool==="eraser") setTool("brush",brushToolBtn);
  });
});
colorPicker.addEventListener("input",()=>{color=colorPicker.value; colorPalette.querySelectorAll(".color-swatch").forEach(x=>x.classList.remove("active")); if(tool==="eraser") setTool("brush",brushToolBtn);});

/* ══════════════════════════════════════
   BRUSH SIZE
══════════════════════════════════════ */
function syncBrushUI(){
  const sz=Math.max(4,Math.min(brushSize,40)); brushDot.style.width=sz+"px"; brushDot.style.height=sz+"px"; brushLbl.textContent=brushSize;
  const pct=((brushSize-1)/(60-1))*100; brushSzSldr.style.background=`linear-gradient(to top,var(--accent) ${pct}%,rgba(255,255,255,.06) ${pct}%)`;
}
brushSzSldr.addEventListener("input",()=>{brushSize=parseInt(brushSzSldr.value,10);syncBrushUI();});
syncBrushUI();

/* ══════════════════════════════════════
   CURSOR
══════════════════════════════════════ */
const cursorEl=document.createElement("div"); cursorEl.className="canvas-cursor"; document.body.appendChild(cursorEl);
document.body.style.cursor="none";
function updateCursor(){
  // Position: always in raw screen pixels (fixed element)
  cursorEl.style.left = rawMouseX + "px";
  cursorEl.style.top  = rawMouseY + "px";
  // Size: brush pixels scaled by current zoom so the ring matches exactly what's being drawn
  const displaySize = Math.max(2, brushSize * zoom);
  cursorEl.style.width  = displaySize + "px";
  cursorEl.style.height = displaySize + "px";
  const bc = tool==="eraser" ? "rgba(240,96,96,.7)"
           : tool==="bucket" ? "rgba(124,111,252,.7)"
           : tool==="pen"    ? "rgba(74,222,128,.6)"
           :                   "rgba(255,255,255,.5)";
  cursorEl.style.borderColor = bc;
}

/* ══════════════════════════════════════
   CLEAR
══════════════════════════════════════ */
clearBtn.addEventListener("click",()=>{
  const al=getActive(); if(!al) return;
  al.ctx.save(); al.ctx.setTransform(1,0,0,1,0,0); al.ctx.clearRect(0,0,al.canvas.width,al.canvas.height); al.ctx.restore();
  if(layers.filter(l=>l.type==="draw").slice(-1)[0]?.id===al.id){al.ctx.fillStyle="#0d0d11";al.ctx.fillRect(0,0,VW(),VH());}
  vectorPaths[al.id]=[]; saveState(al.id); showToast("Layer cleared");
});

/* ══════════════════════════════════════
   IMAGE IMPORT
══════════════════════════════════════ */
importBtn.addEventListener("click",()=>imageInput.click());
imageInput.addEventListener("change",e=>{if(e.target.files[0])addTraceLayer(URL.createObjectURL(e.target.files[0]),e.target.files[0].name);imageInput.value="";});
document.addEventListener("dragover",e=>{e.preventDefault();dropZone.classList.add("active");});
document.addEventListener("dragleave",e=>{if(!e.relatedTarget)dropZone.classList.remove("active");});
document.addEventListener("drop",e=>{e.preventDefault();dropZone.classList.remove("active");const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("image/"))addTraceLayer(URL.createObjectURL(f),f.name);});

/* ══════════════════════════════════════
   EXPORT
══════════════════════════════════════ */
function flatCanvas(){
  const tmp=document.createElement("canvas"); tmp.width=VW()*dpr; tmp.height=VH()*dpr;
  const tx=tmp.getContext("2d"); tx.scale(dpr,dpr); tx.fillStyle="#0d0d11"; tx.fillRect(0,0,VW(),VH());
  [...layers].reverse().forEach(l=>{if(l.visible)tx.drawImage(l.canvas,0,0,VW(),VH());}); return tmp;
}
exportPng.addEventListener("click",()=>{
  const tmp=flatCanvas(),a=document.createElement("a"); a.download=`inkwell-${Date.now()}.png`; a.href=tmp.toDataURL("image/png"); a.click(); showToast("Saved PNG ✓");
});
exportSvg.addEventListener("click",()=>{
  const w=VW(),h=VH(),tmp=flatCanvas();
  let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="${tmp.toDataURL()}" width="${w}" height="${h}"/>`;
  Object.values(vectorPaths).flat().forEach(vp=>{
    if(!vp.points||vp.points.length<2) return;
    const pts=vp.points; let d=`M ${pts[0].x} ${pts[0].y}`;
    for(let i=1;i<pts.length;i++){const p=pts[i-1],c=pts[i];d+=` C ${p.cp2x} ${p.cp2y} ${c.cp1x} ${c.cp1y} ${c.x} ${c.y}`;}
    if(vp.closed)d+=" Z";
    s+=`<path d="${d}" stroke="${vp.color}" stroke-width="${vp.width}" fill="none" stroke-linecap="round"/>`;
  });
  s+=`</svg>`;
  const blob=new Blob([s],{type:"image/svg+xml"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.download=`inkwell-${Date.now()}.svg`; a.href=url; a.click(); URL.revokeObjectURL(url); showToast("Saved SVG ✓");
});

/* ══════════════════════════════════════
   KEYBOARD SHORTCUTS
══════════════════════════════════════ */
document.addEventListener("keydown",e=>{
  ctrlHeld = e.ctrlKey || e.metaKey;

  /* Space = pan mode */
  if (e.code==="Space"&&!e.target.matches("input")) { e.preventDefault(); spaceHeld=true; document.body.style.cursor="grab"; return; }

  if(e.target.tagName==="INPUT") return;

  /* Ctrl+Z: pen mode → undo last anchor, else layer undo */
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==="z"){
    e.preventDefault();
    if(tool==="pen"&&pen.active){ pen.undoPoint(); renderPenOverlay(); }
    else undo();
    return;
  }
  if((e.ctrlKey||e.metaKey)&&(e.key.toLowerCase()==="y"||(e.shiftKey&&e.key.toLowerCase()==="z"))){e.preventDefault();redo();return;}

  /* Zoom shortcuts */
  if((e.ctrlKey||e.metaKey)&&(e.key==="="||e.key==="+")){e.preventDefault();zoomAt(VW()/2,VH()/2,1.25);return;}
  if((e.ctrlKey||e.metaKey)&&e.key==="-"){e.preventDefault();zoomAt(VW()/2,VH()/2,0.8);return;}
  if((e.ctrlKey||e.metaKey)&&e.key==="0"){e.preventDefault();resetView();return;}

  switch(e.key){
    case "b":case "B": setTool("brush",brushToolBtn); break;
    case "p":case "P": setTool("pen",penBtn); break;
    case "g":case "G": setTool("bucket",bucketBtn); break;
    case "e":case "E": setTool("eraser",eraserBtn); break;
    case "i":case "I": importBtn.click(); break;
    case "Enter":      if(tool==="pen") commitPen(); break;
    case "Escape":     if(tool==="pen") pen.cancel(); break;
    case "[": brushSize=Math.max(1,brushSize-2);brushSzSldr.value=brushSize;syncBrushUI(); break;
    case "]": brushSize=Math.min(60,brushSize+2);brushSzSldr.value=brushSize;syncBrushUI(); break;
  }
});
document.addEventListener("keyup",e=>{
  ctrlHeld=e.ctrlKey||e.metaKey;
  if(e.code==="Space"){spaceHeld=false;if(!panning)document.body.style.cursor="none";endPan();}
});

/* ══════════════════════════════════════
   RESIZE
══════════════════════════════════════ */
function sizePreview(){
  preview.width=VW()*dpr; preview.height=VH()*dpr;
  preview.style.width=VW()+"px"; preview.style.height=VH()+"px"; pCtx.scale(dpr,dpr);
}
sizePreview();
window.addEventListener("resize",()=>{ layers.forEach(l=>{if(l.type==="draw")resizeCanvas(l.canvas,l.ctx);}); sizePreview(); renderPanel(); });

/* ══════════════════════════════════════
   TOAST
══════════════════════════════════════ */
let tT;
function showToast(m){toastEl.textContent=m;toastEl.classList.add("show");clearTimeout(tT);tT=setTimeout(()=>toastEl.classList.remove("show"),2400);}

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
addDrawLayer("Background");
setTool("brush",brushToolBtn);

})();
