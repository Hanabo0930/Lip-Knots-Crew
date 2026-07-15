export type ClaimsLike={tenantId?:string;role?:string;superAdmin?:boolean};
export function assertTenantAccess(c:ClaimsLike,tenantId:string,roles:string[]=[]):void{
  if(!tenantId)throw new Error("tenantId is required");
  if(c.superAdmin===true)return;
  if(!c.tenantId||c.tenantId!==tenantId)throw new Error("cross-tenant access denied");
  if(roles.length&&!roles.includes(String(c.role??"")))throw new Error("role is not allowed");
}
export function tenantDocumentPath(tenantId:string,collection:string,id?:string){
  valid(tenantId);valid(collection);if(id)valid(id);
  return id?`tenants/${tenantId}/${collection}/${id}`:`tenants/${tenantId}/${collection}`;
}
export function tenantStoragePath(tenantId:string,category:string,filename:string){
  valid(tenantId);valid(category);
  const safe=filename.normalize("NFKC").replace(/[\\/:*?"<>|]/g,"_").replace(/\.\.+/g,"_").slice(0,180);
  if(!safe)throw new Error("filename is required");
  return`tenants/${tenantId}/${category}/${safe}`;
}
function valid(v:string){if(!/^[A-Za-z0-9_-]{2,100}$/.test(v))throw new Error("invalid identifier");}
