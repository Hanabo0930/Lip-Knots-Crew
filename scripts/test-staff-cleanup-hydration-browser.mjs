import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function section(source, from, to, includeEnd = false) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end + (includeEnd ? to.length : 0));
}

export function prepareDraftBrowserFixture() {
  const read = file => fs.readFileSync("apps/staff/src/" + file, "utf8");
  const app = read("App.tsx");
  const handlers = section(app, "  async function finishSubmittedDraft(", "  async function loadSubmissionHistory(");
  const hydration = section(app, "  useEffect(()=>{\n    setSubmissionConfirmed(false);", "  },[draftKey]);", true);
  const draftSave = section(app, "  const draftSavePaused=", "  useEffect(()=>{ if(!pushEnabled)");
  const entry = FIXTURE_ENTRY;
  const sources = {
    "/fixture.mjs": entry.replace("/* HANDLERS */", () => handlers)
      .replace("/* HYDRATION */", () => hydration).replace("/* SAVE */", () => draftSave),
    "/attempt.mjs": read("submission-attempt-store.ts"),
    "/draft.mjs": read("draft-store.ts"),
    "/concurrency.mjs": read("concurrency.ts"),
  };
  const modules = Object.fromEntries(Object.entries(sources).map(([name, source]) => {
    const output = ts.transpileModule(source, {
      fileName: name.replace(/\.mjs$/u, ".ts"),
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      reportDiagnostics: true,
    });
    assert.deepEqual(output.diagnostics, [], name);
    const emitted = ts.createSourceFile(name, output.outputText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    assert.equal(emitted.parseDiagnostics.length, 0, name);
    return [name, output.outputText];
  }));
  const hashes = Object.fromEntries(Object.entries(modules).map(([name, code]) =>
    [name, createHash("sha256").update(code).digest("hex")]));
  return { modules, hashes };
}

const FIXTURE_ENTRY = "\nimport * as attemptStore from \"/attempt.mjs\";\nimport * as draftStore from \"/draft.mjs\";\nimport { runWithConcurrency } from \"/concurrency.mjs\";\nconst {saveDraft,loadDraftState,clearSubmittedDraft}=draftStore;\nconst makeFiles=()=>[\n new File([\"one\"],\"one.png\",{type:\"image/png\",lastModified:1}),\n new File([\"two\"],\"two.pdf\",{type:\"application/pdf\",lastModified:2}),\n];\nwindow.makeFixture=()=>{\n let files=makeFiles(),draftCleanup=null,submissionConfirmed=true,pending=false,draftHydrating=false;\n const key=JSON.stringify([\"v2\",\"synthetic-owner\",\"job\",\"report\",\"normal\"]);\n const state={messages:[],processing:[],status:{}};\n let draftSaveCleanup;\n const draftKey=key,previewContextRef={current:key},authLoadVersionRef={current:1},hydratedDraftKeyRef={current:\"\"};\n const draftHydratingRef={current:false},skipNextDraftSaveRef={current:false};\n const MAX_SUBMISSION_FILE_SIZE=50*1024*1024,UPLOAD_CONCURRENCY=2;\n const selectedJob={id:\"job\",dateKey:\"2026-12-08\",revision:2};\n const companyId=\"company\",staffId=\"staff\",user={uid:\"user\"};\n const myJobs=[selectedJob],resubmissionDetail=null,requestId=\"\",submissionType=\"report\",firebaseConfigured=true,functions={},firebaseApp={};\n const hasValidDateKey=job=>/^\\d{4}-\\d{2}-\\d{2}$/.test(job.dateKey);\n const submissionConfirmationContext=JSON.stringify([key,selectedJob.dateKey,selectedJob.revision]);\n const submissionConfirmationContextRef={current:submissionConfirmationContext};\n const loadSubmissionAttempt=async()=>attemptStore,submissionFileContentType=f=>f.type,fileStateKey=f=>f.name;\n const isPending=()=>pending,isSubmissionActionPending=()=>pending,showSubmissionMessage=m=>state.messages.push(m);\n const setSubmissionConfirmed=v=>submissionConfirmed=v,setSubmissionMessage=()=>{},setMessage=showSubmissionMessage;\n const setFiles=v=>files=v,setDraftCleanup=v=>draftCleanup=typeof v===\"function\"?v(draftCleanup):v;\n const setDraftHydrating=v=>draftHydrating=v,setUploadState=v=>state.status=typeof v===\"function\"?v(state.status):v;\n const pollSubmissionProcessing=async(...args)=>{state.processing.push(args);};\n const run=async(_key,fn,options)=>{\n  pending=true;\n  try { await fn(); } catch(error) { options?.setMessage?.(error.message); throw error; } finally { pending=false; }\n };\n const httpsCallable=(_api,name)=>{\n  if(name!==\"createUploadSession\")throw Error(\"Unexpected synthetic API \"+name);\n  return async payload=>({data:await window.fixtureSession(payload)});\n };\n const loadUploadStorage=async()=>({\n  getClientStorage:()=>({}),ref:(_s,p)=>p,\n  uploadBytesResumable:(path,_file,metadata)=>({on:(_event,_progress,reject,resolve)=>{window.fixtureUpload({path,metadata}).then(resolve,reject);}}),\n });\n /* HANDLERS */\n function hydrate(){const useEffect=fn=>fn();/* HYDRATION */}\n function queueDraftSave(){draftSaveCleanup?.();const useEffect=fn=>draftSaveCleanup=fn();/* SAVE */}\n async function seedLegacy(){\n  await saveDraft(key,[]);\n  await new Promise((resolve,reject)=>{\n   const request=indexedDB.open(\"lkc-submission-drafts\",1);\n   request.onerror=()=>reject(request.error);\n   request.onsuccess=()=>{\n    const db=request.result,write=db.transaction(\"drafts\",\"readwrite\");\n    const store=write.objectStore(\"drafts\");\n    store.delete(\"lkc-draft:\"+key);\n    const file=makeFiles()[0];\n    store.put([{id:\"synthetic-legacy\",name:file.name,type:file.type,size:file.size,lastModified:file.lastModified,blob:file}],key);\n    write.oncomplete=()=>{db.close();resolve();};write.onerror=()=>{db.close();reject(write.error);};\n   };\n  });\n  localStorage.setItem(\"lkc-submitted-draft:\"+key,\"1\");\n }\n return {\n  key,uploadSubmission,retryDraftCleanup,hydrate,queueDraftSave,seedLegacy,\n  save:()=>saveDraft(key,files),confirm:()=>setSubmissionConfirmed(true),text:()=>files[0]?.text(),\n  select:variant=>{files=[new File([variant],\"selected-\"+variant+\".pdf\",{type:\"application/pdf\",lastModified:3})];submissionConfirmed=true;},\n  snapshot:()=>({\n   cleanup:draftCleanup&&{key:draftCleanup.key,attempt:draftCleanup.attempt,draftCleared:Boolean(draftCleanup.draftCleared),unverified:draftCleanup.unverified},\n   files:files.map(file=>file.name),confirmed:submissionConfirmed,draftHydrating,messages:state.messages,processing:state.processing,\n  }),\n  switchAccount:()=>{authLoadVersionRef.current++;draftCleanup={key:\"other-owner/job\",durable:true};files=[new File([\"other\"],\"other.pdf\")];},\n };\n};\nwindow.draftStore=draftStore;\nwindow.ready=true;\n";

async function runBrowser({ modules }) {
  const { createServer } = await import("node:http");
  const { chromium } = await import("playwright");
  const server = createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (Object.hasOwn(modules, req.url)) {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }).end(modules[req.url]);
      return;
    }
    if (req.url !== "/") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" })
      .end('<!doctype html><meta charset="utf-8"><title>Synthetic submission recovery</title><script type="module" src="/fixture.mjs"></script>');
  });
  let browser;
  const cases = [], external = [], errors = [];
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "http://127.0.0.1:" + server.address().port;
    browser = await chromium.launch({ headless: true });
    async function scenario(name, run) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      const receipts = new Map(), uploaded = new Set(), requests = [], writes = [];
      let loseResponse = false, uploadGate;
      try {
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          external.push(url.origin);
          return route.abort("blockedbyclient");
        });
        await context.exposeBinding("fixtureSession", (_source, payload) => {
          requests.push(payload);
          const receipt = "submission_" + createHash("sha256").update(JSON.stringify(["company", "staff", "user", payload.clientRequestId])).digest("hex");
          receipts.set(payload.clientRequestId, receipt);
          if (loseResponse) { loseResponse = false; throw Error("Synthetic lost response after acceptance"); }
          return {
            submissionId: receipt,
            clientRequestId: payload.clientRequestId,
            acceptedContext: { jobId: payload.jobId, dateKey: payload.expectedDateKey, revision: payload.expectedRevision },
            files: payload.files.map((_file, i) => {
              const fileId = "file_" + createHash("sha256").update(receipt + "|" + i).digest("hex").slice(0,32);
              const storagePath = "staging/company/user/" + receipt + "/" + fileId + "/" + i;
              return { fileId, storagePath, uploadRequired: !uploaded.has(storagePath) };
            }),
          };
        });
        await context.exposeBinding("fixtureUpload", async (_source, { path }) => {
          if (uploadGate && path.endsWith("/1")) {
            uploadGate.started();
            await uploadGate.wait;
          }
          assert.equal(uploaded.has(path), false, "create-only upload");
          uploaded.add(path);
          writes.push(path);
        });
        const newPage = async () => {
          const page = await context.newPage();
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(origin);
          await page.waitForFunction(() => window.ready);
          return page;
        };
        await run({
          newPage, requests, writes, receipts,
          loseReply: () => { loseResponse = true; },
          holdLastUpload: () => {
            let started, release;
            const ready = new Promise(resolve => { started = resolve; });
            const wait = new Promise(resolve => { release = resolve; });
            uploadGate = { started, wait, release };
            return { ready, release };
          },
        });
        cases.push(name);
      } finally {
        uploadGate?.release();
        await context.close();
      }
    }
    const create = page => page.evaluate(() => { window.f = window.makeFixture(); });
    const saved = page => page.evaluate(async () => { await f.save(); });
    const uploaded = page => page.evaluate(async () => { await f.uploadSubmission(); });
    const retry = page => page.evaluate(async () => { await f.retryDraftCleanup(); });
    const view = page => page.evaluate(() => f.snapshot());
    async function hydrate(page) {
      await page.evaluate(() => f.hydrate());
      await page.waitForFunction(() => !f.snapshot().draftHydrating);
    }
    const refuseReceiptRemoval = page => page.evaluate(() => {
      const remove = Storage.prototype.removeItem;
      window.restoreRemove = () => { Storage.prototype.removeItem = remove; };
      Storage.prototype.removeItem = function (key) {
        if (key.startsWith("lkc.submissionAttempt.v1:")) throw new DOMException("Fixture cleanup refusal", "SecurityError");
        return remove.call(this, key);
      };
    });

    await scenario("lost reply and reload retain the operation ID", async ({ newPage, loseReply, requests, writes, receipts }) => {
      const page = await newPage(); await create(page); await saved(page);
      loseReply();
      await uploaded(page);
      assert.equal(writes.length, 0);
      assert.equal((await view(page)).files.length, 2);
      await page.reload(); await page.waitForFunction(() => window.ready); await create(page); await hydrate(page);
      assert.equal((await view(page)).files.length, 2);
      await page.evaluate(() => f.confirm());
      await uploaded(page);
      assert.equal(requests.length, 2);
      assert.equal(requests[0].clientRequestId, requests[1].clientRequestId);
      assert.equal(receipts.size, 1);
      assert.equal(writes.length, 2);
      assert.equal((await view(page)).cleanup, null);
    });
    await scenario("local receipt cleanup retries without a second submission", async ({ newPage, requests, writes }) => {
      const page = await newPage(); await create(page); await saved(page); await refuseReceiptRemoval(page);
      await uploaded(page);
      const before = await view(page);
      assert.equal(before.cleanup?.draftCleared, true);
      assert.ok(before.cleanup?.attempt?.clientRequestId);
      await page.evaluate(() => restoreRemove());
      await retry(page);
      assert.equal((await view(page)).cleanup, null);
      assert.equal(requests.length, 1);
      assert.equal(writes.length, 2);
    });
    await scenario("newer draft survives the first tab finishing", async ({ newPage, holdLastUpload, requests, writes }) => {
      const first = await newPage(), second = await newPage();
      await create(first); await create(second); await saved(first);
      const held = holdLastUpload();
      await first.evaluate(() => { window.sending = f.uploadSubmission(); });
      let timer;
      try {
        await Promise.race([held.ready, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Expected upload never started")), 8000);
        })]);
        await second.evaluate(() => { f.select("second"); });
        await saved(second);
      } finally { clearTimeout(timer); held.release(); }
      await first.evaluate(() => sending);
      await second.reload(); await second.waitForFunction(() => window.ready); await create(second); await hydrate(second);
      assert.deepEqual((await view(second)).files, ["selected-second.pdf"]);
      assert.equal(await second.evaluate(() => f.text()), "second");
      assert.equal((await view(first)).cleanup, null);
      assert.equal(requests.length, 1);
      const attemptId = requests[0].clientRequestId;
      assert.equal(await first.evaluate(id => Object.values(localStorage).some(raw => {
        try { return JSON.parse(raw)?.clientRequestId === id; } catch { return false; }
      }), attemptId), true);
      assert.equal(writes.length, 2);
    });
    await scenario("an aborted IndexedDB transaction preserves the draft and operation", async ({ newPage, requests, writes }) => {
      const page = await newPage(); await create(page); await saved(page);
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        window.restorePut = () => { IDBObjectStore.prototype.put = put; };
        IDBObjectStore.prototype.put = function (value, key) {
          const request = put.call(this, value, key);
          if (typeof key === "string" && key.startsWith("lkc-draft:") && Array.isArray(value) && value.length === 0) this.transaction.abort();
          return request;
        };
      });
      await uploaded(page);
      const before = await view(page);
      assert.equal(before.cleanup?.draftCleared, false);
      assert.ok(before.cleanup?.attempt?.clientRequestId);
      await page.evaluate(() => restorePut());
      assert.equal(await page.evaluate(async () => (await draftStore.loadDraft(f.key)).length), 2);
      await retry(page);
      assert.equal((await view(page)).cleanup, null);
      assert.equal(await page.evaluate(async () => (await draftStore.loadDraft(f.key)).length), 0);
      assert.equal(requests.length, 1);
      assert.equal(writes.length, 2);
    });
    await scenario("an account switch while cleanup waits for a Web Lock preserves both views", async ({ newPage, requests, writes }) => {
      const page = await newPage(); await create(page); await saved(page); await refuseReceiptRemoval(page);
      await uploaded(page);
      const previous = (await view(page)).cleanup.attempt;
      assert.ok(previous?.storageKey);
      await page.evaluate(() => restoreRemove());
      await page.evaluate(key => {
        window.lock = navigator.locks.request(key, { mode: "exclusive" }, async () => {
          window.held = true;
          await new Promise(resolve => { window.release = resolve; });
        });
      }, previous.storageKey);
      await page.waitForFunction(() => window.held);
      try {
        await page.evaluate(() => { window.cleaning = f.retryDraftCleanup(); });
        await page.waitForFunction(async key => (await navigator.locks.query()).pending.some(row => row.name === key), previous.storageKey);
        await page.evaluate(() => f.switchAccount());
      } finally { await page.evaluate(() => release()); }
      await page.evaluate(() => cleaning);
      assert.equal((await view(page)).cleanup.key, "other-owner/job");
      assert.deepEqual((await view(page)).files, ["other.pdf"]);
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).clientRequestId, previous.storageKey), previous.clientRequestId);
      assert.equal(requests.length, 1);
      assert.equal(writes.length, 2);
    });
    await scenario("only the legacy draft is held by an unbound legacy receipt", async ({ newPage, requests, writes }) => {
      const page = await newPage(); await create(page);
      await page.evaluate(() => f.seedLegacy());
      await hydrate(page);
      const state = await view(page);
      assert.equal(state.cleanup?.unverified, true);
      assert.deepEqual(state.files, []);
      await retry(page);
      await page.evaluate(() => { f.select("unknown"); });
      await uploaded(page);
      assert.equal(requests.length, 0);
      assert.equal(writes.length, 0);
      assert.equal(await page.evaluate(() => localStorage.getItem("lkc-submitted-draft:" + f.key)), "1");
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(JSON.stringify({ passed: true, cases, externalRequests: 0,
      browserStarted: true, realIndexedDB: true, actualFirebase: false }));
  } finally {
    try { await browser?.close(); } finally {
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--prepare-only"), "Unknown arguments");
  const prepared = prepareDraftBrowserFixture();
  if (args.length) console.log(JSON.stringify({ moduleHashes: prepared.hashes, browserStarted: false, serverBound: false }));
  else await runBrowser(prepared);
}
