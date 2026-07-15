import { classifyArtifacts, driveFolderFor } from "../src/release-artifact-core";
function equal(a: unknown,b: unknown,m:string){if(a!==b)throw new Error(m);}
const result=classifyArtifacts([
 {name:"v1.6.zip",version:"1.6",kind:"source_zip",isLatest:true,containsSecrets:false,referencedByLatest:true,neededForAudit:false,ageDays:0},
 {name:"v1.5.zip",version:"1.5",kind:"source_zip",isLatest:false,containsSecrets:false,referencedByLatest:false,neededForAudit:false,ageDays:1},
 {name:"test.csv",version:"1.6",kind:"test_evidence",isLatest:true,containsSecrets:false,referencedByLatest:true,neededForAudit:true,ageDays:0},
 {name:"secret.json",version:"",kind:"secret",isLatest:false,containsSecrets:true,referencedByLatest:false,neededForAudit:false,ageDays:0},
]);
equal(result[0]?.decision,"keep_current","latest source");
equal(result[1]?.decision,"archive","old source");
equal(result[2]?.decision,"keep_evidence","evidence");
equal(result[3]?.decision,"delete_candidate","secret");
equal(driveFolderFor("keep_current"),"01_現行最新版","folder");
console.log("release artifact core tests passed");
