import type {SubmissionGroup} from "./App";

export function mergeSubmissionTimeline(data:unknown,current:SubmissionGroup[],target?:{submissionId:string;fileId:string}):SubmissionGroup[]{
  const groups=(data as {submissions?:SubmissionGroup[]}|null)?.submissions;
  if(!Array.isArray(groups)||groups.some(group=>!Array.isArray(group?.files)))throw new Error("提出履歴の応答を確認できませんでした。");
  if(!target)return groups;
  const matches=groups.filter(group=>group.id===target.submissionId);
  if(matches.length>1)throw new Error("提出情報が重複しています。");
  const files=matches[0]?.files.filter(file=>file?.id===target.fileId)??[];
  if(files.length>1||files.some(file=>file.submissionId!==target.submissionId))throw new Error("対象ファイルの応答が一致しません。");
  const fresh=files[0];
  if(fresh&&(![fresh.originalName,fresh.driveName,fresh.contentType,fresh.status,fresh.purpose].every(value=>typeof value==="string")||(fresh.previewUrl!==null&&typeof fresh.previewUrl!=="string")))throw new Error("ファイルの表示項目を確認できませんでした。");
  return current.map(group=>group.id!==target.submissionId?group:{...group,files:group.files.map(file=>file.id!==target.fileId?file:fresh??{...file,status:"unavailable",previewUrl:null})});
}