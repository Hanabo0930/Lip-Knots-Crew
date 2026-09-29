import {createServer} from "node:http";
import {readFileSync,readdirSync,statSync} from "node:fs";
import {resolve,join,extname} from "node:path";
import {fileURLToPath} from "node:url";

// 起動時の一式を保持し、別のビルドによる遅延部品の消失を防ぐ。
export function createAdminLocalServer(directory){
  const root=resolve(directory),files=new Map();
  function load(folder,prefix=""){
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw new Error("Symlink is not allowed");
      const key=prefix+"/"+entry.name,path=join(folder,entry.name);
      if(entry.isDirectory())load(path,key);
      else if(entry.isFile())files.set(key,readFileSync(path));
    }
  }
  if(!statSync(root).isDirectory())throw new Error("Build directory required");
  load(root);
  if(!files.has("/index.html")||!files.has("/logo.png"))throw new Error("Incomplete admin build");
  const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon",".json":"application/json",".webmanifest":"application/manifest+json",".woff2":"font/woff2"};
  return createServer((req,res)=>{
    const send=(status,type,body)=>{res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(req.method==="HEAD"?undefined:body);};
    if(!["GET","HEAD"].includes(req.method))return send(405,"text/plain","Method not allowed");
    let key;
    try{key=decodeURIComponent((req.url??"/").split("?")[0]);}catch{return send(400,"text/plain","Bad request");}
    if(key.includes("\\")||key.includes("\0")||key.split("/").includes(".."))return send(403,"text/plain","Forbidden");
    if(key==="/"||(!extname(key)&&!files.has(key)))key="/index.html";
    const body=files.get(key);
    if(!body)return send(404,"text/plain","Not found");
    send(200,types[extname(key)]??"application/octet-stream",body);
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2])throw new Error("Usage: node scripts/serve-admin-local.mjs <build-directory> [port]");
  const port=Number(process.argv[3]??4184);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Invalid port");
  const server=createAdminLocalServer(process.argv[2]);
  server.listen(port,"127.0.0.1",()=>console.log(`Admin preview ready: http://localhost:${port}`));
}
