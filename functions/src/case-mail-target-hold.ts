import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { assignmentPreparationPatch, resetApplicationConfirmation } from "./assignment-preparation-core";

/** 別メールの保留。元のmailIntake/mailIntakeHoldと業務条件を保持する。 */
export function caseMailTargetHoldPatch(job:Record<string,any>,hold:Record<string,unknown>,now:Timestamp) {
  const next={...job,mailTargetHold:hold,mailIntakeReviewRequired:true,revision:job.revision+1};
  return {...assignmentPreparationPatch(job,next),...resetApplicationConfirmation(),
    mailTargetHold:hold,mailIntakeReviewRequired:true,revision:next.revision,
    status:job.cancelled===true||job.status==="cancelled"?"cancelled":job.assignedStaffId||job.status==="assigned"?"assigned":job.status==="draft"?"draft":"stopped",
    publishable:false,recruitmentStopped:true,scheduledPublishAt:FieldValue.delete(),mailPublication:FieldValue.delete(),
    assignmentSheetWrite:null,preContactNeedsReview:true,preContactLate:false,updatedAt:now};
}
