import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {request} from "node:http";
import {createAdminLocalServer} from "./serve-admin-local.mjs";
const root=mkdtempSync(join(tmpdir(),"lkc-admin-server-"));
let server;
try{
  writeFileSync(join(root,"index.html"),"<html>original</html>");
  writeFileSync(join(root,"logo.png"),"logo");mkdirSync(join(root,"assets"));
  writeFileSync(join(root,"assets/panel.js"),"export default 1;");
  server=createAdminLocalServer(root);await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
  const base=`http://127.0.0.1:${server.address().port}`;
  // 配信中のビルドが消えても、同じページの遅延部品を提供し続ける。
  rmSync(join(root,"assets"),{recursive:true});writeFileSync(join(root,"index.html"),"replacement");
  assert.equal(await(await fetch(base)).text(),"<html>original</html>");
  const panel=await fetch(base+"/assets/panel.js");assert.equal(panel.status,200);assert.match(panel.headers.get("content-type"),/javascript/);assert.equal(await panel.text(),"export default 1;");
  assert.equal((await fetch(base+"/assets/missing.js")).status,404);
  assert.equal((await fetch(base+"/logo.png")).status,200);
  assert.equal(await(await fetch(base+"/jobs")).text(),"<html>original</html>");
  assert.equal((await fetch(base,{method:"POST"})).status,405);
  assert.equal(await(await fetch(base,{method:"HEAD"})).text(),"");
  const status=await new Promise(ok=>request({hostname:"127.0.0.1",port:server.address().port,path:"/%2e%2e/package.json"},r=>{r.resume();ok(r.statusCode);}).end());assert.equal(status,403);
  console.log("Admin local server: immutable assets, logo, SPA path, missing chunk, HEAD, method, traversal passed.");
}finally{if(server)await new Promise(ok=>server.close(ok));rmSync(root,{recursive:true,force:true});}
