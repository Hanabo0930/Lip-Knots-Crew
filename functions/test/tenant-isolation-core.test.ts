import {assertTenantAccess,tenantDocumentPath,tenantStoragePath} from "../src/tenant-isolation-core";
function eq(a:unknown,b:unknown,m:string){if(a!==b)throw new Error(m);}
assertTenantAccess({tenantId:"a1",role:"admin"},"a1",["admin"]);
let denied=false;try{assertTenantAccess({tenantId:"a1"},"b2");}catch{denied=true;}
eq(denied,true,"cross");
eq(tenantDocumentPath("a1","jobs","j1"),"tenants/a1/jobs/j1","path");
eq(tenantStoragePath("a1","reports","a/b.pdf"),"tenants/a1/reports/a_b.pdf","storage");
console.log("tenant isolation core tests passed");
