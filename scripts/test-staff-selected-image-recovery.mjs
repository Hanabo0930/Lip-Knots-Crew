import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const app = readFileSync("apps/staff/src/App.tsx", "utf8");
const start = app.indexOf("function formatFileSize("), end = app.indexOf("function EmptyAction(", start);
assert.ok(start >= 0 && end > start);
const source = app.slice(start, end);
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX };
const require = createRequire(import.meta.url);
const descendants = element => !element || typeof element !== "object" ? []
  : [element, ...[element.props?.children].flat(Infinity).flatMap(descendants)];
const elementOf = (tree, type) => descendants(tree).find(node => node.type === type);

// Exercise the real event closures with deferred effects and an obsolete error
// arriving after the current image has also failed. No decoding or cloud SDK.
{
  let state = null, deps, pendingEffect, cleanup, urls = 0, removeCalls = 0;
  const revoked = [];
  const context = {
    exports: {}, require, Blob,
    SubmissionImageViewer: () => null,
    URL: { createObjectURL: () => "blob:fixture/" + ++urls, revokeObjectURL: url => revoked.push(url) },
    useState: () => [state, update => { state = typeof update === "function" ? update(state) : update; }],
    useEffect: (effect, nextDeps) => {
      if (!deps || nextDeps.some((value, index) => value !== deps[index])) { pendingEffect = effect; deps = nextDeps; }
    },
  };
  runInNewContext(ts.transpileModule(source + "\nglobalThis.renderSelected=SelectedSubmissionFile;", { compilerOptions }).outputText, context);
  const first = new File(["one"], "same.png", { type: "image/png", lastModified: 123 });
  const second = new File(["two"], "same.png", { type: "image/png", lastModified: 123 });
  const third = new File(["new"], "next.png", { type: "image/png" });
  const render = (file, disabled = false) => context.renderSelected({ file, position: 1, status: "選択中・未送信", disabled, onRemove: () => removeCalls++ });
  const flush = () => { if (pendingEffect) { cleanup?.(); cleanup = pendingEffect(); pendingEffect = undefined; } };
  render(first); flush();
  const oldError = elementOf(render(first), "img").props.onError;
  assert.equal(elementOf(render(second), "img"), undefined, "A replacement must not render the previous File's blob before its effect.");
  flush();
  const currentError = elementOf(render(second), "img").props.onError;
  currentError();
  assert.equal(state.failed, true);
  const failedState = state;
  oldError();
  assert.equal(state, failedState, "An obsolete error must not overwrite the current failure state.");
  assert.equal(elementOf(render(second), "p").props.role, "status");
  assert.equal(elementOf(render(second, true), "button").props.disabled, true);
  render(third); flush();
  oldError(); currentError();
  assert.equal(state.failed, false, "Obsolete errors must not poison the replacement.");
  assert.ok(elementOf(render(third), "img"));
  assert.equal(removeCalls, 0, "Decode failure must never remove the selected file.");
  cleanup();
  assert.deepEqual(revoked, ["blob:fixture/1", "blob:fixture/2", "blob:fixture/3"]);
  console.log("Selected image recovery: File identity, obsolete error ordering, failure retention, disabled removal, no automatic removal, and URL cleanup passed.");
}

