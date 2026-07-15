import {normalizeBranding} from "../src/tenant-branding-core";
function eq(a:unknown,b:unknown,m:string){if(a!==b)throw new Error(m);}
eq(normalizeBranding({companyName:"A社",primaryColor:"#123456",customDomain:"app.example.com"}).errors.length,0,"valid");
eq(normalizeBranding({companyName:"",primaryColor:"red"}).errors.length>=2,true,"invalid");
console.log("tenant branding core tests passed");
