export type InvoiceRecord = {
  invoiceId:string;
  tenantId:string;
  amountYen:number;
  taxYen:number;
  status:"draft"|"open"|"paid"|"void"|"uncollectible";
  hostedInvoiceUrl?:string|null;
  receiptUrl?:string|null;
  dueDate?:string|null;
};

export function invoiceDisplayAmount(invoice:InvoiceRecord):number{
  return Math.max(0,Math.round(invoice.amountYen+invoice.taxYen));
}

export function invoiceAction(invoice:InvoiceRecord):
  "none"|"pay"|"download_receipt"|"contact_support"{
  if(invoice.status==="open")return"pay";
  if(invoice.status==="paid"&&invoice.receiptUrl)return"download_receipt";
  if(invoice.status==="uncollectible")return"contact_support";
  return"none";
}

export function validateInvoiceUrls(invoice:InvoiceRecord):string[]{
  const errors:string[]=[];
  for(const [label,value] of [
    ["請求書URL",invoice.hostedInvoiceUrl],
    ["領収書URL",invoice.receiptUrl],
  ] as const){
    if(!value)continue;
    try{
      const url=new URL(value);
      if(url.protocol!=="https:")errors.push(`${label}はHTTPSのみです。`);
    }catch{
      errors.push(`${label}が不正です。`);
    }
  }
  return errors;
}
