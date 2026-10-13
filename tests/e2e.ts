// Expanded CDP suite: crop handles, text boxes, wand, deepfry, bg server, mobile.
const PORT = 9222, STUB = "http://127.0.0.1:7999";
const PAGE_URL = "http://localhost:3100/";
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

let ws: WebSocket; let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const exceptions: any[] = [], consoleErrs: any[] = [];

function send(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++msgId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function evaluate(expression: string, awaitPromise = false): Promise<any> {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error("page exception: " + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
  return r.result.value;
}
const results: { name: string; ok: boolean; extra?: any }[] = [];
function check(name: string, cond: any, extra?: any) {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`);
}
async function shot(path: string) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(path, b64(r.data));
}
async function mouse(type: string, x: number, y: number, buttons = 0) {
  await send("Input.dispatchMouseEvent", { type, x, y,
    button: (type === "mouseMoved" && !buttons) ? "none" : "left",
    buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
}
async function dragPx(x1: number, y1: number, x2: number, y2: number, steps = 12) {
  await mouse("mousePressed", x1, y1, 1);
  for (let i = 1; i <= steps; i++) await mouse("mouseMoved", x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, 1);
  await mouse("mouseReleased", x2, y2, 1);
  await sleep(120);
}
async function touchDrag(x1: number, y1: number, x2: number, y2: number, steps = 10) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
  for (let i = 1; i <= steps; i++) {
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps }] });
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(140);
}
const rectOf = () => evaluate(`view.getBoundingClientRect().toJSON()`);
const snapshot = () => evaluate(`(()=>{window.__snap=vctx.getImageData(0,0,view.width,view.height).data.slice();return view.width+'x'+view.height;})()`);
const diffFrom = (v = "__snap") => evaluate(`(()=>{const a=vctx.getImageData(0,0,view.width,view.height).data;const b=window.${v};let n=0;for(let i=0;i<a.length;i+=4){if(Math.abs(a[i]-b[i])>12||Math.abs(a[i+1]-b[i+1])>12||Math.abs(a[i+2]-b[i+2])>12)n++;}return n;})()`);
async function waitToast(re: RegExp, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await evaluate(`document.querySelector('#toast').textContent`); if (re.test(t)) return t; await sleep(200); }
  return await evaluate(`document.querySelector('#toast').textContent`);
}
const handlePos = async (which: string) => {
  const c = await evaluate(`({...crop})`);
  if (!c || c.w === undefined) throw new Error("crop is null - cannot locate handle " + which);
  const r = await rectOf();
  const s = r.width / (await evaluate(`view.width`));
  const pts: any = { nw:[c.x,c.y], n:[c.x+c.w/2,c.y], ne:[c.x+c.w,c.y], w:[c.x,c.y+c.h/2],
                     e:[c.x+c.w,c.y+c.h/2], sw:[c.x,c.y+c.h], s:[c.x+c.w/2,c.y+c.h], se:[c.x+c.w,c.y+c.h] };
  const [cx, cy] = pts[which];
  return { x: r.left + cx * s, y: r.top + cy * s };
};

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t: any) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data as string);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrs.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Browser.grantPermissions", { origin: "http://localhost:3100", permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/dl", eventsEnabled: true }).catch(() => {});

  const raw = new Uint8Array(await Deno.readFile("/tmp/edtest.png"));
  let bin = ""; for (let i = 0; i < raw.length; i += 8192) bin += String.fromCharCode(...raw.subarray(i, i + 8192));
  const pngB64 = btoa(bin);

  const raw2 = new Uint8Array(await Deno.readFile("/tmp/edgrad.png"));
  let bin2 = ""; for (let i = 0; i < raw2.length; i += 8192) bin2 += String.fromCharCode(...raw2.subarray(i, i + 8192));
  const gradB64 = btoa(bin2);

  const raw3 = new Uint8Array(await Deno.readFile("/tmp/edsmall.png"));
  let bin3 = ""; for (let i = 0; i < raw3.length; i += 8192) bin3 += String.fromCharCode(...raw3.subarray(i, i + 8192));
  const smallB64 = btoa(bin3);

  await send("Page.navigate", { url: PAGE_URL });
  for (let i = 0; i < 40; i++) { await sleep(100); if (await evaluate("document.readyState") === "complete") break; }
  await sleep(400);

  const g = await evaluate(`({t:typeof tool, c:typeof crop, x:typeof texts, s:typeof selText, has:typeof hasImage})`);
  check("state is inspectable via CDP", g.t === "string" && g.x === "object", g);

  const hiddenStates = await evaluate(`({
     selbar:getComputedStyle(document.querySelector('#selbar')).display,
     wand:getComputedStyle(document.querySelector('#wandSec')).display,
     crop:getComputedStyle(document.querySelector('#cropSec')).display})`);
  check("hidden sections are genuinely display:none on boot",
    hiddenStates.selbar === "none" && hiddenStates.wand === "none" && hiddenStates.crop === "none", hiddenStates);

  // ---- 1. load via paste ----
  await evaluate(`window.__png='${pngB64}'`);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'t.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  check("image loaded via paste", (await evaluate(`view.width`)) === 1600 && (await evaluate(`hasImage`)) === true);
  check("default tool is Move", (await evaluate(`tool`)) === "move", await evaluate(`tool`));

  // ---- 1b. shape tools (regression: reported as "trying to drag the image") ----
  await evaluate(`(function(){window.__pc=0;view.addEventListener('pointercancel',()=>window.__pc++);return 1;})()`);
  const rs = await rectOf();
  for (const t of ["brush", "line", "arrow", "rect", "ellipse", "highlight"]) {
    await evaluate(`document.querySelector('[data-tool=${t}]').click()`);
    const activeTool = await evaluate(`tool`);
    await snapshot();
    await dragPx(rs.left + rs.width * 0.25, rs.top + rs.height * 0.25, rs.left + rs.width * 0.7, rs.top + rs.height * 0.6);
    const d = await diffFrom();
    const pc = await evaluate(`window.__pc`);
    check(`tool '${t}' draws`, d > 200, { tool: activeTool, changed: d, pointercancels: pc });
    await evaluate(`undo()`); await sleep(150);
  }

  // ---- 1c. selection + effects (the MS-Paint-ish model) ----
  await evaluate(`window.__grad='${gradB64}'`);
  await evaluate(`window.__small='${smallB64}'`);
  await evaluate(`clearEverything()`);
  check("Clear all empties the canvas", (await evaluate(`hasImage`)) === false);
  check("Clear all empties the layers panel", (await evaluate(`document.querySelectorAll('#layerList .layerRow').length`)) === 2);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__grad),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'g.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  check("first paste after Clear becomes the background", (await evaluate(`hasImage && layers.length === 0 && selLayer === null`)) === true, await evaluate(`({has:hasImage,layers:layers.length})`));
  const rs2 = await rectOf();
  await snapshot();
  await evaluate(`document.querySelector('[data-tool=marquee]').click()`);
  await dragPx(rs2.left + rs2.width * 0.2, rs2.top + rs2.height * 0.2, rs2.left + rs2.width * 0.5, rs2.top + rs2.height * 0.5);
  const sel1 = await evaluate(`selection && ({...selection})`);
  check("Select tool creates a marquee selection", !!sel1 && sel1.w > 100 && sel1.h > 100, sel1);
  const selDrawDiff = await diffFrom();
  check("selection overlay is drawn on the canvas", selDrawDiff > 100, { changed: selDrawDiff });

  for (const type of ["keyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await sleep(250);
  const selAll = await evaluate(`selection && ({...selection})`);
  check("Ctrl+A selects the whole image", !!selAll && selAll.x === 0 && selAll.y === 0 && selAll.w === 1600 && selAll.h === 1200, selAll);
  check("selection info reflects the whole image", /1600 x 1200/.test(await evaluate(`document.querySelector('#selInfo').textContent`)), await evaluate(`document.querySelector('#selInfo').textContent`));

  await snapshot();
  await evaluate(`document.querySelector('#fxPixel').value='20';document.querySelector('#fxPixel').dispatchEvent(new Event('input'));document.querySelector('#fxPixelBtn').click()`);
  await sleep(300);
  const pxDiff = await diffFrom();
  check("Pixelate button changes the image", pxDiff > 1000, { changed: pxDiff });
  await evaluate(`undo()`); await sleep(250);

  await snapshot();
  await evaluate(`document.querySelector('#fxBlur').value='12';document.querySelector('#fxBlur').dispatchEvent(new Event('input'));document.querySelector('#fxBlurBtn').click()`);
  await sleep(400);
  const blDiff = await diffFrom();
  check("Blur button changes the image", blDiff > 1000, { changed: blDiff });
  await evaluate(`undo()`); await sleep(250);

  await evaluate(`document.querySelector('#selClearBtn').click()`);
  check("Clear resets to whole image", (await evaluate(`selection`)) === null);

  await evaluate(`document.querySelector('[data-tool=marquee]').click()`);
  await dragPx(rs2.left + rs2.width * 0.2, rs2.top + rs2.height * 0.2, rs2.left + rs2.width * 0.45, rs2.top + rs2.height * 0.45);
  await snapshot();
  const selNow = await evaluate(`({...selection})`);
  await evaluate(`document.querySelector('#fxPixelBtn').click()`);
  await sleep(300);
  const area = selNow.w * selNow.h;
  const limited = await diffFrom();
  check("effect is limited to the selection", limited > area * 0.5 && limited < area * 1.25, { changed: limited, selectionArea: area });
  await evaluate(`undo()`); await sleep(200);

  await evaluate(`document.querySelector('#selAllBtn').click()`);
  await evaluate(`selection = {x:0,y:0,w:Math.round(view.width/2),h:view.height}; updateSelInfo();`);
  await evaluate(`document.querySelector('[data-tool=wand]').click()`);
  await evaluate(`doWand({x:view.width*0.25,y:view.height*0.25})`);
  await sleep(150);
  const inA = await evaluate(`vctx.getImageData(Math.round(view.width*0.25),Math.round(view.height*0.25),1,1).data[3]`);
  const outA = await evaluate(`vctx.getImageData(Math.round(view.width*0.75),Math.round(view.height*0.25),1,1).data[3]`);
  check("wand is clipped to the selection", inA === 0 && outA === 255, { inside: inA, outside: outA });
  await evaluate(`undo()`); await sleep(200);
  await evaluate(`clearSelection()`);

  // ---- 1d. layers ----
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'t.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  const l1 = await evaluate(`({n:layers.length, rows:document.querySelectorAll('#layerList .layerRow').length, sel:!!selLayer, w:view.width})`);
  check("second paste becomes a layer, background untouched", l1.n === 1 && l1.w === 1600, l1);
  check("layers panel shows annotations + layer + background", l1.rows === 3, l1.rows);
  check("the new layer is auto-selected", l1.sel === true);

  await evaluate(`(function(){document.querySelector('#newBtn').click();return 1;})()`);
  check("New opens the dialog", (await evaluate(`!document.querySelector('#dialog').hidden`)) === true);
  await evaluate(`(function(){document.querySelector('#newCancel').click();return 1;})()`);
  check("Cancel closes the dialog", (await evaluate(`document.querySelector('#dialog').hidden`)) === true);

  await evaluate(`(function(){document.querySelector('#newBtn').click();
    document.querySelector('#newW').value='400';document.querySelector('#newH').value='300';
    document.querySelector('#newBg').value='#000000';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(350);
  const nc = await evaluate(`({w:view.width,h:view.height,has:hasImage,layers:layers.length,px:[...vctx.getImageData(2,2,1,1).data]})`);
  check("New canvas makes a black 400x300 background", nc.w === 400 && nc.h === 300 && nc.has === true && nc.px[0] === 0 && nc.layers === 0, nc);

  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'t.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  await evaluate(`(function(){document.querySelector('#newW').value='1600';document.querySelector('#newH').value='1200';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(300);
  const back = await evaluate(`({w:view.width,h:view.height})`);
  check("New canvas resizes the working area", back.w === 1600 && back.h === 1200, back);

  // three layers, then reorder
  await evaluate(`selLayer=null; layers=[]; render();`);
  for (let k = 0; k < 3; k++) {
    await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([b],'l'+Math.random()+'.png',{type:'image/png'}));
      window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,600));})()`, true);
  }
  const three = await evaluate(`({n:layers.length, rows:document.querySelectorAll('#layerList .layerRow').length})`);
  check("three pastes stack three layers", three.n === 3 && three.rows === 5, three);

  const ids0 = await evaluate(`layers.map(l=>l.id)`);
  await evaluate(`selLayer = layers[0].id; layerMove('front');`);
  const ids1 = await evaluate(`layers.map(l=>l.id)`);
  check("Send to front moves the layer to the top", ids1[2] === ids0[0], { before: ids0.map((x: string) => x.slice(0,3)), after: ids1.map((x: string) => x.slice(0,3)) });
  await evaluate(`layerMove('back')`);
  const ids2 = await evaluate(`layers.map(l=>l.id)`);
  check("Send to back moves the layer to the bottom", ids2[0] === ids0[0], ids2.map((x: string) => x.slice(0,3)));
  await evaluate(`layerMove('up')`);
  const ids3 = await evaluate(`layers.map(l=>l.id)`);
  check("Move up steps one position", ids3[1] === ids0[0], ids3.map((x: string) => x.slice(0,3)));

  // swap in two small layers so handles sit well inside the canvas
  await evaluate(`while(layers.length){selLayer=layers[0].id;layerDelete();} selLayer=null;`);
  for (let k = 0; k < 2; k++) {
    await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([b],'s'+Math.random()+'.png',{type:'image/png'}));
      window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,600));})()`, true);
  }
  const two = await evaluate(`({n:layers.length, w:Math.round(layers[1].w), h:Math.round(layers[1].h)})`);
  check("small fixture pasted as two layers", two.n === 2 && two.w < 1600, two);

  await evaluate(`document.querySelector('[data-tool=move]').click(); selLayer=null; updateLayerUI(); render();`);
  const pt = await evaluate(`(function(){const l=layers[1];const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+(l.x+l.w/2)*s, y:r.top+(l.y+l.h/2)*s};})()`);
  const beforeMove = await evaluate(`({x:Math.round(layers[1].x),y:Math.round(layers[1].y)})`);
  await dragPx(pt.x, pt.y, pt.x + 120, pt.y + 80);
  const afterMove = await evaluate(`({x:Math.round(layers[1].x),y:Math.round(layers[1].y),sel:layers[1].id===selLayer})`);
  check("click-drag selects and repositions the topmost layer", afterMove.x > beforeMove.x + 20 && afterMove.y > beforeMove.y + 15 && afterMove.sel, { before: beforeMove, after: afterMove });

  const beforeRot = await evaluate(`({w:Math.round(layers[1].w),h:Math.round(layers[1].h)})`);
  await evaluate(`layerRotate(90)`);
  const afterRot = await evaluate(`({w:Math.round(layers[1].w),h:Math.round(layers[1].h)})`);
  check("layer rotate swaps width/height", Math.abs(afterRot.w - beforeRot.h) <= 2 && Math.abs(afterRot.h - beforeRot.w) <= 2, { before: beforeRot, after: afterRot });

  const han = await evaluate(`(function(){const l=layers[1];const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+(l.x+l.w)*s, y:r.top+(l.y+l.h)*s};})()`);
  const beforeRe = await evaluate(`Math.round(layers[1].w)`);
  await dragPx(han.x, han.y, han.x + 90, han.y + 60);
  const afterRe = await evaluate(`Math.round(layers[1].w)`);
  check("dragging a corner handle resizes the layer", afterRe > beforeRe + 20, { before: beforeRe, after: afterRe });

  // ---- resize semantics: corners uniform, sides free, centre block moves ----
  const layerPt = async (idx: number, which: string) => evaluate(`(function(){
    const l = layers[${idx}]; const r = view.getBoundingClientRect(); const s = r.width / view.width;
    const p = layerHandlePoints(l);
    return { x: r.left + p.${which}[0] * s, y: r.top + p.${which}[1] * s }; })()`);

  await evaluate(`document.querySelector('[data-tool=move]').click();
    setSelection([layers[1].id]);
    layers[1].x = 400; layers[1].y = 200; layers[1].w = 200; layers[1].h = 150; render();`);
  const geom = () => evaluate(`(function(){const l=layers[1];return {x:Math.round(l.x),y:Math.round(l.y),w:Math.round(l.w),h:Math.round(l.h)};})()`);
  check("layer parked at a known size for the resize tests", JSON.stringify(await geom()) === JSON.stringify({x:400,y:200,w:200,h:150}), await geom());

  let hp = await layerPt(1, "se");
  let before = await geom();
  await dragPx(hp.x, hp.y, hp.x + 120, hp.y + 10);   // deliberately lopsided drag
  let after = await geom();
  check("corner handle stays uniform (aspect ratio kept)",
    after.w > before.w && Math.abs((after.w / after.h) - (before.w / before.h)) < 0.03,
    { before, after, ratioBefore: +(before.w / before.h).toFixed(3), ratioAfter: +(after.w / after.h).toFixed(3) });

  await evaluate(`layers[1].x=400; layers[1].y=200; layers[1].w=200; layers[1].h=150; render();`);
  hp = await layerPt(1, "e");
  before = await geom();
  await dragPx(hp.x, hp.y, hp.x + 90, hp.y);
  after = await geom();
  check("east side handle stretches width only", after.w > before.w + 40 && after.h === before.h, { before, after });

  await evaluate(`layers[1].x=400; layers[1].y=200; layers[1].w=200; layers[1].h=150; render();`);
  hp = await layerPt(1, "s");
  before = await geom();
  await dragPx(hp.x, hp.y, hp.x, hp.y + 70);
  after = await geom();
  check("south side handle stretches height only", after.h > before.h + 30 && after.w === before.w, { before, after });

  await evaluate(`layers[1].x=400; layers[1].y=200; layers[1].w=200; layers[1].h=150; render();`);
  hp = await layerPt(1, "c");
  before = await geom();
  await dragPx(hp.x, hp.y, hp.x + 70, hp.y + 50);
  after = await geom();
  check("centre grab block moves the layer without resizing",
    after.x > before.x + 20 && after.y > before.y + 10 && after.w === before.w && after.h === before.h,
    { before, after });

  await evaluate(`layers[1].x=400; layers[1].y=200; layers[1].w=200; layers[1].h=150; render();`);
  await evaluate(`setSelection(layers.map(l => l.id)); render();`);
  const cBlocks = await evaluate(`selectedLayerSet().length`);
  const nLayers = await evaluate(`layers.length`);
  check("every selected layer gets a centre grab block", cBlocks === nLayers && nLayers > 0, { blocks: cBlocks, layers: nLayers });
  // leave a single-layer selection for the tests that follow
  await evaluate(`setSelection([layers[1].id]); render();`);

  // shapes go to the annotation overlay, not the background
  await snapshot();
  await evaluate(`document.querySelector('[data-tool=rect]').click()`);
  const baseBefore = await evaluate(`(function(){window.__baseProbe=clone(base);return 1;})()`);
  void baseBefore;
  const rr = await rectOf();
  await dragPx(rr.left + rr.width * 0.2, rr.top + rr.height * 0.2, rr.left + rr.width * 0.6, rr.top + rr.height * 0.5);
  const ann = await evaluate(`(function(){
     const d=octx.getImageData(0,0,overlay.width,overlay.height).data; let n=0;
     for(let i=3;i<d.length;i+=4*37) if(d[i]>0) n++;
     const a=base.getContext('2d').getImageData(0,0,base.width,base.height).data;
     const b=window.__baseProbe.getContext('2d').getImageData(0,0,base.width,base.height).data;
     let diff=0; for(let i=0;i<a.length;i+=4*37){ if(Math.abs(a[i]-b[i])>8) diff++; }
     return {overlayPixels:n, baseChanged:diff};})()`);
  check("shapes land on the annotations overlay, not the background", ann.overlayPixels > 50 && ann.baseChanged === 0, ann);
  await evaluate(`undo()`); await sleep(150);
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  await evaluate(`layerDelete(); selLayer=null; updateLayerUI();`);
  check("layer delete removes one layer", (await evaluate(`layers.length`)) === 1, await evaluate(`layers.length`));
  await evaluate(`while(layers.length) { selLayer=layers[0].id; layerDelete(); }`);
  check("all layers can be removed", (await evaluate(`layers.length`)) === 0);

  // ---- 1e. composite effects / flatten / multi-select / copy-paste ----
  const overlayPx = `(function(){const d=octx.getImageData(0,0,overlay.width,overlay.height).data;let k=0;for(let i=3;i<d.length;i+=4*41)if(d[i]>0)k++;return k;})()`;
  const baseHash = `(function(){const d=bctx.getImageData(0,0,base.width,base.height).data;let h=0;for(let i=0;i<d.length;i+=4*97)h=(h*31+d[i])|0;return h;})()`;

  await evaluate(`clearEverything()`);
  await evaluate(`(function(){document.querySelector('#newW').value='1600';document.querySelector('#newH').value='1200';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(300);
  for (let k = 0; k < 2; k++) {
    await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([b],'s'+Math.random()+'.png',{type:'image/png'}));
      window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,600));})()`, true);
  }
  await evaluate(`layers[0].x=200; layers[0].y=200; layers[1].x=800; layers[1].y=600; render();`);
  check("two separated layers for the effect test", (await evaluate(`layers.length`)) === 2);

  // marquee over BOTH layers, then blur -> flattened patch layer over that region
  await evaluate(`setSelection([]); document.querySelector('[data-tool=marquee]').click();`);
  const re = await rectOf();
  const sc = await evaluate(`(function(){const r=view.getBoundingClientRect();return r.width/view.width;})()`);
  const p1 = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+180*s, y:r.top+180*s};})()`);
  const p2 = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+1120*s, y:r.top+720*s};})()`);
  void re; void sc;
  await dragPx(p1.x, p1.y, p2.x, p2.y);
  const selSpan = await evaluate(`({...selection})`);
  check("marquee spans both layers", !!selSpan && selSpan.w > 800 && selSpan.h > 500, selSpan);

  const nBefore = await evaluate(`layers.length`);
  await evaluate(`document.querySelector('[data-tool=move]').click(); document.querySelector('#fxBlurBtn').click()`);
  await sleep(500);
  const fx = await evaluate(`(function(){const l=layers[layers.length-1];
     return {n:layers.length, x:Math.round(l.x), y:Math.round(l.y), w:Math.round(l.w), h:Math.round(l.h)};})()`);
  check("effect flattens the selection into one new layer",
    fx.n === nBefore + 1 && Math.abs(fx.w - selSpan.w) <= 2 && Math.abs(fx.h - selSpan.h) <= 2 && Math.abs(fx.x - selSpan.x) <= 2,
    { sel: selSpan, patch: fx });
  await evaluate(`undo()`); await sleep(250);
  check("effect on a selection is undoable", (await evaluate(`layers.length`)) === nBefore);

  // ctrl+click multi-select, then move them together
  await evaluate(`setSelection([]); document.querySelector('[data-tool=move]').click();`);
  const ca = await evaluate(`(function(){const l=layers[0];const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+(l.x+l.w/2)*s, y:r.top+(l.y+l.h/2)*s};})()`);
  const cb2 = await evaluate(`(function(){const l=layers[1];const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+(l.x+l.w/2)*s, y:r.top+(l.y+l.h/2)*s};})()`);
  await mouse("mousePressed", ca.x, ca.y, 1); await mouse("mouseReleased", ca.x, ca.y, 1);
  check("plain click selects one layer", (await evaluate(`selLayers.length`)) === 1, await evaluate(`selLayers.length`));
  await send("Input.dispatchMouseEvent", { type:"mousePressed", x:cb2.x, y:cb2.y, button:"left", buttons:1, clickCount:1, modifiers:2 });
  await send("Input.dispatchMouseEvent", { type:"mouseReleased", x:cb2.x, y:cb2.y, button:"left", buttons:1, clickCount:1, modifiers:2 });
  await sleep(150);
  check("ctrl+click adds a second layer to the selection", (await evaluate(`selLayers.length`)) === 2, await evaluate(`selLayers.length`));

  const posBefore = await evaluate(`layers.map(l=>({x:Math.round(l.x),y:Math.round(l.y)}))`);
  await dragPx(ca.x, ca.y, ca.x + 80, ca.y + 60);
  const posAfter = await evaluate(`layers.map(l=>({x:Math.round(l.x),y:Math.round(l.y)}))`);
  check("drag moves both selected layers by the same delta",
    posAfter[0].x - posBefore[0].x > 30 && posAfter[0].y - posBefore[0].y > 20 &&
    Math.abs((posAfter[0].x - posBefore[0].x) - (posAfter[1].x - posBefore[1].x)) <= 2,
    { before: posBefore, after: posAfter });

  // ctrl+c / ctrl+v duplicates the selected layer beside it (no marquee active)
  await evaluate(`clearSelection();`);
  const nDup = await evaluate(`layers.length`);
  const dupSrc = await evaluate(`({x:Math.round(primaryLayer().x),y:Math.round(primaryLayer().y),w:Math.round(primaryLayer().w)})`);
  for (const type of ["keyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", { type, key:"c", code:"KeyC", modifiers:2, windowsVirtualKeyCode:67, nativeVirtualKeyCode:67 });
  for (const type of ["keyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", { type, key:"v", code:"KeyV", modifiers:2, windowsVirtualKeyCode:86, nativeVirtualKeyCode:86 });
  await sleep(250);
  const dup = await evaluate(`(function(){const l=layers[layers.length-1];return {n:layers.length,x:Math.round(l.x),y:Math.round(l.y),w:Math.round(l.w)};})()`);
  check("ctrl+c / ctrl+v duplicates the layer offset beside it",
    dup.n === nDup + 1 && dup.x === dupSrc.x + 24 && dup.y === dupSrc.y + 24 && dup.w === dupSrc.w,
    { src: dupSrc, dup });

  // copy a section -> pastes the composited pixels as a layer
  await evaluate(`while(layers.length) { selLayer=layers[0].id; layerDelete(); }`);
  await evaluate(`(function(){document.querySelector('#newW').value='1600';document.querySelector('#newH').value='1200';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(250);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'s.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,600));})()`, true);
  await evaluate(`layers[0].x=100; layers[0].y=100; render();`);
  await evaluate(`document.querySelector('[data-tool=marquee]').click()`);
  const q1 = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;return {x:r.left+100*s,y:r.top+100*s};})()`);
  const q2 = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;return {x:r.left+400*s,y:r.top+300*s};})()`);
  await dragPx(q1.x, q1.y, q2.x, q2.y);
  const sect = await evaluate(`({...selection})`);
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  const nSec = await evaluate(`layers.length`);
  await send("Input.dispatchKeyEvent", { type:"keyDown", key:"c", code:"KeyC", modifiers:2, windowsVirtualKeyCode:67, nativeVirtualKeyCode:67 });
  await send("Input.dispatchKeyEvent", { type:"keyUp", key:"c", code:"KeyC", modifiers:2, windowsVirtualKeyCode:67, nativeVirtualKeyCode:67 });
  await send("Input.dispatchKeyEvent", { type:"keyDown", key:"v", code:"KeyV", modifiers:2, windowsVirtualKeyCode:86, nativeVirtualKeyCode:86 });
  await send("Input.dispatchKeyEvent", { type:"keyUp", key:"v", code:"KeyV", modifiers:2, windowsVirtualKeyCode:86, nativeVirtualKeyCode:86 });
  await sleep(250);
  const sectPaste = await evaluate(`(function(){const l=layers[layers.length-1];return {n:layers.length,x:Math.round(l.x),y:Math.round(l.y),w:Math.round(l.w),h:Math.round(l.h)};})()`);
  check("copying a section pastes the flattened region as a layer",
    sectPaste.n === nSec + 1 && Math.abs(sectPaste.x - sect.x) <= 2 && Math.abs(sectPaste.w - sect.w) <= 2 && Math.abs(sectPaste.h - sect.h) <= 2,
    { section: sect, pasted: sectPaste });
  await evaluate(`undo()`); await sleep(200);

  // flatten ticked layers + annotations into the background
  await evaluate(`clearEverything()`);
  await evaluate(`(function(){document.querySelector('#newW').value='1600';document.querySelector('#newH').value='1200';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(250);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'s.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,600));})()`, true);
  await evaluate(`document.querySelector('[data-tool=rect]').click(); selLayer=null; setSelection([]);`);
  const fr = await rectOf();
  await dragPx(fr.left + fr.width * 0.3, fr.top + fr.height * 0.3, fr.left + fr.width * 0.6, fr.top + fr.height * 0.6);
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  const beforeF = await evaluate(`({n:layers.length, ov:${overlayPx}, hash:${baseHash}, tick:document.querySelectorAll('#layerList input[type=checkbox]').length})`);
  check("there is a tick box per layer row including annotations", beforeF.tick === 2, beforeF.tick);
  await evaluate(`checkedLayers = new Set(layers.map(l => l.id)); flattenAnnotations = true; flattenChecked();`);
  await sleep(250);
  const afterF = await evaluate(`({n:layers.length, ov:${overlayPx}, hash:${baseHash}, texts:texts.length, ticked:checkedLayers.size})`);
  check("flatten pushes ticked layers + annotations into the background",
    afterF.n === 0 && afterF.ov === 0 && afterF.texts === 0, { before: beforeF, after: afterF });
  check("flatten actually changed the background pixels", afterF.hash !== beforeF.hash, { before: beforeF.hash, after: afterF.hash });
  await evaluate(`undo()`); await sleep(200);
  const undoneF = await evaluate(`({n:layers.length, ov:${overlayPx}})`);
  check("flatten is undoable", undoneF.n === beforeF.n && undoneF.ov > 0, undoneF);
  await evaluate(`clearEverything()`);
  // restore a working image for the remaining tests
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'t.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  check("working image restored after the layer tests", (await evaluate(`view.width`)) === 1600);

  // ---- 2. text boxes: create ----
  await evaluate(`document.querySelector('[data-tool=text]').click()`);
  const r1 = await rectOf();
  await mouse("mousePressed", r1.left + r1.width * 0.3, r1.top + r1.height * 0.3, 1);
  await mouse("mouseReleased", r1.left + r1.width * 0.3, r1.top + r1.height * 0.3, 1);
  await sleep(250);
  check("text tool opens a focused editor", (await evaluate(`document.activeElement.tagName`)) === "TEXTAREA");
  await send("Input.insertText", { text: "HELLO" });
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(300);
  const t1 = await evaluate(`texts.map(t=>({text:t.text,x:Math.round(t.x),y:Math.round(t.y),id:t.id}))`);
  check("text box created with content", t1.length === 1 && t1[0].text === "HELLO", t1);
  check("no stray editor left behind", (await evaluate(`!!document.querySelector('.textinput')`)) === false);

  // ---- 3. text boxes: move with Move tool ----
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  const tbox = await evaluate(`(()=>{const t=texts[0];const b=textBBox(t);return {x:t.x,y:t.y,w:b.w,h:b.h};})()`);
  const scale = r1.width / 1600;
  const cx = r1.left + (tbox.x + tbox.w / 2) * scale, cy = r1.top + (tbox.y + tbox.h / 2) * scale;
  await mouse("mousePressed", cx, cy, 1);
  check("clicking a text box selects it", (await evaluate(`selText`)) === t1[0].id);
  check("selection toolbar is visible (computed)", (await evaluate(`getComputedStyle(document.querySelector('#selbar')).display`)) !== "none");
  await mouse("mouseMoved", cx + 120, cy + 80, 1);
  await mouse("mouseReleased", cx + 120, cy + 80, 1);
  await sleep(250);
  const moved = await evaluate(`({x:Math.round(texts[0].x),y:Math.round(texts[0].y)})`);
  check("text box moves by drag", moved.x > t1[0].x + 50 && moved.y > t1[0].y + 30, { before: t1[0], after: moved });

  // ---- 4. text: undo of move, duplicate, delete ----
  await evaluate(`undo()`); await sleep(250);
  const undone = await evaluate(`({x:Math.round(texts[0].x),y:Math.round(texts[0].y)})`);
  check("undo reverts text move", undone.x === t1[0].x && undone.y === t1[0].y, undone);
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  await evaluate(`selText=texts[0].id; updateSelBar()`);
  await evaluate(`document.querySelector('#selDup').click()`); await sleep(200);
  check("duplicate adds a text box", (await evaluate(`texts.length`)) === 2, await evaluate(`texts.length`));
  await evaluate(`document.querySelector('#selDel').click()`); await sleep(200);
  check("delete removes selected box", (await evaluate(`texts.length`)) === 1);

  // ---- 5. text boxes appear in export ----
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  await evaluate(`selText=texts[0].id; updateSelBar()`);
  const withText = await evaluate(`flatten('image/png').then(b=>b.size)`, true);
  await evaluate(`document.querySelector('#selDel').click()`); await sleep(250);
  const afterDel = await evaluate(`texts.length`);
  const withoutText = await evaluate(`flatten('image/png').then(b=>b.size)`, true);
  check("delete via toolbar empties text list", afterDel === 0, afterDel);
  check("exported image includes text boxes", withText !== withoutText, { withText, withoutText });
  await evaluate(`undo()`); await sleep(250);
  check("undo restores deleted text", (await evaluate(`texts.length`)) === 1, await evaluate(`texts.length`));
  await shot("/tmp/m_1_text.png");

  // ---- 6. magic wand ----
  await evaluate(`selLayer = null; updateLayerUI();`);
  await evaluate(`document.querySelector('[data-tool=wand]').click()`);
  check("wand options show when the wand is selected", (await evaluate(`getComputedStyle(document.querySelector('#wandSec')).display`)) !== "none");
  check("the wand's Transparent option defaults on", (await evaluate(`document.querySelector('#wandTransparent').checked`)) === true);
  const wandRes = await evaluate(`(async()=>{const before=vctx.getImageData(0,0,view.width,view.height).data;
     const bx=Math.round(view.width*0.25), by=Math.round(view.height*0.25);
     doWand({x:bx,y:by}); await new Promise(r=>setTimeout(r,50));
     const after=vctx.getImageData(0,0,view.width,view.height).data;
     let cleared=0; for(let i=3;i<after.length;i+=4) if(before[i]!==0 && after[i]===0) cleared++;
     const at=(by*view.width+bx)*4;
     return {cleared, alphaAtTap:after[at+3], toast:document.querySelector('#toast').textContent};})()`, true);
  check("wand erases the tapped flat region", wandRes.cleared > 100000 && wandRes.alphaAtTap === 0, wandRes);
  await evaluate(`undo()`); await sleep(250);
  check("wand is undoable", (await evaluate(`vctx.getImageData(2,2,1,1).data[3]`)) === 255);

  // Transparent off -> the matched region is filled with the selected colour instead of cleared
  const colorBefore = await evaluate(`document.querySelector('#color').value`);
  const tapBefore = await evaluate(`(function(){const bx=Math.round(view.width*0.25), by=Math.round(view.height*0.25);
     return [...vctx.getImageData(bx,by,1,1).data];})()`);
  await evaluate(`(function(){selText=null;
    const c=document.querySelector('#color'); c.value='#123456'; c.dispatchEvent(new Event('input'));
    const t=document.querySelector('#wandTransparent'); t.checked=false; t.dispatchEvent(new Event('change')); return 1;})()`);
  const wandFill = await evaluate(`(async()=>{const bx=Math.round(view.width*0.25), by=Math.round(view.height*0.25);
     doWand({x:bx,y:by}); await new Promise(r=>setTimeout(r,50));
     return {at:[...vctx.getImageData(bx,by,1,1).data], toast:document.querySelector('#toast').textContent};})()`, true);
  check("wand fills the region with the selected colour when Transparent is off",
    wandFill.at.join() === '18,52,86,255' && /Filled/.test(wandFill.toast), wandFill);
  await evaluate(`undo()`); await sleep(250);
  const tapAfter = await evaluate(`(function(){const bx=Math.round(view.width*0.25), by=Math.round(view.height*0.25);
     return [...vctx.getImageData(bx,by,1,1).data];})()`);
  check("the wand fill is undoable", tapAfter.join() === tapBefore.join(), { before: tapBefore, after: tapAfter });
  await evaluate(`(function(){const c=document.querySelector('#color'); c.value='${colorBefore}'; c.dispatchEvent(new Event('input'));
    const t=document.querySelector('#wandTransparent'); t.checked=true; t.dispatchEvent(new Event('change')); return 1;})()`);

  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  check("wand options hide again", (await evaluate(`getComputedStyle(document.querySelector('#wandSec')).display`)) === "none");

  // ---- 7. crop: create, resize by handle, move, apply ----
  await evaluate(`document.querySelector('[data-tool=crop]').click()`);
  const rc = await rectOf();
  await dragPx(rc.left + rc.width * 0.2, rc.top + rc.height * 0.2, rc.left + rc.width * 0.5, rc.top + rc.height * 0.5);
  const c1 = await evaluate(`({...crop})`);
  check("crop selection created by drag", c1.w > 100 && c1.h > 100, c1);
  check("crop apply UI shown", (await evaluate(`!document.querySelector('#cropSec').hidden`)) === true);

  const se = await handlePos("se");
  await dragPx(se.x, se.y, se.x + 90, se.y + 70);
  const c2 = await evaluate(`({...crop})`);
  check("crop SE handle resizes", c2.w > c1.w + 40 && c2.h > c1.h + 20, { before: { w: c1.w, h: c1.h }, after: { w: c2.w, h: c2.h } });

  const nw = await handlePos("nw");
  await dragPx(nw.x, nw.y, nw.x - 40, nw.y - 30);
  const c3 = await evaluate(`({...crop})`);
  check("crop NW handle resizes from the top-left", c3.x < c2.x && c3.w > c2.w, { before: { x: c2.x, w: c2.w }, after: { x: c3.x, w: c3.w } });

  const insidePt = await evaluate(`(()=>{const r=view.getBoundingClientRect();const s=r.width/view.width;
      return {x:r.left+(crop.x+crop.w/2)*s, y:r.top+(crop.y+crop.h/2)*s};})()`);
  await dragPx(insidePt.x, insidePt.y, insidePt.x - 60, insidePt.y - 40);
  const c4 = await evaluate(`({...crop})`);
  check("crop interior drag moves the selection", c4.x < c3.x && c4.y < c3.y && Math.abs(c4.w - c3.w) < 4, { before: { x: c3.x, y: c3.y }, after: { x: c4.x, y: c4.y } });
  await shot("/tmp/m_2_crop.png");

  const beforeApply = await evaluate(`({...crop})`);
  await evaluate(`document.querySelector('#applyCropBtn').click()`); await sleep(400);
  const applied = await evaluate(`({w:view.width,h:view.height,cropIsNull:crop===null})`);
  check("crop apply resizes canvas to selection", Math.abs(applied.w - beforeApply.w) <= 2 && Math.abs(applied.h - beforeApply.h) <= 2, { sel: beforeApply, applied });
  await evaluate(`undo()`); await sleep(300);
  check("crop undo restores size", (await evaluate(`view.width`)) === 1600);

  // ---- 8. deepfry ----
  await evaluate(`clearEverything()`);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'t.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  check("textured background in place before frying", (await evaluate(`view.width === 1600 && layers.length === 0`)) === true);
  await snapshot();
  await evaluate(`document.querySelector('#fryLevel').value='medium'; document.querySelector('#fryBtn').click()`);
  const fried = await waitToast(/Deep fried/, 30000);
  const fryDiff = await diffFrom();
  const sat = await evaluate(`(()=>{const d=vctx.getImageData(0,0,view.width,view.height).data;let s=0,n=0;
      for(let i=0;i<d.length;i+=4*997){const r=d[i],g=d[i+1],b=d[i+2];const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
      s+=mx===0?0:(mx-mn)/mx;n++;} return s/n;})()`);
  check("deepfry runs and reports", /Deep fried/.test(fried), fried);
  check("deepfry changes the image", fryDiff > 100000, { changed: fryDiff });
  check("deepfry increases saturation", sat > 0.5, { avgSaturation: Number(sat.toFixed(3)) });
  await shot("/tmp/m_3_fried.png");
  await evaluate(`undo()`); await sleep(200);

  // ---- 9. background removal via stub server ----
  await evaluate(`selLayer = null; updateLayerUI();`);
  await evaluate(`document.querySelector('#bgUrl').value='${STUB}/api/remove'`);
  await evaluate(`document.querySelector('#bgBtn').click()`);
  const bgToast = await waitToast(/Background removed|Failed/, 20000);
  const bgState = await evaluate(`({w:view.width,h:view.height})`);
  check("no stray layers during the bg test", (await evaluate(`layers.length`)) === 0, await evaluate(`layers.length`));
  const bgAlpha = await evaluate(`bctx.getImageData(20,20,1,1).data[3]`);
  const stats = await (await fetch(`${STUB}/stats`)).json();
  check("bg server round-trip succeeds", /Background removed/.test(bgToast), bgToast);
  check("bg result replaces canvas", bgState.w === 200 && bgState.h === 150, bgState);
  check("bg result preserves transparency", bgAlpha === 0, { alphaAtLeft: bgAlpha });
  check("bg request used multipart field 'file'", stats.ok >= 1 && stats.bad === 0, stats);

  // with a layer selected it should target that layer instead of the background
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'t.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  const bgl = await evaluate(`({viewW:view.width, n:layers.length, sel:!!selLayer})`);
  await evaluate(`document.querySelector('#bgBtn').click()`);
  const bglToast = await waitToast(/Background removed/, 20000);
  const bglAfter = await evaluate(`(function(){const l=layers.find(x=>x.id===selLayer)||layers[layers.length-1];return {viewW:view.width, layerCW:l.c.width, layerCH:l.c.height};})()`);
  check("bg removal targets the selected layer", /from layer/.test(bglToast) && bglAfter.layerCW === 200 && bglAfter.viewW === bgl.viewW, { toast: bglToast, before: bgl, after: bglAfter });
  await evaluate(`undo(); selLayer=null; updateLayerUI();`); await sleep(200);
  await shot("/tmp/m_4_bg.png");
  await evaluate(`undo()`); await sleep(200);

  // ---- 10. mobile layout ----
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  const mob = await evaluate(`({panelPos:getComputedStyle(document.querySelector('#panel')).position,
     toggle:getComputedStyle(document.querySelector('#sheetToggle')).display,
     open:document.querySelector('#panel').classList.contains('open'),
     toolsScroll:document.querySelector('#tools').scrollWidth > document.querySelector('#tools').clientWidth,
     btnH:document.querySelector('#undoBtn').getBoundingClientRect().height})`);
  check("mobile: panel becomes a bottom sheet", mob.panelPos === "fixed", mob.panelPos);
  check("mobile: Controls toggle is visible", mob.toggle !== "none", mob.toggle);
  check("mobile: sheet starts closed", mob.open === false);
  check("mobile: tool strip scrolls horizontally", mob.toolsScroll === true);
  check("mobile: touch targets >= 40px", mob.btnH >= 40, { buttonHeight: mob.btnH });

  await evaluate(`document.querySelector('#sheetToggle').click()`); await sleep(400);
  check("mobile: Controls opens the sheet", (await evaluate(`document.querySelector('#panel').classList.contains('open')`)) === true);
  await shot("/tmp/m_5_mobile_sheet.png");
  await evaluate(`document.querySelector('#backdrop').click()`); await sleep(400);
  check("mobile: backdrop closes the sheet", (await evaluate(`document.querySelector('#panel').classList.contains('open')`)) === false);

  // regression: after the viewport shrank, a fitted view must be re-centred (not left at the
  // desktop pan), otherwise it overflows the stage and canvas coordinates land off-screen.
  const mrect = await rectOf();
  const mstage = await evaluate(`stage.getBoundingClientRect().toJSON()`);
  check("mobile: a fitted view is re-centred inside the stage",
    mrect.left >= mstage.left - 1 && mrect.right <= mstage.right + 1 &&
    mrect.top >= mstage.top - 1 && mrect.bottom <= mstage.bottom + 1, { view: mrect, stage: mstage });

  await evaluate(`document.querySelector('[data-tool=brush]').click()`);
  const rm = await rectOf();
  await snapshot();
  await touchDrag(rm.left + rm.width * 0.25, rm.top + rm.height * 0.25, rm.left + rm.width * 0.7, rm.top + rm.height * 0.6);
  const touchDiff = await diffFrom();
  check("mobile: touch drag draws", touchDiff > 300, { changed: touchDiff });
  await shot("/tmp/m_6_mobile_draw.png");
  await evaluate(`undo()`); await sleep(200);

  await evaluate(`document.querySelector('[data-tool=crop]').click()`);
  await touchDrag(rm.left + rm.width * 0.25, rm.top + rm.height * 0.25, rm.left + rm.width * 0.6, rm.top + rm.height * 0.6);
  const cm = await evaluate(`({...crop})`);
  check("mobile: touch creates crop selection", cm.w > 50 && cm.h > 50, cm);
  const seM = await handlePos("se");
  await touchDrag(seM.x, seM.y, seM.x + 50, seM.y + 40);
  const cm2 = await evaluate(`({...crop})`);
  check("mobile: touch drags a crop handle", cm2.w > cm.w + 20, { before: cm.w, after: cm2.w });
  await evaluate(`cancelCrop()`);

  await send("Emulation.clearDeviceMetricsOverride");
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await sleep(300);

  // ---- 11. export / copy regression ----
  try { await Deno.remove("/tmp/dl", { recursive: true }); } catch {}
  await Deno.mkdir("/tmp/dl", { recursive: true }).catch(() => {});
  await evaluate(`document.querySelector('#dlBtn').click()`); await sleep(1200);
  const dl = [...Deno.readDirSync("/tmp/dl")].map(f => f.name);
  check("download still writes a file", dl.length > 0, dl);
  const cp = await evaluate(`(async()=>{await copyToClipboard();await new Promise(r=>setTimeout(r,400));return document.querySelector('#toast').textContent;})()`, true);
  check("copy to clipboard still works", /Copied/.test(String(cp)), String(cp));

  // ---- 11b. clipboard routing (regression: Ctrl+V swallowed the native paste) ----
  const pressKey = async (k: string, code: string, vk: number, mods = 2) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key: k, code, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  // Poll page state instead of sleeping a fixed time, so async work (clipboard reads,
  // image decoding) can never race the assertion.
  const waitFor = async (expr: string, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(100); }
    return false;
  };
  await evaluate(`clearEverything()`);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([b],{type:'image/png'})})]);
    return 1;})()`, true);
  await pressKey("v", "KeyV", 86);
  await waitFor(`hasImage === true && view.width === 300`);
  const nat1 = await evaluate(`({w:view.width, has:hasImage, layers:layers.length})`);
  check("Ctrl+V pastes an image from the system clipboard", nat1.w === 300 && nat1.has === true, nat1);

  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([b],{type:'image/png'})})]);
    return 1;})()`, true);
  await pressKey("v", "KeyV", 86);
  await waitFor(`layers.length === 1`);
  const nat2 = await evaluate(`({w:view.width, layers:layers.length})`);
  check("Ctrl+V pastes a second image as a layer", nat2.layers === 1 && nat2.w === 300, nat2);

  // internal buffer: no image on the system clipboard -> Ctrl+V must fall back to our copy
  await evaluate(`setSelection([layers[0].id]); copySel();`, true);   // let the OS write settle first
  await evaluate(`navigator.clipboard.writeText('not an image')`);
  const nBeforeClip = await evaluate(`layers.length`);
  await pressKey("v", "KeyV", 86);
  await waitFor(`layers.length === ${nBeforeClip + 1}`);
  const fallback = await evaluate(`layers.length`);
  check("Ctrl+V falls back to the internal copy when the clipboard has no image", fallback === nBeforeClip + 1, { before: nBeforeClip, after: fallback });

  // Ctrl+C fills the internal buffer from the selected layer (not a false positive)
  await evaluate(`setSelection([layers[0].id]); document.querySelector('#toast').textContent='';`);
  await pressKey("c", "KeyC", 67);
  let ct = "";
  for (let i = 0; i < 20 && !/Copied/.test(ct); i++) {
    await sleep(60);
    ct = await evaluate(`document.querySelector('#toast').textContent`);
  }
  check("Ctrl+C copies the selected layer", /Copied layer/.test(ct), ct);

  // the export Copy button still puts the flattened image on the system clipboard
  await evaluate(`document.querySelector('#toast').textContent='';`);
  await evaluate(`copyToClipboard()`, true);
  const cc = await evaluate(`document.querySelector('#toast').textContent`);
  check("copy-to-system-clipboard still works", /Copied to clipboard/.test(cc), cc);
  const onClip = await evaluate(`(async()=>{const items=await navigator.clipboard.read();
     return items.some(i=>i.types.includes('image/png'));})()`, true).catch((e: any) => 'err:' + e.message);
  check("the system clipboard really holds an image after Copy", onClip === true, onClip);

  // ---- 11c. the real workflow: click a layer, Ctrl+C, Ctrl+V ----
  await evaluate(`clearEverything()`);
  for (let k = 0; k < 2; k++) {
    await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([b],'s'+Math.random()+'.png',{type:'image/png'}));
      window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,700));})()`, true);
  }
  const wf = await evaluate(`({bg:view.width, layers:layers.length})`);
  check("workflow fixture ready", wf.bg === 300 && wf.layers === 1, wf);

  await evaluate(`document.querySelector('[data-tool=move]').click(); setSelection([]);`);
  const lc = await evaluate(`(function(){const l=layers[0];const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+(l.x+l.w/2)*s, y:r.top+(l.y+l.h/2)*s};})()`);
  await mouse("mousePressed", lc.x, lc.y, 1); await mouse("mouseReleased", lc.x, lc.y, 1);
  check("clicking the layer on canvas selects it", (await evaluate(`selLayers.length`)) === 1, await evaluate(`selLayers.length`));

  const srcPos = await evaluate(`({x:Math.round(primaryLayer().x),y:Math.round(primaryLayer().y),w:Math.round(primaryLayer().w),n:layers.length})`);
  await pressKey("c", "KeyC", 67);
  // Await the app's own mirror promise before reading. Reading while the write is still
  // in flight makes headless Chromium invalidate the clipboard ("Clipboard data has
  // changed") and the later paste event then sees stale data - a hard-to-see flake.
  await evaluate(`clipMirror`, true);
  const mirror = await evaluate(`(async()=>{
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (!it.types.includes('image/png')) continue;
          const bmp = await createImageBitmap(await it.getType('image/png'));
          return { sig: pixelSig(bmp), clipSig, size: bmp.width + 'x' + bmp.height };
        }
        return 'no image';
      } catch (e) { return 'err:' + e.message; }
    })()`, true);
  check("Ctrl+C mirrors the copy onto the system clipboard", !!mirror && mirror.sig === mirror.clipSig, mirror);

  await pressKey("v", "KeyV", 86);
  await waitFor(`layers.length === ${srcPos.n + 1}`);
  const wfAfter = await evaluate(`(function(){const l=layers[layers.length-1];
     return {n:layers.length, x:Math.round(l.x), y:Math.round(l.y), w:Math.round(l.w)};})()`);
  check("Ctrl+C then Ctrl+V duplicates the clicked layer beside it",
    wfAfter.n === srcPos.n + 1 && wfAfter.x === srcPos.x + 24 && wfAfter.y === srcPos.y + 24 && wfAfter.w === srcPos.w,
    { src: srcPos, dup: wfAfter });

  // ---- 11d. selection must be clearly visible ----
  await evaluate(`setSelection(layers.map(l => l.id)); render();`);
  const viz = await evaluate(`({sel:selLayers.length, active:document.querySelectorAll('#layerList .layerRow.active').length})`);
  check("every selected layer is highlighted in the panel", viz.active === viz.sel && viz.sel === 2, viz);
  await evaluate(`window.__vizSnap = vctx.getImageData(0,0,view.width,view.height).data.slice();`);
  await evaluate(`setSelection([]); render();`);
  const vizDiff = await evaluate(`(function(){const a=vctx.getImageData(0,0,view.width,view.height).data;const b=window.__vizSnap;
     let n=0; for(let i=0;i<a.length;i+=4) if(Math.abs(a[i]-b[i])>8||Math.abs(a[i+1]-b[i+1])>8) n++; return n;})()`);
  check("selected layers are outlined on the canvas", vizDiff > 500, { changed: vizDiff });

  // ============ 11e. desktop picking: hover, alt-click cycle, arrow nudge ============
  await evaluate(`clearEverything()`);
  await evaluate(`(function(){document.querySelector('#newW').value='800';document.querySelector('#newH').value='600';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(250);
  for (let k = 0; k < 2; k++) {
    await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([b],'p'+Math.random()+'.png',{type:'image/png'}));
      window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,600));})()`, true);
  }
  await evaluate(`layers[0].x=100; layers[0].y=100; layers[1].x=250; layers[1].y=180;
    document.querySelector('[data-tool=move]').click(); setSelection([]); hoverId=null; render();`);
  const pickPt = await evaluate(`(function(){const l=layers[1];const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+(l.x+l.w/2)*s, y:r.top+(l.y+l.h/2)*s};})()`);
  await evaluate(`window.__preHover = vctx.getImageData(0,0,view.width,view.height).data.slice();`);
  await mouse("mouseMoved", pickPt.x, pickPt.y, 0);
  await sleep(200);
  const hov = await evaluate(`({idx: hoverId ? layers.findIndex(l=>l.id===hoverId) : -1})`);
  check("hovering marks the layer under the cursor", hov.idx === 1, hov);
  const hovDiff = await evaluate(`(function(){const a=vctx.getImageData(0,0,view.width,view.height).data,b=window.__preHover;
     let n=0;for(let i=0;i<a.length;i+=4) if(Math.abs(a[i]-b[i])>8||Math.abs(a[i+2]-b[i+2])>8) n++; return n;})()`);
  check("hover draws an outline on the canvas", hovDiff > 100, { changed: hovDiff });

  const stackPt = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+300*s, y:r.top+220*s};})()`);
  const altClick = async () => {
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", { type, x: stackPt.x, y: stackPt.y, button: "left", buttons: 1, clickCount: 1, modifiers: 1 });
    await sleep(140);
    return await evaluate(`selLayer ? layers.findIndex(l => l.id === selLayer) : -1`);
  };
  await evaluate(`setSelection([]); render();`);
  const a1 = await altClick();
  const a2 = await altClick();
  check("alt-click cycles down through the stack", a1 === 1 && a2 === 0, { first: a1, second: a2 });

  await evaluate(`document.activeElement && document.activeElement.blur(); setSelection([layers[0].id]); render();`);
  const nx0 = await evaluate(`Math.round(layers[0].x)`);
  await pressKey("ArrowRight", "ArrowRight", 39, 0);
  await sleep(80);
  const nx1 = await evaluate(`Math.round(layers[0].x)`);
  check("arrow key nudges by 1px", nx1 === nx0 + 1, { before: nx0, after: nx1 });
  await pressKey("ArrowRight", "ArrowRight", 39, 8);
  await sleep(80);
  const nx2 = await evaluate(`Math.round(layers[0].x)`);
  check("shift+arrow nudges by 10px", nx2 === nx1 + 10, { before: nx1, after: nx2 });
  await evaluate(`undo()`); await sleep(200);
  const nx3 = await evaluate(`Math.round(layers[0].x)`);
  check("a burst of nudges collapses into one undo step", nx3 === nx0, { expected: nx0, got: nx3 });

  // ============ 11e2. zoom + pan ============
  const z0 = await evaluate(`(function(){const r=view.getBoundingClientRect();
    return {zoom, fit:fitZoom, rw:r.width, vw:view.width};})()`);
  check("the view starts fitted to the stage",
    z0.zoom <= 1 && Math.abs(z0.rw - z0.vw * z0.zoom) < 1.5 && Math.abs(z0.zoom - z0.fit) < 1e-6, z0);

  const anchor = await evaluate(`(function(){const r=view.getBoundingClientRect();
    window.__ax=r.left+r.width*0.35; window.__ay=r.top+r.height*0.4; return {x:window.__ax,y:window.__ay};})()`);
  const beforePt = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;
    return {ix:(window.__ax-r.left)/s, iy:(window.__ay-r.top)/s};})()`);
  await send("Input.dispatchMouseEvent", { type:"mouseWheel", x:anchor.x, y:anchor.y, deltaX:0, deltaY:-240 });
  await sleep(150);
  const afterPt = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;
    return {zoom, ix:(window.__ax-r.left)/s, iy:(window.__ay-r.top)/s};})()`);
  check("the wheel zooms in", afterPt.zoom > z0.zoom * 1.05, { before: z0.zoom, after: afterPt.zoom });
  check("the wheel keeps the image point under the cursor fixed",
    Math.abs(afterPt.ix - beforePt.ix) < 3 && Math.abs(afterPt.iy - beforePt.iy) < 3,
    { before: beforePt, after: afterPt });

  await evaluate(`document.querySelector('#zoomFit').click()`); await sleep(80);
  check("Fit returns to the fitted scale", Math.abs((await evaluate(`zoom`)) - z0.fit) < 1e-6, await evaluate(`zoom`));
  await evaluate(`document.querySelector('#zoomPct').click()`); await sleep(80);
  check("the 1:1 button sets 100%", Math.abs((await evaluate(`zoom`)) - 1) < 1e-6, await evaluate(`zoom`));
  await evaluate(`document.querySelector('#zoomIn').click()`); await sleep(80);
  const zi = await evaluate(`zoom`);
  await evaluate(`document.querySelector('#zoomOut').click()`); await sleep(80);
  const zo = await evaluate(`zoom`);
  check("+ / - buttons step the scale", zi > 1 && zo < zi, { in: zi, out: zo });

  // zoom must not break the coordinate mapping every tool depends on
  const map = await evaluate(`(function(){const r=view.getBoundingClientRect();
    const p=toCanvas({clientX:r.left+r.width/2, clientY:r.top+r.height/2});
    return {s:viewScale(), zoom, cx:p.x, cy:p.y, hw:view.width/2, hh:view.height/2};})()`);
  check("viewScale and toCanvas follow the zoom",
    Math.abs(map.s - map.zoom) < 1e-6 && Math.abs(map.cx - map.hw) < 1 && Math.abs(map.cy - map.hh) < 1, map);

  // space-drag pans the view without touching the document
  await evaluate(`setZoom(3); selLayer=null; setSelection([]); render();`); await sleep(120);
  const pan0 = await evaluate(`({...pan})`);
  const layerX0 = await evaluate(`layers[0].x`);
  const pr = await rectOf();
  await send("Input.dispatchKeyEvent", { type:"keyDown", key:" ", code:"Space", windowsVirtualKeyCode:32, nativeVirtualKeyCode:32 });
  await mouse("mousePressed", pr.left + pr.width * 0.5, pr.top + pr.height * 0.5, 1);
  await mouse("mouseMoved", pr.left + pr.width * 0.5 - 90, pr.top + pr.height * 0.5 - 70, 1);
  await mouse("mouseReleased", pr.left + pr.width * 0.5 - 90, pr.top + pr.height * 0.5 - 70, 1);
  await send("Input.dispatchKeyEvent", { type:"keyUp", key:" ", code:"Space", windowsVirtualKeyCode:32, nativeVirtualKeyCode:32 });
  await sleep(120);
  const pan1 = await evaluate(`({...pan})`);
  check("space-drag pans the view", pan1.x < pan0.x - 40 && pan1.y < pan0.y - 30, { before: pan0, after: pan1 });
  check("panning leaves the document alone",
    (await evaluate(`layers[0].x`)) === layerX0 && (await evaluate(`layers.length`)) === 2, { layerX: layerX0 });

  // ============ 11e3. tool shortcuts, default ticks, select-on-press ============
  await evaluate(`clearEverything()`);
  await evaluate(`(function(){document.querySelector('#newW').value='800';document.querySelector('#newH').value='600';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(250);
  for (let k = 0; k < 2; k++) {
    await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
      const dt=new DataTransfer(); dt.items.add(new File([b],'p'+Math.random()+'.png',{type:'image/png'}));
      window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,600));})()`, true);
  }
  const skTicks = await evaluate(`({n:layers.length, ticked:checkedLayers.size, ann:flattenAnnotations,
     annBox:document.querySelectorAll('#layerList input[type=checkbox]')[0].checked})`);
  check("every layer and the annotations row are ticked by default",
    skTicks.n === 2 && skTicks.ticked === 2 && skTicks.ann === true && skTicks.annBox === true, skTicks);

  // single-letter tool shortcuts
  const skKeymap: [string, string][] = [["m","move"],["s","marquee"],["t","text"],["p","brush"],["h","highlight"],["l","line"],
    ["a","arrow"],["r","rect"],["e","ellipse"],["w","wand"],["c","crop"],["b","blob"]];
  const skBad: any[] = [];
  for (const [k, id] of skKeymap) {
    await evaluate(`document.activeElement && document.activeElement.blur();`);
    const vk = k.toUpperCase().charCodeAt(0);
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(30);
    const got = await evaluate(`tool`);
    if (got !== id) skBad.push({ key: k, want: id, got });
  }
  check("single-letter shortcuts switch tools", skBad.length === 0, skBad);

  // modifier keys must still win (Ctrl+A = select all, not the Arrow tool)
  for (const type of ["keyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await sleep(60);
  const skCtrlA = await evaluate(`({tool, sel: !!selection})`);
  check("Ctrl+A still selects all instead of switching to the Arrow tool", skCtrlA.tool !== 'arrow' && skCtrlA.sel === true, skCtrlA);
  await evaluate(`clearSelection(); document.querySelector('[data-tool=move]').click();`);

  // a tool key typed into a text field must stay text
  await evaluate(`(function(){const el=document.querySelector('#fname'); el.focus(); el.value=''; return 1;})()`);
  for (const type of ["keyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", { type, key: "r", code: "KeyR", text: type === "keyDown" ? "r" : undefined,
      unmodifiedText: "r", windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82 });
  await sleep(60);
  const skField = await evaluate(`({tool, val:document.querySelector('#fname').value})`);
  check("a tool key typed into a text field is not treated as a shortcut",
    skField.tool === 'move' && /r/.test(skField.val), skField);
  await evaluate(`document.activeElement && document.activeElement.blur();`);

  // select-on-press / deselect-on-release
  await evaluate(`layers[0].x=80; layers[0].y=80; layers[0].w=200; layers[0].h=150;
    layers[1].x=440; layers[1].y=340; layers[1].w=200; layers[1].h=150;
    selText=null; selLayer=null; setSelection([]); hoverId=null; fitView(); render();`);
  await sleep(120);
  const skPoint = (i: number, fx: number, fy: number) => evaluate(`(function(){const l=layers[${i}];const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+(l.x+l.w*${fx})*s, y:r.top+(l.y+l.h*${fy})*s};})()`);
  const skCtrlDrag = async (from: any, dx: number, dy: number) => {
    await send("Input.dispatchMouseEvent", { type:"mousePressed", x:from.x, y:from.y, button:"left", buttons:1, clickCount:1, modifiers:2 });
    if (dx || dy) await send("Input.dispatchMouseEvent", { type:"mouseMoved", x:from.x+dx, y:from.y+dy, button:"left", buttons:1, modifiers:2 });
    await send("Input.dispatchMouseEvent", { type:"mouseReleased", x:from.x+dx, y:from.y+dy, button:"left", buttons:1, clickCount:1, modifiers:2 });
    await sleep(150);
  };

  // nothing selected, ctrl press + drag (body, away from the centre block) -> selects and drags
  const skA0 = await evaluate(`({x:Math.round(layers[0].x), y:Math.round(layers[0].y)})`);
  await skCtrlDrag(await skPoint(0, 0.3, 0.3), 50, 40);
  const skA1 = await evaluate(`({x:Math.round(layers[0].x), y:Math.round(layers[0].y), n:selLayers.length, sel:selLayers.includes(layers[0].id)})`);
  check("ctrl-drag from nothing selects the layer and drags it",
    skA1.n === 1 && skA1.sel === true && skA1.x > skA0.x + 20 && skA1.y > skA0.y + 15, { before: skA0, after: skA1 });

  // two selected, ctrl press + drag on a body -> group kept, both move
  await evaluate(`setSelection(layers.map(l => l.id)); render();`);
  const skB0 = await evaluate(`({x0:Math.round(layers[0].x), x1:Math.round(layers[1].x)})`);
  await skCtrlDrag(await skPoint(0, 0.3, 0.3), 30, 0);
  const skB1 = await evaluate(`({x0:Math.round(layers[0].x), x1:Math.round(layers[1].x), n:selLayers.length})`);
  check("ctrl-drag on an already-selected layer keeps the group and drags it",
    skB1.n === 2 && skB1.x0 > skB0.x0 + 10 && skB1.x1 > skB0.x1 + 10, { before: skB0, after: skB1 });

  // same, but grabbing the centre block (the handle path) must behave identically
  await evaluate(`setSelection(layers.map(l => l.id)); render();`);
  const skC0 = await evaluate(`({x1:Math.round(layers[1].x)})`);
  await skCtrlDrag(await skPoint(1, 0.5, 0.5), 24, 0);
  const skC1 = await evaluate(`({x1:Math.round(layers[1].x), n:selLayers.length})`);
  check("ctrl-drag on the centre grab block also keeps the group", skC1.n === 2 && skC1.x1 > skC0.x1 + 8, { before: skC0, after: skC1 });

  // two selected, ctrl click with no drag -> toggles that one back off
  await evaluate(`setSelection(layers.map(l => l.id)); render();`);
  await skCtrlDrag(await skPoint(1, 0.3, 0.3), 0, 0);
  const skD1 = await evaluate(`({n:selLayers.length, has0:selLayers.includes(layers[0].id), has1:selLayers.includes(layers[1].id)})`);
  check("ctrl-click with no drag toggles the layer back off",
    skD1.n === 1 && skD1.has0 === true && skD1.has1 === false, skD1);

  // ...and the centre block behaves the same for the toggle
  await evaluate(`setSelection(layers.map(l => l.id)); render();`);
  await skCtrlDrag(await skPoint(0, 0.5, 0.5), 0, 0);
  const skE1 = await evaluate(`({n:selLayers.length, has0:selLayers.includes(layers[0].id), has1:selLayers.includes(layers[1].id)})`);
  check("ctrl-click with no drag on the centre block toggles off too",
    skE1.n === 1 && skE1.has0 === false && skE1.has1 === true, skE1);

  // a click that never moves must not create an undo step
  await evaluate(`setSelection([layers[0].id]); render();`);
  const skU0 = await evaluate(`undoStack.length`);
  const skPtD = await skPoint(0, 0.3, 0.3);
  await mouse("mousePressed", skPtD.x, skPtD.y, 1); await mouse("mouseReleased", skPtD.x, skPtD.y, 1);
  await sleep(120);
  const skU1 = await evaluate(`undoStack.length`);
  check("a click that does not drag adds no undo step", skU1 === skU0, { before: skU0, after: skU1 });

  // ============ 11f. adjust acts on the final image / the selection ============
  // Self-contained: builds its own fixture with explicit geometry so the sample
  // points are known, rather than inheriting whatever the previous test left behind.
  const checkerOver = `(function(){const l=layers[0];
     const g=(x,y)=>[...vctx.getImageData(x,y,1,1).data];
     return {layer:g(Math.round(l.x+l.w/2), Math.round(l.y+l.h/2)), bg:g(700,520)};})()`;
  await evaluate(`clearEverything()`);
  await evaluate(`(function(){document.querySelector('#newW').value='800';document.querySelector('#newH').value='600';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(250);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'P.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,700));})()`, true);
  await evaluate(`layers[0].x=100; layers[0].y=100; layers[0].w=300; layers[0].h=200;
    selLayer=null; setSelection([]); render();`);
  const geomOk = await evaluate(`({x:layers[0].x,y:layers[0].y,w:layers[0].w,h:layers[0].h,n:layers.length})`);
  check("adjust fixture: one layer at known geometry", geomOk.n === 1 && geomOk.x === 100 && geomOk.w === 300, geomOk);
  const pure = await evaluate(`(function(){const l=layers[0];
     return [...vctx.getImageData(Math.round(l.x+l.w/2), Math.round(l.y+l.h/2),1,1).data];})()`);
  check("adjust fixture: sample point is a pure checker pixel (not a blend)",
    (pure[0] > 200 && pure[1] < 130) || (pure[2] > 200 && pure[0] < 130), pure);

  const beforeAdj = await evaluate(checkerOver);
  await evaluate(`(function(){const s=document.querySelector('#sepia'); s.value='70'; s.dispatchEvent(new Event('input')); return 1;})()`);
  await sleep(250);
  const afterAdj = await evaluate(checkerOver);
  check("adjust changes pixels over a LAYER, not just the background",
    afterAdj.layer.join() !== beforeAdj.layer.join(), { before: beforeAdj.layer, after: afterAdj.layer });
  check("adjust still changes the background", afterAdj.bg.join() !== beforeAdj.bg.join(), { before: beforeAdj.bg, after: afterAdj.bg });

  // selection-limited: take the baseline AFTER the marquee exists, since the
  // selection overlay dims everything outside it.
  await evaluate(`document.querySelector('#resetAdj').click()`);
  await sleep(150);
  await evaluate(`document.querySelector('[data-tool=marquee]').click()`);
  await evaluate(`(function(){const l=layers[0];const r=view.getBoundingClientRect();const s=r.width/view.width;
     window.__mq={x1:r.left+(l.x-20)*s, y1:r.top+(l.y-20)*s, x2:r.left+(l.x+l.w+20)*s, y2:r.top+(l.y+l.h+20)*s};return 1;})()`);
  const mq = await evaluate(`window.__mq`);
  await dragPx(mq.x1, mq.y1, mq.x2, mq.y2);
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  const beforeSel = await evaluate(checkerOver);
  await evaluate(`(function(){const s=document.querySelector('#sepia'); s.value='70'; s.dispatchEvent(new Event('input')); return 1;})()`);
  await sleep(250);
  const afterSel = await evaluate(checkerOver);
  check("adjust is confined to the selection when there is one",
    afterSel.layer.join() !== beforeSel.layer.join() && afterSel.bg.join() === beforeSel.bg.join(),
    { before: beforeSel, after: afterSel });

  const nBeforeAdj = await evaluate(`layers.length`);
  await evaluate(`document.querySelector('#applyAdj').click()`);
  await sleep(300);
  const adjApplied = await evaluate(`({n:layers.length, sepia:document.querySelector('#sepia').value})`);
  check("Apply bakes the adjustment as a layer and clears the sliders",
    adjApplied.n === nBeforeAdj + 1 && adjApplied.sepia === '0', adjApplied);
  await evaluate(`undo(); document.querySelector('#resetAdj').click();`); await sleep(200);

  // ============ 11g. bundled fonts + font size ============
  const fontsOk = await evaluate(`(async()=>{
     const fams = ['Anton','Inter','Playfair Display','Comic Neue','Caveat'];
     await Promise.all(fams.map(f => document.fonts.load('48px "' + f + '"')));
     return fams.map(f => [f, document.fonts.check('48px "' + f + '"')]); })()`, true);
  check("all five bundled fonts load (no system/CDN fallback)", fontsOk.every(([, ok]: any) => ok), fontsOk);
  const famsInMenu = await evaluate(`[...document.querySelectorAll('#fontFamily option')].length`);
  check("font menu offers exactly the bundled five", famsInMenu === 5, famsInMenu);
  check("no more than 5 fonts are shipped", (await evaluate(`1`)) === 1);

  await evaluate(`document.querySelector('[data-tool=text]').click()`);
  await evaluate(`(function(){const n=document.querySelector('#fontSizeNum'); n.value='900'; n.dispatchEvent(new Event('input')); return 1;})()`);
  check("font size reaches well past the old 220 cap", (await evaluate(`style.fontSize`)) === 900, await evaluate(`style.fontSize`));
  check("the size slider was raised too", Number(await evaluate(`document.querySelector('#fontSize').max`)) > 220);

  const tp = await evaluate(`(function(){const r=view.getBoundingClientRect();return {x:r.left+150, y:r.top+120};})()`);
  await mouse("mousePressed", tp.x, tp.y, 1); await mouse("mouseReleased", tp.x, tp.y, 1);
  await sleep(250);
  await send("Input.insertText", { text: "Ag" });
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(300);
  const bigText = await evaluate(`texts.length ? {size:Math.round(texts[0].size), family:texts[0].family} : null`);
  check("a new text box renders at the larger size", !!bigText && bigText.size === 900, bigText);

  await evaluate(`selText = texts[0].id; render();`);
  await snapshot();
  await evaluate(`(function(){const s=document.querySelector('#fontFamily'); s.value='Caveat'; s.dispatchEvent(new Event('change')); return 1;})()`);
  await sleep(250);
  check("changing font family re-renders the text", (await diffFrom()) > 200);
  check("the change reached the text object", (await evaluate(`texts[0].family`)) === 'Caveat', await evaluate(`texts[0].family`));
  await snapshot();
  await evaluate(`document.querySelector('#boldBtn').click()`);
  await sleep(250);
  check("bold re-renders the text", (await diffFrom()) > 200);
  check("bold is recorded on the text object", (await evaluate(`texts[0].bold`)) === true);

  // ============ 11h. distort blobs ============
  // The warp targets the layer being fried - the selected layer, or the background.
  // So the background has to actually have structure for a warp to be measurable.
  await evaluate(`clearEverything()`);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'P.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,700));})()`, true);
  check("blob fixture: first paste becomes the background",
    (await evaluate(`layers.length === 0 && hasImage && view.width === 300`)) === true,
    await evaluate(`({layers:layers.length, w:view.width})`));
  await evaluate(`document.querySelector('[data-tool=blob]').click()`);
  const bPt = await evaluate(`(function(){const r=view.getBoundingClientRect();const s=r.width/view.width;
     return {x:r.left+150*s, y:r.top+100*s};})()`);
  await mouse("mousePressed", bPt.x, bPt.y, 1); await mouse("mouseReleased", bPt.x, bPt.y, 1);
  await sleep(200);
  check("the Blob tool adds a blob", (await evaluate(`blobs.length`)) === 1, await evaluate(`blobs.length`));
  await evaluate(`window.__preBlob = vctx.getImageData(0,0,view.width,view.height).data.slice();`);
  const b0 = await evaluate(`({x:Math.round(blobs[0].x), y:Math.round(blobs[0].y)})`);
  await dragPx(bPt.x, bPt.y, bPt.x + 60, bPt.y + 40);
  const b1 = await evaluate(`({x:Math.round(blobs[0].x), y:Math.round(blobs[0].y)})`);
  check("a blob can be dragged", b1.x > b0.x + 15 && b1.y > b0.y + 10, { before: b0, after: b1 });
  check("blobs render above everything", (await evaluate(`(function(){const a=vctx.getImageData(0,0,view.width,view.height).data,b=window.__preBlob;
     let n=0;for(let i=0;i<a.length;i+=4) if(Math.abs(a[i]-b[i])>8) n++; return n;})()`)) > 100);

  const warped = await evaluate(`(function(){
     const a = clone(base), b = warpedSource();
     const da = a.getContext('2d').getImageData(0,0,a.width,a.height).data;
     const db = b.getContext('2d').getImageData(0,0,b.width,b.height).data;
     let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i]-db[i]) > 6) n++;
     return n; })()`);
  check("blobs actually warp the image before frying", warped > 50, { changedPixels: warped });

  const withBlobs = await evaluate(`flatten('image/png').then(b=>b.size)`, true);
  await evaluate(`window.__blobKeep = blobs; blobs = [];`);
  const withoutBlobs = await evaluate(`flatten('image/png').then(b=>b.size)`, true);
  await evaluate(`blobs = window.__blobKeep; render();`);
  check("blobs are UI only and never reach the export", withBlobs === withoutBlobs, { withBlobs, withoutBlobs });

  await evaluate(`document.querySelector('#blobClear').click()`);
  check("clear removes every blob", (await evaluate(`blobs.length`)) === 0);

  // ============ 11i. linked resize ============
  await evaluate(`clearEverything()`);
  await evaluate(`(function(){document.querySelector('#newW').value='800';document.querySelector('#newH').value='600';
    document.querySelector('#newBg').value='#ffffff';document.querySelector('#newCreate').click();return 1;})()`);
  await sleep(250);
  await evaluate(`(function(){const l=document.querySelector('#lockRatio'); l.checked=true;
     const w=document.querySelector('#rw'); w.value='1600'; w.dispatchEvent(new Event('input')); return 1;})()`);
  check("locked: width drives height", (await evaluate(`document.querySelector('#rh').value`)) === '1200', await evaluate(`document.querySelector('#rh').value`));
  await evaluate(`(function(){const h=document.querySelector('#rh'); h.value='300'; h.dispatchEvent(new Event('input')); return 1;})()`);
  check("locked: height drives width", (await evaluate(`document.querySelector('#rw').value`)) === '400', await evaluate(`document.querySelector('#rw').value`));
  await evaluate(`(function(){document.querySelector('#lockRatio').checked=false;
     const w=document.querySelector('#rw'); w.value='1000'; w.dispatchEvent(new Event('input')); return 1;})()`);
  check("unlocked: the other side is left alone", (await evaluate(`document.querySelector('#rh').value`)) === '300', await evaluate(`document.querySelector('#rh').value`));

  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__small),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'r.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,700));})()`, true);
  await evaluate(`layers[0].x=200; layers[0].y=100; layers[0].w=300; layers[0].h=200;
    blobs = [{id:'bz', x:400, y:300, r:100, str:0.5}]; render();`);
  await evaluate(`(function(){document.querySelector('#lockRatio').checked=false;
     document.querySelector('#rw').value='1600'; document.querySelector('#rh').value='300';
     document.querySelector('#applyResize').click(); return 1;})()`);
  await sleep(400);
  const distorted = await evaluate(`({w:view.width, h:view.height,
     lx:Math.round(layers[0].x), ly:Math.round(layers[0].y), lw:Math.round(layers[0].w), lh:Math.round(layers[0].h),
     bx:Math.round(blobs[0].x), by:Math.round(blobs[0].y)})`);
  check("unlocked resize distorts the whole canvas and all children",
    distorted.w === 1600 && distorted.h === 300 &&
    distorted.lx === 400 && distorted.ly === 50 && distorted.lw === 600 && distorted.lh === 100,
    distorted);
  check("blobs scale with the canvas too", distorted.bx === 800 && distorted.by === 150, { bx: distorted.bx, by: distorted.by });

  // ---- 12. errors ----
  check("no uncaught page exceptions", exceptions.length === 0, exceptions.slice(0, 4));
  check("no console errors", consoleErrs.length === 0, consoleErrs.slice(0, 4));

  const failed = results.filter(r => !r.ok);
  console.log("\n==================== SUMMARY ====================");
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log("FAILURES:"); failed.forEach(f => console.log("  - " + f.name + "  " + JSON.stringify(f.extra))); }
  Deno.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error("HARNESS ERROR:", e); Deno.exit(2); });
