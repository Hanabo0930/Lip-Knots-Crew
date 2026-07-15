import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const basePort=Number(process.env.LKC_DEMO_PORT??4172);
const sites=[
  {name:"launcher",port:basePort,root:join(root,"demo-launcher")},
  {name:"staff",port:basePort+1,root:join(root,"apps","staff","dist")},
  {name:"admin",port:basePort+2,root:join(root,"apps","admin","dist")},
];
const mimeTypes={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".svg":"image/svg+xml",".ico":"image/x-icon",".webmanifest":"application/manifest+json",".woff":"font/woff",".woff2":"font/woff2"};

for(const site of sites){if(!existsSync(join(site.root,"index.html")))throw new Error(`${site.name} の配布済みindex.htmlがありません。先に npm run build を実行してください。`);}
const servers=sites.map(site=>startSite(site));
await Promise.all(servers.map(item=>item.ready));
if(process.argv.includes("--self-test")){
  selfTest();await httpSmokeTest();await Promise.all(servers.map(item=>new Promise(resolveClose=>item.server.close(resolveClose))));console.log("one-click demo preview tests passed (16 cases)");process.exit(0);
}
const launcherUrl=`http://127.0.0.1:${basePort}`;
console.log(`Lip Knots Crew v5.6 デモを起動しました：${launcherUrl}`);
console.log("終了するときは、この画面で Ctrl+C を押してください。");
if(process.argv.includes("--open"))openBrowser(launcherUrl);
for(const signal of ["SIGINT","SIGTERM"]){process.on(signal,()=>{for(const item of servers)item.server.close();process.exit(0);});}

function startSite(site){
  const server=createServer((request,response)=>{
    try{
      const requestPath=new URL(request.url??"/",`http://127.0.0.1:${site.port}`).pathname;const filePath=resolveRequestPath(site.root,requestPath);
      if(!filePath){send(response,403,"text/plain; charset=utf-8","Forbidden");return;}
      const selected=existsSync(filePath)&&statSync(filePath).isFile()?filePath:extname(requestPath)?null:join(site.root,"index.html");
      if(!selected||!existsSync(selected)){send(response,404,"text/plain; charset=utf-8","Not found");return;}
      const headers={"Cache-Control":extname(selected)===".html"?"no-store":"public, max-age=300","X-Content-Type-Options":"nosniff","X-Frame-Options":"SAMEORIGIN","Referrer-Policy":"no-referrer"};
      response.writeHead(200,{"Content-Type":mimeTypes[extname(selected).toLowerCase()]??"application/octet-stream",...headers});response.end(readFileSync(selected));
    }catch(error){send(response,500,"text/plain; charset=utf-8",error instanceof Error?error.message:String(error));}
  });
  const ready=new Promise((accept,reject)=>{server.once("error",reject);server.listen(site.port,"127.0.0.1",accept);});return{server,ready};
}

function resolveRequestPath(siteRoot,requestPath){
  let decoded="";try{decoded=decodeURIComponent(requestPath);}catch{return null;}
  if(decoded.includes("\0")||decoded.split(/[\\/]/u).includes(".."))return null;
  const relative=normalize(decoded).replace(/^[/\\]+/u,"")||"index.html";const absolute=resolve(siteRoot,relative);return absolute===siteRoot||absolute.startsWith(`${siteRoot}${sep}`)?absolute:null;
}
function send(response,status,type,body){response.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store"});response.end(body);}
function openBrowser(url){const platform=process.platform;const command=platform==="win32"?"cmd":platform==="darwin"?"open":"xdg-open";const args=platform==="win32"?["/c","start","",url]:[url];const child=spawn(command,args,{detached:true,stdio:"ignore"});child.unref();}
function selfTest(){
  for(const site of sites){const index=join(site.root,"index.html");if(!existsSync(index))throw new Error(`${site.name} index missing`);const html=readFileSync(index,"utf8");if(!html.includes("<!doctype html")&&!html.includes("<!DOCTYPE html"))throw new Error(`${site.name} index invalid`);}
  if(resolveRequestPath(sites[0].root,"/../package.json")!==null)throw new Error("path traversal was not rejected");
  if(resolveRequestPath(sites[0].root,"/%2e%2e/package.json")!==null)throw new Error("encoded path traversal was not rejected");
  const bundles=readdirSync(sites[2].root,{recursive:true}).filter(value=>String(value).endsWith(".js"));if(!bundles.length)throw new Error("admin bundle missing");const bundledText=bundles.map(value=>readFileSync(join(sites[2].root,String(value)),"utf8")).join("\n");if(!bundles.length||!bundledText.includes("LIVE DEMO v5.6")||!bundledText.includes("本番Firebaseセットアップウィザード")||!bundledText.includes("承認付き本番デプロイ指揮コンソール")||!bundledText.includes("未達原因・改善再実行統制盤")||!bundledText.includes("EXECUTIVE OUTCOME & ROI")||!bundledText.includes("成果PDF")||!bundledText.includes("成果CSV")||!bundledText.includes("実行前")||!bundledText.includes("総合ROI")||!bundledText.includes("成果入力")||!bundledText.includes("OUTCOME RECOVERY LOOP")||!bundledText.includes("原因を固定して再実行")||!bundledText.includes("未達原因 → 改善案 → 再実行タスク")||!bundledText.includes("EXECUTIVE DECISION CONTROL")||!bundledText.includes("タスクPDF")||!bundledText.includes("タスクCSV")||!bundledText.includes("期限変更")||!bundledText.includes("再割当")||!bundledText.includes("EXECUTIVE RESPONSIBILITY WATCH")||!bundledText.includes("AUTO EXECUTIVE DELIVERY")||!bundledText.includes("EXECUTIVE DELIVERY HISTORY")||!bundledText.includes("自分の経営レポートを既読")||!bundledText.includes("24・48・72時間")||!bundledText.includes("履歴PDF")||!bundledText.includes("THRESHOLD ALERTS")||!bundledText.includes("経営レポートをコピー")||!bundledText.includes("PDF出力")||!bundledText.includes("確認済みにする")||!bundledText.includes("担当固定")||!bundledText.includes("分析CSV")||!bundledText.includes("RESPONSIBILITY INTELLIGENCE")||!bundledText.includes("OWNER LOAD HEATMAP")||!bundledText.includes("負荷分散・副担当・自動再割当")||!bundledText.includes("7日間 SLA PERFORMANCE")||!bundledText.includes("WEEK OVER WEEK")||!bundledText.includes("8 WEEK READ SLA")||!bundledText.includes("代理確認を固定")||!bundledText.includes("READ SLA RESPONSIBILITY")||!bundledText.includes("責任者として承認")||!bundledText.includes("自分宛てを既読にする")||!bundledText.includes("週次レポートをコピー")||!bundledText.includes("再発防止レビュー")||!bundledText.includes("担当を引継ぐ")||!bundledText.includes("30秒自動更新")||!bundledText.includes("Cloud Monitoring 実測生成・自動取込")||!bundledText.includes("本番運用・デプロイ自動診断"))throw new Error("v5.6 demo markers missing from admin bundle");
}
async function httpSmokeTest(){
  const expectations=[[basePort,"アプリを、いま見る。"],[basePort+1,"Lip Knots Crew"],[basePort+2,"Lip Knots Crew"]];
  for(const[port,marker]of expectations){const response=await fetch(`http://127.0.0.1:${port}/`);if(response.status!==200)throw new Error(`preview ${port} returned ${response.status}`);const body=await response.text();if(!body.includes(String(marker)))throw new Error(`preview ${port} marker missing`);}
}
