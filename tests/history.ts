// Undo/redo history suite: the contract every operation must keep.
//
// The editor's history is copy-on-write: a snapshot keeps *references* to the pixel
// surfaces (background, overlay, each layer) and copies a surface only at the moment
// an operation writes into it in place. This file pins down what that must guarantee,
// independently of how a snapshot is stored:
//
//   * undo/redo restore pixels EXACTLY (not "close enough"),
//   * one user gesture == one history entry,
//   * a new edit discards the redo trail,
//   * in-place edits on different surfaces never corrupt each other's older states,
//   * structural operations (crop / rotate / flip / resize / flatten / new layer)
//     undo back to the same document,
//   * history stays bounded.
//
// Run with: tests/run.sh tests/history.ts   (or tests/run.sh for everything).
const PORT = 9222;
const PAGE_URL = "http://localhost:3100/";
const FIX = Deno.env.get("EASYEDIT_FIXTURES") || "/tmp";
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
function group(title: string) { console.log(`\n---- ${title} ----`); }

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

// ---- page-side probes -------------------------------------------------------------------
// A snapshot signature of every pixel surface, so "restored exactly" is one comparison.
// FNV over all four channels - alpha matters (the wand clears to transparent).
const PROBES = `
  window.__h = c => { const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let h = 2166136261; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); } return h >>> 0; };
  window.__px = (c,x,y) => [...c.getContext('2d').getImageData(x,y,1,1).data];
  window.__doc = () => { let s = window.__h(base)+'/'+window.__h(overlay); for (const l of layers) s += '/'+window.__h(l.c); return s; };
  true;`;
