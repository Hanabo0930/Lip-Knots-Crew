'use strict';
// Field names are the existing ManualSelectionSchema; no values are inferred from mail/name input.
const required=['arrival','execution','headcount','dateMode','payOffer'];
function missingFormalManualFields(value){
 const missing=[];if(!value||typeof value!=='object')value={};
 for(const field of required)if(value.confirmedFields?.[field]!==true)missing.push('manualConfirmation.confirmedFields.'+field);
 if(!Number.isSafeInteger(value.payOffer?.dailyWageJPY)||value.payOffer.dailyWageJPY<1||value.payOffer.dailyWageJPY>1000000)missing.push('manualConfirmation.payOffer.dailyWageJPY');
 for(const field of ['travelExpenses','communicationExpenses'])if(value.payOffer?.[field]!=='全額支給')missing.push('manualConfirmation.payOffer.'+field);
 return missing;
}
module.exports={missingFormalManualFields};