if (process.argv.includes("--browser")) {
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright");
  const fixtureSource = [
    "import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';",
    "import SubmissionImageViewer from '/src/SubmissionImageViewer.tsx';import '/src/styles.css';",
    source,
    "window.selectedControl={removeCalls:0,snapshots:[],files:[]};",
    "function Fixture(){",
    "const [file,setFile]=useState(null),[disabled,setDisabled]=useState(false);",
    "window.selectedControl.replace=(kind,name)=>{const bytes=kind==='valid'?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><rect width=\"20\" height=\"20\" fill=\"blue\"/></svg>':kind==='pdf'?'%PDF-1.4 synthetic':'synthetic undecodable image';const next=new File([bytes],name,{type:kind==='valid'?'image/svg+xml':kind==='pdf'?'application/pdf':'image/png',lastModified:123});window.selectedControl.files.push(next);setFile(next);};",
    "window.selectedControl.setDisabled=setDisabled;window.selectedControl.currentFile=file;",
    "React.useLayoutEffect(()=>{window.selectedControl.snapshots.push({file,src:document.querySelector('.selected-file-preview img')?.getAttribute('src')??null,error:!!document.querySelector('.selected-file-preview-error')});},[file]);",
    "return <main><div className='file-list'>{file?<SelectedSubmissionFile file={file} position={1} status='選択中・未送信' disabled={disabled} onRemove={()=>{window.selectedControl.removeCalls++;setFile(null);}}/>:<p>ファイル未選択</p>}</div></main>;",
    "}",
    "createRoot(document.getElementById('root')).render(<Fixture/>);",
  ].join("\n");
  const js = ts.transpileModule(fixtureSource, { compilerOptions: { ...compilerOptions, module: ts.ModuleKind.ESNext } }).outputText;
  const html = '<!doctype html><html><body><div id="root"></div><script type="module">' + js + '</script></body></html>';
  const server = await createServer({
    root: resolve("apps/staff"), configFile: false, envDir: false,
    oxc: { jsx: { runtime: "automatic" } }, server: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "selected-image-recovery-fixture", configureServer(devServer) {
      devServer.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__selected_image_recovery.html") return next();
        res.setHeader("Content-Type", "text/html");
        try { res.end(await devServer.transformIndexHtml(req.url, html)); } catch (error) { next(error); }
      });
    } }],
  });
  let browser;
  try {
    await server.listen();
    const origin = "http://127.0.0.1:" + server.httpServer.address().port;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let remoteRequests = 0;
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      remoteRequests++; return route.abort();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/__selected_image_recovery.html");
    await page.waitForFunction(() => !!window.selectedControl?.replace);
    const replace = (kind, name) => page.evaluate(({ kind, name }) => window.selectedControl.replace(kind, name), { kind, name });
    const loaded = () => page.waitForFunction(() => { const img = document.querySelector(".selected-file-preview img"); return img?.complete && img.naturalWidth > 0; });
    await replace("valid", "valid.svg"); await loaded();
    assert.equal(await page.locator(".selected-file-preview-error").count(), 0);
    await page.getByRole("button", { name: "valid.svgを拡大", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    await page.getByRole("button", { name: "拡大表示を閉じる", exact: true }).click();

    const brokenName = "表示できない画像-" + "長い名前".repeat(35) + ".png";
    await replace("broken", brokenName);
    const error = page.getByRole("status");
    await error.waitFor();
    assert.match(await error.innerText(), /プレビューを表示できません/);
    assert.match(await error.innerText(), /ファイルは保持/);
    assert.match(await error.innerText(), /外す.*選択を解除.*選び直/);
    assert.equal(await page.locator(".selected-file-preview img").count(), 0);
    assert.equal(await page.getByRole("button", { name: /を拡大$/ }).count(), 0);
    assert.equal(await page.locator(".file-copy em").innerText(), "選択中・未送信");
    assert.deepEqual(await page.evaluate(async () => ({
      retained: window.selectedControl.currentFile === window.selectedControl.files.at(-1),
      text: await window.selectedControl.currentFile.text(), removed: window.selectedControl.removeCalls,
    })), { retained: true, text: "synthetic undecodable image", removed: 0 });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await error.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => document.documentElement.style.zoom = "2");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => document.documentElement.style.zoom = "");

    await page.evaluate(() => window.selectedControl.setDisabled(true));
    const remove = page.getByRole("button", { name: "1件目のファイルを外す", exact: true });
    await page.waitForFunction(() => document.querySelector(".file-remove")?.disabled);
    assert.equal(await remove.isDisabled(), true);
    await page.evaluate(() => window.selectedControl.setDisabled(false));
    await remove.focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator(".selected-file-row").count(), 0);
    assert.equal(await page.evaluate(() => window.selectedControl.removeCalls), 1);

    // Changing the File clears errors even when the name and timestamp match.
    await replace("broken", "same.png"); await error.waitFor();
    await replace("valid", "same.png"); await loaded();
    assert.equal(await page.locator(".selected-file-preview-error").count(), 0);
    assert.deepEqual(await page.evaluate(()=>{
      const first=window.selectedControl.snapshots.find(row=>row.file===window.selectedControl.currentFile);
      return {src:first.src,error:first.error};
    }), {src:null,error:false}, "The first replacement commit must contain neither the old blob nor its error.");
    await replace("broken", "report.png"); await error.waitFor();
    await replace("pdf", "report.pdf");
    await page.getByRole("link", { name: "report.pdfを送信前に別タブで開く", exact: true }).waitFor();
    assert.equal(await page.locator(".selected-file-preview-error").count(), 0);
    assert.equal(await page.locator(".selected-file-preview img").count(), 0);
    assert.equal(await page.evaluate(() => window.selectedControl.removeCalls), 1);
    assert.deepEqual(errors, []); assert.equal(remoteRequests, 0);
    console.log("Selected image recovery browser passed: valid/failed preview, retained bytes, guidance, enlargement, 3 widths/200% zoom, disabled/keyboard removal, same-name replacement, PDF recovery; remote requests=0.");
  } finally { await browser?.close(); await server.close(); }
}
