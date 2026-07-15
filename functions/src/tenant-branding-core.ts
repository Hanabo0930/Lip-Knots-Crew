export function normalizeBranding(input:{
  companyName:string;logoUrl?:string|null;primaryColor?:string|null;
  accentColor?:string|null;customDomain?:string|null;
}){
  const errors:string[]=[];
  const companyName=input.companyName.normalize("NFKC").trim();
  if(!companyName)errors.push("会社名は必須です。");
  const color=(v:string|null|undefined,f:string,l:string)=>{
    if(!v)return f;const x=v.trim().toUpperCase();
    if(!/^#[0-9A-F]{6}$/.test(x)){errors.push(`${l}は#RRGGBB形式です。`);return f;}return x;
  };
  let domain:string|null=null;
  if(input.customDomain){
    const d=input.customDomain.trim().toLowerCase().replace(/^https?:\/\//,"").replace(/\/.*$/,"");
    if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d))errors.push("独自ドメインが不正です。");else domain=d;
  }
  return{companyName,logoUrl:input.logoUrl??null,primaryColor:color(input.primaryColor,"#7A4D5D","メインカラー"),accentColor:color(input.accentColor,"#D9B55A","アクセントカラー"),customDomain:domain,errors};
}
