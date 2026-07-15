import {invoiceAction,invoiceDisplayAmount,validateInvoiceUrls} from "../src/invoice-core";
function eq(a:unknown,b:unknown,m:string){if(a!==b)throw new Error(m);}
const paid={invoiceId:"i1",tenantId:"a",amountYen:1000,taxYen:100,status:"paid" as const,receiptUrl:"https://example.com/r"};
eq(invoiceDisplayAmount(paid),1100,"amount");
eq(invoiceAction(paid),"download_receipt","action");
eq(validateInvoiceUrls(paid).length,0,"url");
eq(validateInvoiceUrls({...paid,receiptUrl:"http://example.com"}).length,1,"https");
console.log("invoice core tests passed");