const baseHash = () => evaluate(`window.__h(base)`);
const docHash = () => evaluate(`window.__doc()`);
const alphaAt = (x: number, y: number) => evaluate(`window.__px(base,${x},${y})[3]`);
const stack = () => evaluate(`({u:undoStack.length, r:redoStack.length})`);
const btnState = () => evaluate(`({u:document.querySelector('#undoBtn').disabled, r:document.querySelector('#redoBtn').disabled})`);

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

  const raw = new Uint8Array(await Deno.readFile(`${FIX}/edtest.png`));
  let bin = ""; for (let i = 0; i < raw.length; i += 8192) bin += String.fromCharCode(...raw.subarray(i, i + 8192));
  const pngB64 = btoa(bin);

  await send("Page.navigate", { url: PAGE_URL });
  for (let i = 0; i < 40; i++) { await sleep(100); if (await evaluate("document.readyState") === "complete") break; }
  await sleep(400);
  await evaluate(PROBES);
  await evaluate(`window.__png='${pngB64}'`);

  // Deterministic setup: decode the fixture and hand it straight to loadSource.
  const loadFixture = async () => {
    await evaluate(`(async()=>{ const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
      const bmp=await createImageBitmap(new Blob([b],{type:'image/png'}));
      loadSource(bmp, bmp.width, bmp.height); if (bmp.close) bmp.close(); })()`, true);
    await sleep(150);
  };
  // A two-tone layer at the origin, so a wand hit clears exactly one half.
  // Inserted through commitPre like addLayer, so adding it is itself an undo step.
  const addTwoToneLayer = async () => {
    await evaluate(`(function(){ const pre=snapshot(); const c=canvas(400,300), x=c.getContext('2d');
      x.fillStyle='#2244ff'; x.fillRect(0,0,200,300);
      x.fillStyle='#22bb44'; x.fillRect(200,0,200,300);
      const l={id:uid(),c,x:0,y:0,w:400,h:300}; layers.push(l); checkedLayers.add(l.id); setSelection([l.id]);
      updateLayerUI(); render(); commitPre(pre); return 1; })()`);
  };

  await loadFixture();
  check("fixture is loaded and history starts empty", (await evaluate(`hasImage && view.width===1600`)) === true && (await stack()).u === 0,
    { dims: await evaluate(`view.width+'x'+view.height`), stack: await stack() });

  // ============ 1. raster edits: undo/redo are pixel-exact ============
  group("raster edits are pixel-exact");
  const h0 = await baseHash();
  await evaluate(`doWand({x:200,y:200})`); await sleep(150);
  const h1 = await baseHash();
  check("a wand fill changes the pixels", h1 !== h0);
  check("the wand made the hit pixel transparent", (await alphaAt(200, 200)) === 0);
  check("the wand left the rest of the image opaque", (await alphaAt(1400, 1000)) === 255);

  await evaluate(`undo()`); await sleep(150);
  check("undo restores the exact pixels (hash match)", (await baseHash()) === h0, { before: h0, after: await baseHash() });
  check("undo restores alpha exactly", (await alphaAt(200, 200)) === 255);

  await evaluate(`redo()`); await sleep(150);
  check("redo restores the exact edited pixels (hash match)", (await baseHash()) === h1);
  check("redo restores alpha exactly", (await alphaAt(200, 200)) === 0);
  await evaluate(`undo()`); await sleep(150);
  check("a second undo is pixel-exact again", (await baseHash()) === h0);

  // ============ 2. a stack of in-place edits rewinds and replays exactly ============
  group("LIFO stack of in-place edits");
  await loadFixture();
  const s0 = await baseHash();
  await evaluate(`doWand({x:200,y:200})`); await sleep(150); const s1 = await baseHash();
  await evaluate(`doWand({x:1400,y:200})`); await sleep(150); const s2 = await baseHash();
  await evaluate(`doWand({x:200,y:1000})`); await sleep(150); const s3 = await baseHash();
  check("three wand edits produce three distinct states", new Set([s0, s1, s2, s3]).size === 4, { s0, s1, s2, s3 });
  check("three edits produced three history entries", (await stack()).u === 3, await stack());

  await evaluate(`undo()`); await sleep(120);
  check("undo 1 returns the state before the third edit", (await baseHash()) === s2);
  await evaluate(`undo()`); await sleep(120);
  check("undo 2 returns the state before the second edit", (await baseHash()) === s1);
  await evaluate(`undo()`); await sleep(120);
  check("undo 3 returns the pristine image", (await baseHash()) === s0);
  await evaluate(`redo()`); await sleep(120);
  check("redo 1 replays the first edit exactly", (await baseHash()) === s1);
  await evaluate(`redo()`); await sleep(120); await evaluate(`redo()`); await sleep(120);
  check("redo 3 replays back to the newest state exactly", (await baseHash()) === s3);

  // ============ 3. in-place edits on different surfaces are independent ============
  group("per-surface isolation");
  await loadFixture();
  const bg0 = await baseHash();
  await addTwoToneLayer();                                        // history entry 1: the layer appears
  const lh0 = await evaluate(`window.__h(layers[0].c)`);
  await evaluate(`selLayer=null; selLayers=[]; updateLayerUI();`); // edit the background, not the layer
  await evaluate(`doWand({x:200,y:200})`); await sleep(150);       // entry 2: base is modified
  const bg1 = await baseHash();
  await evaluate(`selLayer=layers[0].id; selLayers=[layers[0].id]; updateLayerUI();`);
  await evaluate(`doWand({x:100,y:150})`); await sleep(150);        // entry 3: the layer is modified
  const lh1 = await evaluate(`window.__h(layers[0].c)`);
  check("editing the background did not touch the layer", lh1 !== lh0 && (await baseHash()) === bg1);
  check("three edits produced three entries", (await stack()).u === 3, await stack());

  await evaluate(`undo()`); await sleep(150);
  check("undo reverts the layer edit exactly", (await evaluate(`window.__h(layers[0].c)`)) === lh0);
  check("undo of the layer edit leaves the background alone", (await baseHash()) === bg1);
  await evaluate(`undo()`); await sleep(150);
  check("the next undo reverts the background edit exactly", (await baseHash()) === bg0);
  check("and the layer keeps its original pixels", (await evaluate(`window.__h(layers[0].c)`)) === lh0);
  await evaluate(`undo()`); await sleep(150);
  check("a third undo removes the layer again", (await evaluate(`layers.length`)) === 0);
  await evaluate(`redo(); redo(); redo();`); await sleep(250);
  check("redoing all three brings back both edits exactly", (await baseHash()) === bg1 && (await evaluate(`window.__h(layers[0].c)`)) === lh1,
    { base: await baseHash(), bg1, layer: await evaluate(`window.__h(layers[0].c)`), lh1 });

  // ============ 4. a snapshot is immune to later in-place writes ============
  group("snapshots are immutable once taken");
  await loadFixture();
  const pre = await evaluate(`window.__preSnap = snapshot(); window.__h(base)`);
  await evaluate(`doWand({x:200,y:200})`); await sleep(150);
  const live = await baseHash();
  await evaluate(`restore(window.__preSnap); window.__preSnap = null;`); await sleep(150);
  check("restoring an old snapshot gives back the old pixels", (await baseHash()) === pre, { pre, live, restored: await baseHash() });

  // ============ 5. one gesture == one entry ============
  group("gesture collapsing");
  await loadFixture();
  const g0 = await stack();
  await evaluate(`(function(){ const l={id:uid(),c:canvas(100,100),x:10,y:10,w:100,h:100};
      l.c.getContext('2d').fillStyle='#fff'; l.c.getContext('2d').fillRect(0,0,100,100);
      layers.push(l); selLayer=l.id; selLayers=[l.id]; updateLayerUI(); render(); return 1; })()`);
  await evaluate(`(function(){ beginGesture(); layers[0].x=300; layers[0].y=250; render(); commitGesture(true); return 1; })()`);
  check("a whole drag is one undo entry", (await stack()).u === g0.u + 1, { before: g0, after: await stack() });
  await evaluate(`undo()`); await sleep(120);
  check("undoing the drag restores the start position", (await evaluate(`Math.round(layers[0].x)+','+Math.round(layers[0].y)`)) === '10,10',
    await evaluate(`layers[0].x+','+layers[0].y`));

  await evaluate(`(function(){ beginGesture(); layers[0].x=90; layers[0].y=90; render(); commitGesture(false); return 1; })()`);
  check("an uncommitted gesture adds no entry", (await stack()).u === g0.u, await stack());

  // Real pointer input: drawing a shape then moving it is one entry for the move.
  await loadFixture();
  const r = await evaluate(`view.getBoundingClientRect().toJSON()`);
  await evaluate(`document.querySelector('[data-tool=brush]').click()`);
  await dragPx(r.left + r.width * 0.3, r.top + r.height * 0.3, r.left + r.width * 0.45, r.top + r.height * 0.45);
  const afterDraw = (await stack()).u;
  await evaluate(`document.querySelector('[data-tool=move]').click()`);
  await dragPx(r.left + r.width * 0.35, r.top + r.height * 0.35, r.left + r.width * 0.5, r.top + r.height * 0.5);
  const afterMove = (await stack()).u;
  check("a real pointer drag adds exactly one entry", afterMove === afterDraw + 1, { afterDraw, afterMove });
  await evaluate(`undo()`); await sleep(120);
  check("undoing the drag keeps the stroke but moves it back", (await evaluate(`shapes.length`)) === 1, await evaluate(`shapes.length`));

  // ============ 6. a new edit discards the redo trail ============
  group("redo trail invalidation");
  await loadFixture();
  await evaluate(`doWand({x:200,y:200})`); await sleep(120);
  await evaluate(`undo()`); await sleep(120);
  check("undo populates the redo stack", (await stack()).r === 1, await stack());
  check("the redo button is enabled after an undo", (await btnState()).r === false);
  await evaluate(`doWand({x:1400,y:1000})`); await sleep(120);
  check("a new edit empties the redo stack", (await stack()).r === 0, await stack());
  check("the redo button is disabled again", (await btnState()).r === true);

  // ============ 7. structural operations undo exactly ============
  group("structural operations");
  await loadFixture();
  const before = await baseHash();

  await evaluate(`crop = {x:100,y:100,w:600,h:400}; applyCrop();`); await sleep(200);
  check("crop changed the document size", (await evaluate(`view.width+'x'+view.height`)) === '600x400', await evaluate(`view.width+'x'+view.height`));
  await evaluate(`undo()`); await sleep(200);
  check("undo of crop restores the size", (await evaluate(`view.width+'x'+view.height`)) === '1600x1200');
  check("undo of crop restores the pixels exactly", (await baseHash()) === before, { before, after: await baseHash() });
  await evaluate(`redo()`); await sleep(150);
  check("redo of crop returns the cropped size", (await evaluate(`view.width`)) === 600);
  await evaluate(`undo()`); await sleep(150);

  await loadFixture();
  const preRot = await docHash();
  await evaluate(`rotate(90)`); await sleep(200);
  check("rotate turns the canvas on its side", (await evaluate(`view.width+'x'+view.height`)) === '1200x1600', await evaluate(`view.width+'x'+view.height`));
  await evaluate(`undo()`); await sleep(200);
  check("undo of rotate restores the document exactly", (await docHash()) === preRot && (await evaluate(`view.width`)) === 1600,
    { pre: preRot, post: await docHash() });

  await loadFixture();
  const preFlip = await docHash();
  await evaluate(`flip('h')`); await sleep(200);
  check("flip changes the pixels", (await docHash()) !== preFlip);
  await evaluate(`undo()`); await sleep(200);
  check("undo of flip restores the document exactly", (await docHash()) === preFlip, { pre: preFlip, post: await docHash() });

  await loadFixture();
  const preResize = await docHash();
  await evaluate(`resizeAll(800,600)`); await sleep(200);
  check("resize scales the document", (await evaluate(`view.width`)) === 800);
  await evaluate(`undo()`); await sleep(200);
  check("undo of resize restores the document exactly", (await docHash()) === preResize && (await evaluate(`view.width`)) === 1600,
    { pre: preResize, post: await docHash() });

  // New layer via an effect, then undo removes it and leaves the base alone.
  await loadFixture();
  const preFx = await docHash();
  const preLayers = await evaluate(`layers.length`);
  await evaluate(`document.querySelector('[data-tool=marquee]').click(); selection={x:200,y:200,w:400,h:300}; updateSelInfo();
    fx.block=20; applyPixelate();`); await sleep(300);
  check("an effect lands as a new layer", (await evaluate(`layers.length`)) === preLayers + 1);
  await evaluate(`undo()`); await sleep(250);
  check("undo of the effect removes the layer", (await evaluate(`layers.length`)) === preLayers);
  check("undo of the effect restores the document exactly", (await docHash()) === preFx, { pre: preFx, post: await docHash() });

  // Flatten bakes layers into the background and is undoable back to the same doc.
  await loadFixture();
  await addTwoToneLayer();
  const flatPre = await docHash();
  const flatLayers = await evaluate(`layers.length`);
  await evaluate(`checkedLayers = new Set(layers.map(l=>l.id)); flattenAnnotations = false; flattenChecked();`); await sleep(250);
  check("flatten folds the layer into the background", (await evaluate(`layers.length`)) === flatLayers - 1);
  await evaluate(`undo()`); await sleep(250);
  check("undo of flatten brings the layer back", (await evaluate(`layers.length`)) === flatLayers);
  check("undo of flatten restores the document exactly", (await docHash()) === flatPre, { pre: flatPre, post: await docHash() });

  // A text box baked into the overlay (rotate bakes texts) must undo exactly.
  await loadFixture();
  await evaluate(`texts.push({id:'t1',x:300,y:300,text:'HELLO',color:'#ff0000',size:120,family:'Anton',bold:false,italic:false,
    opacity:1,bg:null,bgOpacity:0.8,pad:14,radius:10}); updateLayerUI(); render();`); await sleep(150);
  const withText = await docHash();
  await evaluate(`rotate(180)`); await sleep(250);
  await evaluate(`undo()`); await sleep(250);
  check("a text baked by rotate is reverted by undo", (await evaluate(`texts.length`)) === 1 && (await docHash()) === withText,
    { texts: await evaluate(`texts.length`), pre: withText, post: await docHash() });

  // ============ 8. history stays bounded ============
  group("bounded history");
  await loadFixture();
  // Cheap metadata edits: push an entry, nudge a layer. These cost almost no memory.
  await evaluate(`(function(){ const l={id:uid(),c:canvas(64,64),x:0,y:0,w:64,h:64}; layers.push(l); selLayer=l.id; selLayers=[l.id]; updateLayerUI(); return 1; })()`);
  const pushCount = 40;
  await evaluate(`(function(){ for (let i=0;i<${pushCount};i++){ beginGesture(); layers[0].x=i; render(); commitGesture(true); } return 1; })()`);
  const deep = await stack();
  check("history does not grow without bound", deep.u <= (await evaluate(`MAX_UNDO`)), { depth: deep.u, cap: await evaluate(`MAX_UNDO`) });
  check("history keeps the most recent entries (the newest is undoable)", (await evaluate(`(()=>{ undo(); return Math.round(layers[0].x); })()`)) === pushCount - 2,
    await evaluate(`Math.round(layers[0].x)`));

  // ============ 9. no page errors ============
  check("no uncaught page exceptions", exceptions.length === 0, exceptions.slice(0, 4));
  check("no console errors", consoleErrs.length === 0, consoleErrs.slice(0, 4));

  const failed = results.filter(r => !r.ok);
  console.log("\n==================== HISTORY SUMMARY ====================");
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log("FAILURES:"); failed.forEach(f => console.log("  - " + f.name + "  " + JSON.stringify(f.extra))); }
  Deno.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error("HARNESS ERROR:", e); Deno.exit(2); });
