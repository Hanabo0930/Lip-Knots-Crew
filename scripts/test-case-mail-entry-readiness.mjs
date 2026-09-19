import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";

const root = path.resolve("apps/admin");
const server = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { entries: [], include: ["react", "react-dom/client", "firebase/functions"] }, plugins: [
  { name: "receipt-readiness-boundary", enforce: "pre",
    resolveId(id, importer) {
      if (id === "/__readiness.tsx") return "\0readiness";
      if (id === "./firebase" && importer?.replaceAll("\\", "/").endsWith("/CaseMailIntakeEntry.tsx")) return "\0readiness-firebase";
    },
    load(id) {
      if (id === "\0readiness-firebase") return 'export const firebaseConfigured = location.search.includes("configured"); export const functions = {}; export const auth = { onIdTokenChanged(){window.__authCalls++;throw Error("Unexpected auth setup");} };';
      if (id === "\0readiness") return 'import React from "react";import {createRoot} from "react-dom/client";import Entry from "/src/CaseMailIntakeEntry.tsx";window.__authCalls=0;createRoot(document.getElementById("root")).render(React.createElement(Entry,{onCreated(){},onReviewJob(){}}));';
    },
  }, react(),
], server: { host: "127.0.0.1", port: 0 } });
server.middlewares.use(async (req, res, next) => {
  if (req.url?.split("?")[0] !== "/__readiness.html") return next();
  res.setHeader("Content-Type", "text/html");
  res.end(await server.transformIndexHtml("/__readiness.html", '<div id="root"></div><script type="module" src="/__readiness.tsx"></script>'));
});
let browser;
try {
  await server.listen();
  const base = "http://127.0.0.1:" + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let external = 0;const errors=[];
  page.on("pageerror", e=>errors.push(e.message));
  await page.route("**/*", route => {
    if(new URL(route.request().url()).origin !== base){external++;return route.abort();}
    return route.continue();
  });
  await page.goto(base + "/__readiness.html?configured");
  await page.getByRole("status").filter({hasText:"準備中"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"受信候補を確認",exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole("button",{name:"受信候補を閉じる"}).count(),0);
  assert.equal(await page.evaluate(()=>window.__authCalls),0);
  assert.equal(external,0);
  await page.goto(base + "/__readiness.html");
  await page.getByRole("button",{name:"受信候補を確認",exact:true}).click();
  await page.getByText("受信した案件候補はありません。",{exact:true}).waitFor();
  await page.getByRole("button",{name:"受信候補を閉じる"}).click();
  await page.waitForFunction(()=>document.activeElement?.textContent==="受信候補を確認");
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:["configured entry disabled","preparation status visible","no auth setup","no external requests","demo opens","demo closes and restores focus","no browser errors"]}));
} finally { await browser?.close(); await server.close(); }
