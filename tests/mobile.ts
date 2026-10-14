// Mobile shell suite: drives mobile.html on a phone viewport with real touch input.
//
// The phone UI is a *separate HTML shell* (mobile.html + mobile.css) that shares app.js with the
// desktop shell, so this file tests the phone layout and gestures, while e2e.ts covers the editor
// behaviour on desktop. Run with: tests/run.sh tests/mobile.ts (or just tests/run.sh for both).
const PORT = 9222;
const BASE = "http://localhost:3100/";
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
async function shot(path: string) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(path, b64(r.data));
}
async function touchDrag(x1: number, y1: number, x2: number, y2: number, steps = 10) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
  for (let i = 1; i <= steps; i++)
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(160);
}
async function tap(x: number, y: number) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(280);
}
async function pinch(a1: any, b1: any, a2: any, b2: any, steps = 8) {
  const tp = (a: any, b: any) => [{ x: a.x, y: a.y, id: 1 }, { x: b.x, y: b.y, id: 2 }];
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(a1, b1) });
  for (let i = 1; i <= steps; i++)
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(
      { x: a1.x + (a2.x - a1.x) * i / steps, y: a1.y + (a2.y - a1.y) * i / steps },
      { x: b1.x + (b2.x - b1.x) * i / steps, y: b1.y + (b2.y - b1.y) * i / steps }) });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(220);
}
async function goto(url: string, ms = 6000) {
  await send("Page.navigate", { url });
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(120);
    if (await evaluate(`document.readyState`) === "complete") { await sleep(350); return; }
  }
}
async function waitForPath(want: string, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await evaluate(`location.pathname`)) === want) return true;
    await sleep(120);
  }
  return false;
}

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
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/dl", eventsEnabled: true }).catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  // ---- 1. a phone hitting the desktop URL lands on the mobile shell ----
  await goto(BASE);
  check("a phone is redirected from / to mobile.html", await waitForPath("/mobile.html"), await evaluate(`location.pathname`));

  await goto(BASE + "?desktop=1");
  check("?desktop=1 opts out of the redirect", (await evaluate(`location.pathname`)) === "/" && (await evaluate(`document.body.dataset.shell`)) === "desktop",
    await evaluate(`({path:location.pathname, shell:document.body.dataset.shell})`));

  await goto(BASE + "mobile.html");
  await sleep(400);

  // ---- 2. shell shape ----
  const shell = await evaluate(`({
     shell:document.body.dataset.shell,
     hasTopbar:!!document.querySelector('#topbar'),
     hasDesktopHeader:!!document.querySelector('#bar') || !!document.querySelector('#annBar'),
     hasDock:!!document.querySelector('#dock'),
     top:document.querySelectorAll('#tools [data-tool]').length,
     ann:document.querySelectorAll('#annTools [data-tool]').length,
     iconOnly:getComputedStyle(document.querySelector('#tools [data-tool] .tl')).display === 'none'
       && getComputedStyle(document.querySelector('#tools [data-tool] .k')).display === 'none'
       && getComputedStyle(document.querySelector('#undoBtn .ai')).display !== 'none',
     btnH:document.querySelector('#undoBtn').getBoundingClientRect().height,
     toolW:document.querySelector('#tools [data-tool]').getBoundingClientRect().width,
     scrollable:document.documentElement.scrollHeight > window.innerHeight + 1,
     deskLink:!!document.querySelector('#deskLink'), zoomHud:!!document.querySelector('#zoomHud'), tool:tool,
     manifest:!!document.querySelector('link[rel=manifest]'),
     hint:document.querySelector('#hint').textContent.trim()})`);
  check("body advertises the mobile shell", shell.shell === "mobile", shell.shell);
  check("phone shell has a topbar and a dock, no desktop header",
    shell.hasTopbar === true && shell.hasDesktopHeader === false && shell.hasDock === true, shell);
  check("dock holds the 5 global + 7 annotation tools", shell.top === 5 && shell.ann === 7, { top: shell.top, ann: shell.ann });
  check("header buttons are icon-only on the phone", shell.iconOnly === true, shell);
  check("touch targets are >= 44px", shell.btnH >= 44 && shell.toolW >= 44, { h: shell.btnH, w: shell.toolW });
  check("the page itself cannot scroll", shell.scrollable === false);
  check("the empty hint is phone-appropriate", /choose a photo/i.test(shell.hint), shell.hint);
  check("the phone drops the desktop link and the zoom HUD", shell.deskLink === false && shell.zoomHud === false, shell);
  check("the phone opens on the Pen tool", shell.tool === "brush", shell.tool);
  check("the mobile shell is installable too", shell.manifest === true, shell.manifest);
  await shot("/tmp/mo-1-empty.png");

  // ---- 3. sheet geometry ----
  const closed = await evaluate(`({open:document.querySelector('#panel').classList.contains('open'),
     top:Math.round(document.querySelector('#panel').getBoundingClientRect().top), vh:window.innerHeight})`);
  check("the sheet starts closed and off-screen", closed.open === false && closed.top >= closed.vh, closed);

  await evaluate(`document.querySelector('#sheetToggle').click()`); await sleep(500);
  const opened = await evaluate(`({open:document.querySelector('#panel').classList.contains('open'),
     panelBottom:Math.round(document.querySelector('#panel').getBoundingClientRect().bottom),
     dockTop:Math.round(document.querySelector('#dock').getBoundingClientRect().top),
     dockVisible:document.querySelector('#dock').getBoundingClientRect().bottom <= window.innerHeight + 1})`);
  check("Controls opens the sheet", opened.open === true);
  check("the open sheet sits exactly above the dock",
    Math.abs(opened.panelBottom - opened.dockTop) <= 2, opened);
  check("the dock stays visible while the sheet is open", opened.dockVisible === true);
  await shot("/tmp/mo-2-sheet.png");

  const sheetUi = await evaluate(`({inputFont:parseFloat(getComputedStyle(document.querySelector('#fname')).fontSize),
     noteHidden:getComputedStyle(document.querySelector('#panel .note')).display === 'none',
     exportInSheet:!!document.querySelector('#panel #exportFooter'),
     tabs:[...document.querySelectorAll('#tabs .tab')].map(t=>t.dataset.tab).join()})`);
  check("sheet inputs are 16px (no iOS zoom-on-focus)", sheetUi.inputFont >= 16, sheetUi);
  check("explainer notes are hidden on the phone", sheetUi.noteHidden === true);
  check("the export footer lives in the sheet", sheetUi.exportInSheet === true);
  check("the sheet keeps the Tool/Layers/Image tabs", sheetUi.tabs === "tool,layers,image", sheetUi.tabs);

  await evaluate(`document.querySelector('#backdrop').click()`); await sleep(450);
  check("the backdrop closes the sheet", (await evaluate(`document.querySelector('#panel').classList.contains('open')`)) === false);

  // ---- 3b. the options rail: non-modal quick controls pinned above the dock ----
  const rail0 = await evaluate(`(()=>{const r=document.querySelector('#rail');return {
     exists:!!r, ids:[...r.children].map(c=>c.id), visible:getComputedStyle(r).display!=='none',
     aboveRows:Math.round(r.getBoundingClientRect().bottom)<=Math.round(document.querySelector('#tools').getBoundingClientRect().top)+1,
     backdrop:document.querySelector('#backdrop').classList.contains('show')}})()`);
  check("the options rail exists above the dock's tool rows", rail0.exists && rail0.visible && rail0.aboveRows, rail0);
  check("the rail starts on the Pen's style controls", rail0.ids.join() === "colorRow,widthRow,opacityRow,fillRow", rail0.ids);
  check("the rail is non-modal (no backdrop shown)", rail0.backdrop === false);

  const wdef = await evaluate(`({w:document.querySelector('#width').value, out:document.querySelector('#widthOut').textContent, sw:style.width})`);
  check("mobile starts with a 16px stroke", wdef.w === "16" && wdef.out === "16" && wdef.sw === 16, wdef);

  await evaluate(`document.querySelector('[data-tool=brush]').click()`); await sleep(250);
  const railBrush = await evaluate(`[...document.querySelector('#rail').children].map(c=>c.id).join()`);
  check("picking Pen swaps the rail to its style controls", railBrush === "colorRow,widthRow,opacityRow,fillRow", railBrush);

  await evaluate(`document.querySelector('[data-tool=text]').click()`); await sleep(250);
  const railText = await evaluate(`({ids:[...document.querySelector('#rail').children].map(c=>c.id).join(),
     styleHidden:document.querySelector('#styleSec').hidden, fontShown:document.querySelector('#fontRow').style.display!=='none'})`);
  check("Text puts colour + size + bold/italic in the rail", railText.ids === "colorRow,fontSizeRow,boldItalicRow", railText);
  check("Text keeps its font/background block in the sheet", railText.styleHidden === false && railText.fontShown === true, railText);

  await evaluate(`document.querySelector('[data-tool=wand]').click()`); await sleep(250);
  const railWand = await evaluate(`[...document.querySelector('#rail').children].map(c=>c.id).join()`);
  check("the Wand puts colour + tolerance + transparent in the rail", railWand === "wandColorRow,tolRow,wandTransRow", railWand);
  await shot("/tmp/mo-2b-rail.png");

  await evaluate(`document.querySelector('[data-tool=marquee]').click()`); await sleep(250);
  const railSel = await evaluate(`[...document.querySelector('#rail').children].map(c=>c.id).join()`);
  check("the Select rail leads with Clone, then the pixelate/blur/remove-bg controls",
    railSel === "cloneBtn,selOpsRow,fxPixelRow,fxPixelBtn,fxBlurRow,fxBlurBtn,bgBtn", railSel);

  await evaluate(`document.querySelector('[data-tool=move]').click()`); await sleep(200);
  const raw = new Uint8Array(await Deno.readFile(`${FIX}/edtest.png`));
  let bin = ""; for (let i = 0; i < raw.length; i += 8192) bin += String.fromCharCode(...raw.subarray(i, i + 8192));
  await evaluate(`window.__png='${btoa(bin)}'`);
  await evaluate(`(async()=>{const b=Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0));
    const dt=new DataTransfer(); dt.items.add(new File([b],'t.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,900));})()`, true);
  await sleep(400);
  check("an image loads in the mobile shell", (await evaluate(`hasImage && view.width`)) === 1600, await evaluate(`view.width`));

  await evaluate(`document.querySelector('[data-tool=brush]').click()`); await sleep(300);
  check("picking a tool switches the sheet to the Tool tab",
    (await evaluate(`document.querySelector('#tabs .tab.on').dataset.tab`)) === "tool");
  const view = await evaluate(`view.getBoundingClientRect().toJSON()`);
  await evaluate(`(()=>{window.__snap=vctx.getImageData(0,0,view.width,view.height).data.slice();return 1;})()`);
  await touchDrag(view.left + view.width * 0.25, view.top + view.height * 0.25, view.left + view.width * 0.7, view.top + view.height * 0.6);
  const drew = await evaluate(`(()=>{const a=vctx.getImageData(0,0,view.width,view.height).data,b=window.__snap;let n=0;
     for(let i=0;i<a.length;i+=4){if(Math.abs(a[i]-b[i])>12||Math.abs(a[i+1]-b[i+1])>12||Math.abs(a[i+2]-b[i+2])>12)n++;}return n;})()`);
  check("a one-finger drag draws with the active tool", drew > 300, { changed: drew });
  // The stroke is selected (so the rail's Width/Colour apply to it) but must show no handles.
  const penChrome = await evaluate(`(function(){const s=shapes[shapes.length-1], z=zoom, d=chromeDpr;
     const c=shapeHandlePoints(s).c, X=Math.round((c[0]*z+pan.x)*d), Y=Math.round((c[1]*z+pan.y)*d);
     const img=cctx.getImageData(X-2,Y-2,5,5).data; let n=0;
     for(let i=0;i<img.length;i+=4) if(img[i]>235&&img[i+1]>235&&img[i+2]>235) n++;
     return {selected:selShape===s.id, grip:n};})()`);
  check("a drawing tool shows no handles for the stroke it just drew",
    penChrome.selected === true && penChrome.grip === 0, penChrome);
  await shot("/tmp/mo-3-draw.png");
  await evaluate(`undo()`); await sleep(200);

  // text: tap the canvas -> an inline editor big enough to type in
  await evaluate(`document.querySelector('[data-tool=text]').click()`); await sleep(300);
  await tap(view.left + view.width * 0.15, view.top + view.height * 0.35);
  const ed = await evaluate(`(function(){const t=document.querySelector('textarea.textinput');if(!t)return null;
     const b=t.getBoundingClientRect();return {w:Math.round(b.width),h:Math.round(b.height),font:parseFloat(getComputedStyle(t).fontSize)};})()`);
  check("tapping with the Text tool opens a legible inline editor",
    !!ed && ed.font >= 16 && ed.h >= 20, ed);
  if (ed) { await send("Input.insertText", { text: "Hi" }); await sleep(250); }
  await evaluate(`(function(){const t=document.querySelector('textarea.textinput'); if(t) t.blur(); return 1;})()`);
  await sleep(350);
  check("the typed text is committed", (await evaluate(`texts.length`)) === 1, await evaluate(`texts.length`));
  // iOS/Orion only raise the keyboard when focus() runs inside the tap, never from a timer.
  const syncFocus = await evaluate(`(function(){createTextBox({x:80,y:80});
     const ta=document.querySelector('textarea.textinput');
     const ok = !!ta && document.activeElement === ta;
     if (ta) ta.blur();
     return ok;})()`);
  check("the text editor focuses synchronously (so iOS raises the keyboard)", syncFocus === true, syncFocus);

  // Tapping existing text in Text mode re-opens the editor rather than dragging it (Move does that).
  await evaluate(`document.querySelector('[data-tool=text]').click()`); await sleep(150);
  const tb = await evaluate(`(function(){const b=textRect(texts[0]), r=view.getBoundingClientRect(), s=r.width/view.width;
     return {x:r.left+(b.x+b.w/2)*s, y:r.top+(b.y+b.h/2)*s};})()`);
  await tap(tb.x, tb.y);
  const reedit = await evaluate(`({editor:!!document.querySelector('textarea.textinput'), n:texts.length})`);
  check("tapping existing text in Text mode re-opens the editor", reedit.editor === true && reedit.n === 1, reedit);
  await evaluate(`(function(){const ta=document.querySelector('textarea.textinput'); if(ta) ta.blur();})()`);
  await sleep(200);

  // ---- 5. two-finger navigation ----
  await evaluate(`document.querySelector('[data-tool=brush]').click(); clearShapeSel(); shapes=[]; updateLayerUI(); render();`);
  await sleep(200);
  const nav0 = await evaluate(`({zoom, pan:{...pan}, shapes:shapes.length})`);
  await pinch({ x: 150, y: 430 }, { x: 240, y: 430 }, { x: 90, y: 430 }, { x: 300, y: 430 });
  const nav1 = await evaluate(`({zoom, pan:{...pan}, shapes:shapes.length})`);
  check("two-finger pinch zooms the canvas", nav1.zoom > nav0.zoom * 1.5, { before: nav0.zoom, after: nav1.zoom });
  check("a pinch never draws", nav1.shapes === nav0.shapes, { before: nav0.shapes, after: nav1.shapes });

  await pinch({ x: 150, y: 430 }, { x: 250, y: 430 }, { x: 210, y: 470 }, { x: 310, y: 470 });
  const nav2 = await evaluate(`({zoom, pan:{...pan}, shapes:shapes.length})`);
  check("two-finger drag pans without zooming",
    Math.abs(nav2.zoom - nav1.zoom) < 1e-6 && Math.abs(nav2.pan.x - nav1.pan.x) > 20 && Math.abs(nav2.pan.y - nav1.pan.y) > 20,
    { dz: nav2.zoom - nav1.zoom, dx: Math.round(nav2.pan.x - nav1.pan.x), dy: Math.round(nav2.pan.y - nav1.pan.y) });
  await evaluate(`fitView()`); await sleep(300);

  // ---- 6. crop by touch ----
  await evaluate(`document.querySelector('[data-tool=crop]').click()`); await sleep(250);
  const v2 = await evaluate(`view.getBoundingClientRect().toJSON()`);
  await touchDrag(v2.left + v2.width * 0.25, v2.top + v2.height * 0.25, v2.left + v2.width * 0.6, v2.top + v2.height * 0.6);
  const cm = await evaluate(`({...crop})`);
  check("touch creates a crop selection", cm.w > 50 && cm.h > 50, cm);
  await evaluate(`cancelCrop()`);

  // ---- 6b. Clone lifts the selection into its own layer, ready for Move ----
  await evaluate(`document.querySelector('[data-tool=marquee]').click()`); await sleep(200);
  await evaluate(`selection = { x:400, y:300, w:300, h:200 }; updateSelInfo(); render();`);
  const nBefore = await evaluate(`layers.length`);
  await evaluate(`document.querySelector('#cloneBtn').click()`); await sleep(300);
  const cloned = await evaluate(`(function(){const l=layers[layers.length-1];
     const c=l.c.getContext('2d').getImageData(0,0,l.w,l.h).data; let n=0;
     for(let i=3;i<c.length;i+=4*97) if(c[i]>0) n++;
     return {n:layers.length, x:l.x, y:l.y, w:l.w, h:l.h, sel:selLayer===l.id, painted:n};})()`);
  check("Clone drops the selection into its own layer at the same spot",
    cloned.n === nBefore + 1 && cloned.x === 400 && cloned.y === 300 && cloned.w === 300 && cloned.h === 200
    && cloned.sel === true && cloned.painted > 0, cloned);

  // ---- 6c. the Duplicate/Delete bar is Move-only ----
  await evaluate(`document.querySelector('[data-tool=brush]').click(); shapes=[]; clearShapeSel(); selText=null; render();`);
  await sleep(150);
  const vb = await evaluate(`view.getBoundingClientRect().toJSON()`);
  await touchDrag(vb.left + vb.width * 0.2, vb.top + vb.height * 0.2, vb.left + vb.width * 0.55, vb.top + vb.height * 0.45);
  check("drawing leaves the Duplicate/Delete bar hidden",
    (await evaluate(`document.querySelector('#selbar').hidden`)) === true);
  await evaluate(`document.querySelector('[data-tool=move]').click(); selectShape(shapes[0]); render();`);
  const mvBar = await evaluate(`({hidden:document.querySelector('#selbar').hidden,
     edit:getComputedStyle(document.querySelector('#selEdit')).display,
     del:getComputedStyle(document.querySelector('#selDel')).display})`);
  check("Move shows Delete (not Edit) on a selected stroke",
    mvBar.hidden === false && mvBar.edit === 'none' && mvBar.del !== 'none', mvBar);

  await evaluate(`document.querySelector('[data-tool=text]').click(); createTextBox({x:120,y:120});`);
  await sleep(120);
  await evaluate(`(function(){const ta=document.querySelector('textarea.textinput'); ta.value='Hi'; ta.dispatchEvent(new Event('input')); ta.blur();})()`);
  await sleep(200);
  await evaluate(`document.querySelector('[data-tool=move]').click(); selectText(texts[texts.length-1]); render();`);
  const txBar = await evaluate(`({hidden:document.querySelector('#selbar').hidden, edit:getComputedStyle(document.querySelector('#selEdit')).display})`);
  check("Move shows Edit on a selected text box", txBar.hidden === false && txBar.edit !== 'none', txBar);

  await shot("/tmp/mo-4-final.png");
  check("no uncaught page exceptions", exceptions.length === 0, exceptions.slice(0, 4));
  check("no console errors", consoleErrs.length === 0, consoleErrs.slice(0, 4));

  const failed = results.filter(r => !r.ok);
  console.log("\n==================== MOBILE SUMMARY ====================");
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log("FAILURES:"); for (const f of failed) console.log("  - " + f.name + "  " + JSON.stringify(f.extra)); }
  Deno.exit(failed.length ? 1 : 0);
}
await main();
