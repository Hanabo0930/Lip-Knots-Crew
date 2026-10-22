import assert from "node:assert/strict";
import { resolve } from "node:path";

// The first committed DOM is inspected before passive effects run; waiting for
// the eventual new image would miss a frame with the previous file's contents.
if (process.argv.includes("--browser")) {
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright");
  const file = (id, previewUrl, overrides = {}) => ({
    id, submissionId: "submission-" + id, driveName: "", originalName: id + ".png",
    contentType: "image/png", previewUrl, ...overrides,
  });
  const html = [
    '<!doctype html><html><body><main id="root"></main><script type="module">',
    "import React from 'react';",
    "import {createRoot} from 'react-dom/client';",
    "import Preview from '/src/SubmissionPreviewImage.tsx';",
    "window.previewControl={snapshots:[],requests:[]};",
    "function Fixture(){",
    "const [file,setFile]=React.useState(" + JSON.stringify(file("first", "/first.svg")) + ");",
    "window.previewControl.replace=setFile;",
    "React.useLayoutEffect(()=>{",
    "const image=document.querySelector('.preview-frame img');",
    "window.previewControl.snapshots.push({",
    "id:file.id,submissionId:file.submissionId,url:file.previewUrl,",
    "src:image?.getAttribute('src')??null,alt:image?.getAttribute('alt')??null,",
    "loaded:image?.classList.contains('loaded')??false,",
    "dialogOpen:!!document.querySelector('dialog[open]'),",
    "error:!!document.querySelector('.preview-error'),",
    "});});",
    "return React.createElement(Preview,{file,onRefreshPreview:target=>new Promise((resolve,reject)=>{",
    "window.previewControl.requests.push({id:target.id,resolve,reject});",
    "})});}",
    "createRoot(document.getElementById('root')).render(React.createElement(Fixture));",
    "</script></body></html>",
  ].join("\n");
  // This isolated fixture loads only React and the preview components. It
  // never loads App, Firebase configuration, an SDK, or an authenticated session.
  const server = await createServer({
    root: resolve("apps/staff"), configFile: false, envDir: false,
    oxc: { jsx: { runtime: "automatic" } },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "staff-preview-context-fixture",
      configureServer(devServer) {
        devServer.middlewares.use(async (req, res, next) => {
          if (req.url === "/__preview_context.html") {
            res.setHeader("Content-Type", "text/html");
            try { res.end(await devServer.transformIndexHtml(req.url, html)); }
            catch (error) { next(error); }
          } else if (["/first.svg", "/second.svg", "/refreshed.svg"].includes(req.url)) {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');
          } else next();
        });
      },
    }],
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
      remoteRequests++;
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/__preview_context.html");
    await page.locator(".preview-image.loaded").waitFor();
    const replace = async value => {
      await page.evaluate(value => window.previewControl.replace(value), value);
      await page.waitForFunction(value => window.previewControl.snapshots.some(row =>
        row.id === value.id && row.submissionId === value.submissionId && row.url === value.previewUrl), value);
      return page.evaluate(value => window.previewControl.snapshots.find(row =>
        row.id === value.id && row.submissionId === value.submissionId && row.url === value.previewUrl), value);
    };

    const second = await replace(file("second", "/second.svg"));
    assert.equal(second.src, "/second.svg", "First committed DOM must never show the previous image under the new file name.");
    assert.equal(second.alt, "second.png");
    assert.equal(second.loaded, false, "A new image must confirm its own load.");
    await page.locator(".preview-image.loaded").waitFor();

    await page.getByRole("button", { name: "second.pngを拡大", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    const third = await replace(file("third", "/second.svg", { submissionId: "submission-second" }));
    assert.equal(third.dialogOpen, false, "A new file must immediately remove the old modal, even if its URL is reused.");
    assert.equal(third.loaded, false);
    await page.locator(".preview-image.loaded").waitFor();

    await page.getByRole("button", { name: "third.pngを拡大", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    const otherSubmission = await replace(file("third", "/second.svg"));
    assert.equal(otherSubmission.dialogOpen, false, "The same file ID in a different submission must have independent state.");
    assert.equal(otherSubmission.loaded, false);
    await page.locator(".preview-image.loaded").waitFor();

    const refreshed = await replace(file("third", "/refreshed.svg"));
    assert.equal(refreshed.src, "/refreshed.svg");
    assert.equal(refreshed.loaded, false);
    await page.locator(".preview-image.loaded").waitFor();

    // Same file: an unrelated metadata update must not discard its open viewer.
    await page.getByRole("button", { name: "third.pngを拡大", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    await page.evaluate(value => window.previewControl.replace(value), file("third", "/refreshed.svg", { originalName: "renamed.png" }));
    await page.getByRole("dialog", { name: "画像の拡大表示: renamed.png", exact: true }).waitFor();
    assert.equal(await page.locator("dialog[open]").count(), 1);
    await page.getByRole("button", { name: "拡大表示を閉じる", exact: true }).click();

    // Changing media type closes the image viewer as well.
    await replace(file("pdf", "/refreshed.svg"));
    await page.locator(".preview-image.loaded").waitFor();
    await page.getByRole("button", { name: "pdf.pngを拡大", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    await page.evaluate(value => window.previewControl.replace(value), file("pdf", "/refreshed.svg", { contentType: "application/pdf", originalName: "report.pdf" }));
    await page.getByRole("group", { name: "PDFの内容確認: report.pdf", exact: true }).waitFor();
    assert.equal(await page.locator("dialog[open]").count(), 0);

    await replace(file("broken", "/missing.svg"));
    await page.locator(".preview-error").waitFor();
    const afterError = await replace(file("after-error", "/second.svg"));
    assert.equal(afterError.error, false, "An old decode failure must not hide the next file.");
    assert.equal(afterError.src, "/second.svg");
    await page.locator(".preview-image.loaded").waitFor();

    // An obsolete response cannot replace the new file or release its retry lock.
    await replace(file("old-request", null));
    await page.getByRole("button", { name: "画像を再読み込み", exact: true }).click();
    await replace(file("current-request", null));
    await page.getByRole("button", { name: "画像を再読み込み", exact: true }).click();
    await page.evaluate(() => window.previewControl.requests[0].resolve("/first.svg"));
    assert.equal(await page.getByRole("button", { name: "再取得中…", exact: true }).isDisabled(), true);
    assert.equal(await page.locator(".preview-frame img").count(), 0);
    await page.evaluate(() => window.previewControl.requests[1].reject(Error("synthetic offline")));
    await page.getByRole("button", { name: "画像を再読み込み", exact: true }).waitFor();
    await page.getByRole("button", { name: "画像を再読み込み", exact: true }).click();
    await page.evaluate(() => window.previewControl.requests[2].resolve("/refreshed.svg"));
    await page.locator(".preview-image.loaded").waitFor();
    assert.equal(await page.locator(".preview-frame img").getAttribute("src"), "/refreshed.svg");
    assert.equal(await page.locator(".preview-frame img").getAttribute("alt"), "current-request.png");
    assert.deepEqual(await page.evaluate(() => window.previewControl.requests.map(row => row.id)), ["old-request", "current-request", "current-request"]);
    assert.deepEqual(errors, []);
    assert.equal(remoteRequests, 0);
    console.log("Staff preview context browser passed: first-commit image/URL/load reset, modal isolation, metadata retention, media switch, obsolete response isolation and retry; remote requests=0.");
  } finally {
    await browser?.close();
    await server.close();
  }
}
