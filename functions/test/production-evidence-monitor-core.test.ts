import { strict as assert } from "node:assert";
import { ProductionEvidenceSummary } from "../src/production-evidence-core";
import { buildProductionEvidenceExecutiveDecisionTasksCsv, buildProductionEvidenceResponsibilityAnalyticsCsv, buildProductionEvidenceResponsibilityExecutiveDigest, buildProductionEvidenceWeeklyComparisonReport, buildProductionEvidenceWeeklyReport, compareProductionEvidenceSlaWeeks, decideProductionEvidenceNotification, diffProductionEvidence, evaluateProductionEvidenceAfterActionReviewReminder, evaluateProductionEvidenceAlertSla, evaluateProductionEvidenceExecutiveDecisionOutcome, evaluateProductionEvidenceExecutiveDecisionRecovery, evaluateProductionEvidenceExecutiveDecisionTaskDeadline, evaluateProductionEvidenceExecutiveReportReadReminder, evaluateProductionEvidenceHealth, evaluateProductionEvidenceResponsibilityAnalyticsAlerts, evaluateProductionEvidenceResponsibilityExecutiveDelivery, evaluateProductionEvidenceWeeklyReportDelivery, evaluateProductionEvidenceWeeklyReportReadReminder, evaluateProductionEvidenceWeeklyReportResponsibility, evaluateProductionEvidenceWeeklyResponsibilityReassignment, productionEvidenceAlertRunbook, productionEvidenceAlertSlaTargets, productionEvidenceResponsibilityAlertThresholds, productionEvidenceWeekKey, ProductionEvidenceAlertQueueItem, ProductionEvidenceExecutiveDecisionTask, rankProductionEvidenceWeeklyResponsibilityOwners, selectProductionEvidenceWeeklyResponsibilityOwner, summarizeProductionEvidenceAlerts, summarizeProductionEvidenceExecutiveDecisionTasks, summarizeProductionEvidenceExecutiveReportHistory, summarizeProductionEvidenceSlaPerformance, summarizeProductionEvidenceWeeklyReadTrend, summarizeProductionEvidenceWeeklyReportRecipients, summarizeProductionEvidenceWeeklyResponsibilityAnalytics } from "../src/production-evidence-monitor-core";

let cases=0;function test(name:string,fn:()=>void){try{fn();cases++;}catch(error){throw new Error(`${name}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}}
const baseTime=Date.parse("2026-07-14T06:00:00.000Z");
function summary(phase:ProductionEvidenceSummary["phase"],options:{acceptancePasses?:number;acceptanceRuns?:number;acceptanceAt?:string;acceptanceFailed?:string[];rollbackStatus?:string;rollbackAt?:string;recoveryPasses?:number;recoveryRuns?:number;recoveryAt?:string;recoveryFailed?:string[];packageFingerprint?:string}={}):ProductionEvidenceSummary{return{schemaVersion:1,releaseId:"v5.6.0",projectId:"lip-knots-production",phase,progressScore:score(phase),packageFingerprint:options.packageFingerprint??"a".repeat(64),deployment:{status:"succeeded",planFingerprint:"b".repeat(64),evidenceFingerprint:"c".repeat(64),approvedByEmail:"executive@example.jp",changeTicketId:"REL-410",completedAt:"2026-07-14T06:00:00.000Z",passedStages:8},acceptance:phase==="deployed"?null:{status:phase==="acceptance_observing"?"observing":phase==="accepted"?"accepted":"rollback_required",validPasses:options.acceptancePasses??0,requiredPasses:3,runCount:options.acceptanceRuns??1,failedCheckKeys:options.acceptanceFailed??[],ledgerFingerprint:"d".repeat(64),lastObservedAt:options.acceptanceAt??"2026-07-14T06:01:00.000Z",passedChecks:(options.acceptanceFailed??[]).length?8:9},rollback:options.rollbackStatus?{status:options.rollbackStatus,knownGoodReleaseId:"v5.1.0",planFingerprint:"e".repeat(64),evidenceFingerprint:"f".repeat(64),completedAt:options.rollbackAt??"2026-07-14T06:08:00.000Z",failedStageKey:options.rollbackStatus==="rollback_failed_locked"?"known_good_functions":null,completedStages:options.rollbackStatus==="rollback_failed_locked"?2:9}:null,recovery:phase.startsWith("recovery")||phase==="recovered"?{status:phase==="recovered"?"accepted":phase==="recovery_failed_locked"?"rollback_required":"observing",releaseId:"v5.1.0",validPasses:options.recoveryPasses??0,requiredPasses:3,runCount:options.recoveryRuns??1,failedCheckKeys:options.recoveryFailed??[],ledgerFingerprint:"1".repeat(64),lastObservedAt:options.recoveryAt??"2026-07-14T06:09:00.000Z",passedChecks:(options.recoveryFailed??[]).length?8:9}:null,timeline:[]};}
function score(phase:ProductionEvidenceSummary["phase"]){return{deployed:100,acceptance_observing:221,accepted:300,rollback_required:400,rollback_failed_locked:500,rollback_succeeded:600,recovery_observing:721,recovery_failed_locked:800,recovered:900}[phase];}

test("initial diff",()=>{const value=diffProductionEvidence(null,summary("deployed"));assert.equal(value.kind,"initial");assert.deepEqual(value.changedKeys,["initial_import"]);});
test("no change",()=>{const value=summary("accepted");assert.equal(diffProductionEvidence(value,value).kind,"no_change");});
test("phase progress diff",()=>{const value=diffProductionEvidence(summary("deployed"),summary("acceptance_observing",{acceptancePasses:1}));assert.equal(value.kind,"progress");assert.ok(value.changedKeys.includes("phase"));assert.equal(value.acceptancePassDelta,1);});
test("package only diff",()=>assert.equal(diffProductionEvidence(summary("accepted"),summary("accepted",{packageFingerprint:"2".repeat(64)})).kind,"progress"));
test("failure diff alert",()=>assert.equal(diffProductionEvidence(summary("acceptance_observing"),summary("rollback_required",{acceptanceFailed:["staff_app"]})).kind,"alert"));
test("recovery delta",()=>assert.equal(diffProductionEvidence(summary("recovery_observing",{rollbackStatus:"rollback_succeeded",recoveryPasses:1}),summary("recovery_observing",{rollbackStatus:"rollback_succeeded",recoveryPasses:2,packageFingerprint:"2".repeat(64)})).recoveryPassDelta,1));
test("deterministic diff",()=>assert.equal(diffProductionEvidence(null,summary("deployed")).fingerprint,diffProductionEvidence(null,summary("deployed")).fingerprint));

test("deployed on time",()=>assert.equal(evaluateProductionEvidenceHealth(summary("deployed"),baseTime+6*60_000).status,"healthy"));
test("deployed watch",()=>assert.equal(evaluateProductionEvidenceHealth(summary("deployed"),baseTime+10*60_000).status,"watch"));
test("deployed critical",()=>assert.equal(evaluateProductionEvidenceHealth(summary("deployed"),baseTime+17*60_000).status,"critical"));
test("acceptance on time",()=>assert.equal(evaluateProductionEvidenceHealth(summary("acceptance_observing"),baseTime+7*60_000).status,"healthy"));
test("acceptance watch",()=>assert.equal(evaluateProductionEvidenceHealth(summary("acceptance_observing"),baseTime+10*60_000).status,"watch"));
test("acceptance critical",()=>assert.equal(evaluateProductionEvidenceHealth(summary("acceptance_observing"),baseTime+18*60_000).status,"critical"));
test("accepted complete",()=>assert.equal(evaluateProductionEvidenceHealth(summary("accepted"),baseTime+60*60_000).status,"complete"));
test("rollback required critical",()=>assert.deepEqual(evaluateProductionEvidenceHealth(summary("rollback_required"),baseTime).reasonKeys,["acceptance_failed","rollback_required"]));
test("rollback failed critical",()=>assert.equal(evaluateProductionEvidenceHealth(summary("rollback_failed_locked",{rollbackStatus:"rollback_failed_locked"}),baseTime).status,"critical"));
test("rollback success watch",()=>assert.equal(evaluateProductionEvidenceHealth(summary("rollback_succeeded",{rollbackStatus:"rollback_succeeded"}),baseTime+14*60_000).status,"watch"));
test("rollback recovery overdue",()=>assert.equal(evaluateProductionEvidenceHealth(summary("rollback_succeeded",{rollbackStatus:"rollback_succeeded"}),baseTime+16*60_000).status,"critical"));
test("recovery in progress watch",()=>assert.equal(evaluateProductionEvidenceHealth(summary("recovery_observing",{rollbackStatus:"rollback_succeeded"}),baseTime+14*60_000).status,"watch"));
test("recovery overdue critical",()=>assert.equal(evaluateProductionEvidenceHealth(summary("recovery_observing",{rollbackStatus:"rollback_succeeded"}),baseTime+18*60_000).status,"critical"));
test("recovery failed critical",()=>assert.equal(evaluateProductionEvidenceHealth(summary("recovery_failed_locked",{rollbackStatus:"rollback_succeeded",recoveryFailed:["admin_app"]}),baseTime).status,"critical"));
test("recovered complete",()=>assert.equal(evaluateProductionEvidenceHealth(summary("recovered",{rollbackStatus:"rollback_succeeded",recoveryPasses:3}),baseTime+90*60_000).status,"complete"));
test("deadline stable",()=>assert.equal(evaluateProductionEvidenceHealth(summary("deployed"),baseTime).deadlineAt,"2026-07-14T06:07:00.000Z"));
test("health fingerprint stable",()=>assert.equal(evaluateProductionEvidenceHealth(summary("deployed"),baseTime).fingerprint,evaluateProductionEvidenceHealth(summary("deployed"),baseTime+60_000).fingerprint));

const critical=evaluateProductionEvidenceHealth(summary("rollback_required"),baseTime);const watch=evaluateProductionEvidenceHealth(summary("rollback_succeeded",{rollbackStatus:"rollback_succeeded"}),baseTime+10*60_000);const complete=evaluateProductionEvidenceHealth(summary("recovered",{rollbackStatus:"rollback_succeeded",recoveryPasses:3}),baseTime);
test("new critical notify",()=>assert.equal(decideProductionEvidenceNotification({previous:null,current:critical,nowMs:baseTime}).shouldNotify,true));
test("critical dedupe",()=>assert.equal(decideProductionEvidenceNotification({previous:critical,current:critical,lastAlertFingerprint:critical.fingerprint,lastAlertAtMs:baseTime,nowMs:baseTime+10*60_000}).shouldNotify,false));
test("critical reminder",()=>assert.equal(decideProductionEvidenceNotification({previous:critical,current:critical,lastAlertFingerprint:critical.fingerprint,lastAlertAtMs:baseTime,nowMs:baseTime+31*60_000}).shouldNotify,true));
test("ack suppresses changed alert",()=>assert.equal(decideProductionEvidenceNotification({previous:null,current:critical,lastAlertAtMs:baseTime,acknowledgedFingerprint:critical.fingerprint,nowMs:baseTime+10*60_000}).shouldNotify,false));
test("new watch notify",()=>assert.equal(decideProductionEvidenceNotification({previous:null,current:watch,nowMs:baseTime}).shouldNotify,true));
test("watch dedupe",()=>assert.equal(decideProductionEvidenceNotification({previous:watch,current:watch,nowMs:baseTime}).shouldNotify,false));
test("recovered notify",()=>assert.equal(decideProductionEvidenceNotification({previous:critical,current:complete,nowMs:baseTime}).kind,"recovered"));
test("healthy no notify",()=>assert.equal(decideProductionEvidenceNotification({previous:null,current:evaluateProductionEvidenceHealth(summary("deployed"),baseTime),nowMs:baseTime}).shouldNotify,false));
test("critical urgent",()=>assert.equal(decideProductionEvidenceNotification({previous:null,current:critical,nowMs:baseTime}).urgent,true));

test("acceptance runbook",()=>assert.equal(productionEvidenceAlertRunbook("acceptance_observing").command,"npm run acceptance:production"));
test("deployed runbook",()=>assert.equal(productionEvidenceAlertRunbook("deployed").actionKey,"run_acceptance"));
test("rollback runbook",()=>assert.equal(productionEvidenceAlertRunbook("rollback_required").command,"npm run rollback:production:prepare"));
test("rollback failure runbook",()=>assert.equal(productionEvidenceAlertRunbook("rollback_failed_locked").actionKey,"inspect_rollback_failure"));
test("recovery runbook",()=>assert.equal(productionEvidenceAlertRunbook("recovery_observing").command,"npm run acceptance:production:recovery"));
test("recovery failure runbook",()=>assert.equal(productionEvidenceAlertRunbook("recovery_failed_locked").actionKey,"inspect_recovery_failure"));

const alerts:ProductionEvidenceAlertQueueItem[]=[
  {alertId:"resolved-critical",fingerprint:"1".repeat(64),status:"resolved",priority:"critical",phase:"rollback_required",headline:"resolved",nextAction:"none",firstDetectedAt:"2026-07-14T06:00:00.000Z",lastDetectedAt:"2026-07-14T06:05:00.000Z"},
  {alertId:"open-watch",fingerprint:"2".repeat(64),status:"open",priority:"watch",phase:"deployed",headline:"watch",nextAction:"acceptance",firstDetectedAt:"2026-07-14T06:10:00.000Z",lastDetectedAt:"2026-07-14T06:10:00.000Z"},
  {alertId:"progress-critical",fingerprint:"3".repeat(64),status:"in_progress",priority:"critical",phase:"rollback_required",headline:"critical",nextAction:"rollback",firstDetectedAt:"2026-07-14T06:20:00.000Z",lastDetectedAt:"2026-07-14T06:21:00.000Z"},
  {alertId:"ack-watch",fingerprint:"4".repeat(64),status:"acknowledged",priority:"watch",phase:"recovery_observing",headline:"ack",nextAction:"recovery",firstDetectedAt:"2026-07-14T06:30:00.000Z",lastDetectedAt:"2026-07-14T06:30:00.000Z"},
  {alertId:"open-critical",fingerprint:"5".repeat(64),status:"open",priority:"critical",phase:"rollback_failed_locked",headline:"open critical",nextAction:"inspect",firstDetectedAt:"2026-07-14T06:40:00.000Z",lastDetectedAt:"2026-07-14T06:40:00.000Z"},
];
test("queue total",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).total,5));
test("queue unresolved",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).unresolved,4));
test("queue critical",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).critical,2));
test("queue in progress",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).inProgress,1));
test("open critical first",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).items[0]!.alertId,"open-critical"));
test("critical response before watch",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).items[1]!.alertId,"progress-critical"));
test("open watch before acknowledged",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).items[2]!.alertId,"open-watch"));
test("resolved last",()=>assert.equal(summarizeProductionEvidenceAlerts(alerts).items.at(-1)?.alertId,"resolved-critical"));
test("queue input immutable",()=>{summarizeProductionEvidenceAlerts(alerts);assert.equal(alerts[0]!.alertId,"resolved-critical");});

const slaAlert=(overrides:Partial<ProductionEvidenceAlertQueueItem>={}):ProductionEvidenceAlertQueueItem=>({alertId:"sla-alert",fingerprint:"9".repeat(64),status:"open",priority:"critical",phase:"rollback_required",headline:"critical",nextAction:"rollback",firstDetectedAt:"2026-07-14T06:00:00.000Z",lastDetectedAt:"2026-07-14T06:00:00.000Z",...overrides});
test("critical SLA targets",()=>assert.deepEqual(productionEvidenceAlertSlaTargets("critical"),{acknowledgementTargetMinutes:5,responseTargetMinutes:10,handoffTargetMinutes:10}));
test("watch SLA targets",()=>assert.deepEqual(productionEvidenceAlertSlaTargets("watch"),{acknowledgementTargetMinutes:15,responseTargetMinutes:30,handoffTargetMinutes:30}));
test("critical SLA on track",()=>assert.equal(evaluateProductionEvidenceAlertSla(slaAlert(),baseTime+60_000).status,"on_track"));
test("critical acknowledgement due",()=>{const value=evaluateProductionEvidenceAlertSla(slaAlert(),baseTime+3*60_000);assert.equal(value.status,"ack_due");assert.equal(value.escalationLevel,1);});
test("critical response due",()=>{const value=evaluateProductionEvidenceAlertSla(slaAlert(),baseTime+5*60_000);assert.equal(value.stage,"response");assert.equal(value.escalationLevel,2);});
test("critical SLA breached",()=>{const value=evaluateProductionEvidenceAlertSla(slaAlert(),baseTime+10*60_000);assert.equal(value.status,"breached");assert.equal(value.escalationKey,"response:3");});
test("acknowledged waits for response",()=>assert.equal(evaluateProductionEvidenceAlertSla(slaAlert({status:"acknowledged",acknowledgedAt:"2026-07-14T06:04:00.000Z"}),baseTime+6*60_000).status,"response_due"));
test("response SLA met",()=>assert.equal(evaluateProductionEvidenceAlertSla(slaAlert({status:"in_progress",responseStartedAt:"2026-07-14T06:09:00.000Z"}),baseTime+20*60_000).status,"met"));
test("late response remains recorded",()=>{const value=evaluateProductionEvidenceAlertSla(slaAlert({status:"in_progress",responseStartedAt:"2026-07-14T06:11:00.000Z"}),baseTime+20*60_000);assert.equal(value.status,"breached");assert.equal(value.escalationLevel,0);});
test("handoff waiting",()=>assert.equal(evaluateProductionEvidenceAlertSla(slaAlert({status:"in_progress",responseStartedAt:"2026-07-14T06:02:00.000Z",handoffPending:true,handoffAt:"2026-07-14T06:20:00.000Z"}),baseTime+25*60_000).label,"引継ぎ受領待ち"));
test("handoff due escalation",()=>assert.equal(evaluateProductionEvidenceAlertSla(slaAlert({status:"in_progress",responseStartedAt:"2026-07-14T06:02:00.000Z",handoffPending:true,handoffAt:"2026-07-14T06:20:00.000Z"}),baseTime+27*60_000).escalationLevel,2));
test("handoff SLA breached",()=>{const value=evaluateProductionEvidenceAlertSla(slaAlert({status:"in_progress",responseStartedAt:"2026-07-14T06:02:00.000Z",handoffPending:true,handoffAt:"2026-07-14T06:20:00.000Z"}),baseTime+30*60_000);assert.equal(value.status,"breached");assert.equal(value.stage,"handoff");});
test("resolved SLA met",()=>assert.equal(evaluateProductionEvidenceAlertSla(slaAlert({status:"resolved"}),baseTime+60*60_000).status,"met"));
test("SLA deadlines stable",()=>{const value=evaluateProductionEvidenceAlertSla(slaAlert(),baseTime);assert.equal(value.acknowledgementDeadlineAt,"2026-07-14T06:05:00.000Z");assert.equal(value.responseDeadlineAt,"2026-07-14T06:10:00.000Z");});
test("queue SLA counters",()=>{const source=[slaAlert({sla:evaluateProductionEvidenceAlertSla(slaAlert(),baseTime+10*60_000)}),slaAlert({alertId:"handoff",handoffPending:true,handoffAt:"2026-07-14T06:00:00.000Z",sla:evaluateProductionEvidenceAlertSla(slaAlert({handoffPending:true,handoffAt:"2026-07-14T06:00:00.000Z"}),baseTime+10*60_000)})];const value=summarizeProductionEvidenceAlerts(source);assert.equal(value.slaBreached,2);assert.equal(value.escalated,2);assert.equal(value.handoffPending,1);});

const performanceNow=baseTime+2*60*60_000;
const performanceAlerts:ProductionEvidenceAlertQueueItem[]=[
  slaAlert({alertId:"fast",status:"resolved",reasonKeys:["rollback_required"],acknowledgedAt:"2026-07-14T06:04:00.000Z",responseStartedAt:"2026-07-14T06:09:00.000Z",resolvedAt:"2026-07-14T06:30:00.000Z",assignedToEmail:"admin@example.jp",handoffCount:1}),
  slaAlert({alertId:"late-watch",priority:"watch",status:"resolved",reasonKeys:["acceptance_run_due"],firstDetectedAt:"2026-07-14T06:10:00.000Z",acknowledgedAt:"2026-07-14T06:26:00.000Z",responseStartedAt:"2026-07-14T06:42:00.000Z",resolvedAt:"2026-07-14T07:00:00.000Z",assignedToEmail:"admin@example.jp",maximumEscalationLevel:3,reviewStatus:"completed"}),
  slaAlert({alertId:"active-breach",status:"open",reasonKeys:["rollback_required"],firstDetectedAt:"2026-07-14T07:50:00.000Z",assignedToEmail:null}),
];
const performance=summarizeProductionEvidenceSlaPerformance(performanceAlerts,performanceNow);
test("weekly performance period",()=>{assert.equal(performance.period.days,7);assert.equal(performance.period.startAt,"2026-07-07T15:00:00.000Z");});
test("weekly performance totals",()=>{assert.equal(performance.totalAlerts,3);assert.equal(performance.criticalAlerts,2);assert.equal(performance.resolvedAlerts,2);assert.equal(performance.activeAlerts,1);});
test("weekly acknowledgement SLA",()=>assert.equal(performance.acknowledgementSlaRate,33));
test("weekly response SLA",()=>assert.equal(performance.responseSlaRate,33));
test("weekly breach count",()=>{assert.equal(performance.breachedAlerts,2);assert.equal(performance.atRiskAlerts,1);});
test("weekly average acknowledgement",()=>assert.equal(performance.averageAcknowledgementMinutes,10));
test("weekly average response",()=>assert.equal(performance.averageResponseMinutes,20.5));
test("weekly average resolution",()=>assert.equal(performance.averageResolutionMinutes,40));
test("weekly handoff total",()=>assert.equal(performance.handoffCount,1));
test("weekly review completion",()=>{assert.equal(performance.reviewRequired,2);assert.equal(performance.reviewCompleted,1);assert.equal(performance.reviewPending,1);});
test("weekly grade",()=>{assert.equal(performance.grade,"D");assert.equal(performance.score,28);});
test("weekly daily trend",()=>{assert.equal(performance.daily.at(-1)?.alerts,3);assert.equal(performance.daily.at(-1)?.breaches,2);});
test("weekly hotspot ranking",()=>{assert.equal(performance.hotspots[0]?.key,"rollback_required");assert.equal(performance.hotspots[0]?.alerts,2);});
test("weekly owner load",()=>{assert.equal(performance.ownerLoad[0]?.email,"未割当");assert.equal(performance.ownerLoad[0]?.active,1);});
test("weekly recommendations",()=>assert.ok(performance.recommendations.some(value=>value.includes("再発防止レビュー未完了1件"))));
test("weekly report text",()=>{const report=buildProductionEvidenceWeeklyReport(performance);assert.match(report,/本番SLA週次レポート/u);assert.match(report,/対応開始 33%/u);assert.match(report,/未完了 1件/u);});
test("weekly period excludes old alerts",()=>assert.equal(summarizeProductionEvidenceSlaPerformance([...performanceAlerts,slaAlert({alertId:"old",firstDetectedAt:"2026-06-01T00:00:00.000Z"})],performanceNow).totalAlerts,3));
test("empty weekly performance is healthy",()=>{const value=summarizeProductionEvidenceSlaPerformance([],performanceNow);assert.equal(value.grade,"A");assert.equal(value.responseSlaRate,100);});

const comparisonAlerts:ProductionEvidenceAlertQueueItem[]=[
  slaAlert({alertId:"previous-breach",status:"resolved",firstDetectedAt:"2026-07-06T06:00:00.000Z",resolvedAt:"2026-07-06T08:00:00.000Z",maximumEscalationLevel:3}),
  slaAlert({alertId:"current-fast",status:"resolved",firstDetectedAt:"2026-07-14T06:00:00.000Z",acknowledgedAt:"2026-07-14T06:02:00.000Z",responseStartedAt:"2026-07-14T06:05:00.000Z",resolvedAt:"2026-07-14T06:20:00.000Z"}),
];
const comparison=compareProductionEvidenceSlaWeeks(comparisonAlerts,performanceNow);
test("weekly comparison windows",()=>{assert.equal(comparison.current.totalAlerts,1);assert.equal(comparison.previous.totalAlerts,1);assert.equal(comparison.previous.period.endAt,"2026-07-07T14:59:59.999Z");});
test("weekly comparison improved",()=>{assert.equal(comparison.direction,"improved");assert.ok(comparison.deltas.score>0);assert.equal(comparison.deltas.breachedAlerts,-1);});
test("weekly comparison highlights",()=>assert.ok(comparison.highlights.some(value=>value.includes("超過 -1件"))));
test("comparison report text",()=>{const report=buildProductionEvidenceWeeklyComparisonReport(comparison);assert.match(report,/前週比較/u);assert.match(report,/前週評価/u);assert.match(report,/超過 -1件/u);});
test("stable weekly comparison",()=>assert.equal(compareProductionEvidenceSlaWeeks([],performanceNow).direction,"stable"));

const mondayNine=Date.parse("2026-07-13T00:00:00.000Z");
test("Tokyo week key",()=>assert.equal(productionEvidenceWeekKey(mondayNine),"2026-07-13"));
test("Sunday uses previous week key",()=>assert.equal(productionEvidenceWeekKey(Date.parse("2026-07-12T03:00:00.000Z")),"2026-07-06"));
test("weekly report waits until Monday 09",()=>assert.equal(evaluateProductionEvidenceWeeklyReportDelivery(null,mondayNine-1).shouldDeliver,false));
test("weekly report becomes due",()=>assert.equal(evaluateProductionEvidenceWeeklyReportDelivery(null,mondayNine).shouldDeliver,true));
test("weekly report dedupe",()=>assert.equal(evaluateProductionEvidenceWeeklyReportDelivery("2026-07-13",mondayNine+60_000).shouldDeliver,false));
test("weekly report next schedule",()=>assert.equal(evaluateProductionEvidenceWeeklyReportDelivery("2026-07-13",mondayNine).nextScheduledAt,"2026-07-20T00:00:00.000Z"));
const tuesdayNine=Date.parse("2026-07-14T00:00:00.000Z");
test("executive report waits until Tuesday 09",()=>assert.equal(evaluateProductionEvidenceResponsibilityExecutiveDelivery(null,tuesdayNine-1).shouldDeliver,false));
test("executive report becomes due Tuesday",()=>assert.equal(evaluateProductionEvidenceResponsibilityExecutiveDelivery(null,tuesdayNine).shouldDeliver,true));
test("executive report uses Monday week",()=>assert.equal(evaluateProductionEvidenceResponsibilityExecutiveDelivery(null,tuesdayNine).weekKey,"2026-07-13"));
test("executive report deduplicates week",()=>assert.equal(evaluateProductionEvidenceResponsibilityExecutiveDelivery("2026-07-13",tuesdayNine).shouldDeliver,false));
test("executive report schedules next Tuesday",()=>assert.equal(evaluateProductionEvidenceResponsibilityExecutiveDelivery("2026-07-13",tuesdayNine).nextScheduledAt,"2026-07-21T00:00:00.000Z"));
test("executive report delivery key is deterministic",()=>assert.equal(evaluateProductionEvidenceResponsibilityExecutiveDelivery(null,tuesdayNine).deliveryKey,evaluateProductionEvidenceResponsibilityExecutiveDelivery(null,tuesdayNine+60_000).deliveryKey));

const reminderNow=Date.parse("2026-07-15T00:15:00.000Z");
test("review outside reminder window",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"in_progress",dueAt:new Date(reminderNow+25*60*60_000).toISOString()},reminderNow).status,"none"));
test("review due soon",()=>{const value=evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:new Date(reminderNow+12*60*60_000).toISOString()},reminderNow);assert.equal(value.status,"due_soon");assert.equal(value.shouldNotify,true);assert.equal(value.dueInHours,12);});
test("review overdue urgent",()=>{const value=evaluateProductionEvidenceAfterActionReviewReminder({status:"in_progress",dueAt:new Date(reminderNow-25*60*60_000).toISOString()},reminderNow);assert.equal(value.status,"overdue");assert.equal(value.urgent,true);assert.equal(value.overdueDays,2);});
test("review reminder daily dedupe",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:new Date(reminderNow+12*60*60_000).toISOString(),lastReminderAt:"2026-07-15T00:05:00.000Z"},reminderNow).shouldNotify,false));
test("review reminder next day",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:new Date(reminderNow-60_000).toISOString(),lastReminderAt:"2026-07-14T00:05:00.000Z"},reminderNow).shouldNotify,true));
test("completed review never reminds",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"completed",dueAt:new Date(reminderNow-60_000).toISOString()},reminderNow).status,"none"));
test("invalid review due date safe",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:"bad"},reminderNow).shouldNotify,false));
test("review due soon has no escalation",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:new Date(reminderNow+12*60*60_000).toISOString()},reminderNow).escalationLevel,0));
test("review overdue LEVEL 1",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:new Date(reminderNow-60*60_000).toISOString()},reminderNow).escalationLevel,1));
test("review overdue LEVEL 2",()=>assert.equal(evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:new Date(reminderNow-25*60*60_000).toISOString()},reminderNow).escalationLevel,2));
test("review overdue LEVEL 3",()=>{const value=evaluateProductionEvidenceAfterActionReviewReminder({status:"open",dueAt:new Date(reminderNow-73*60*60_000).toISOString()},reminderNow);assert.equal(value.escalationLevel,3);assert.match(value.label,/LEVEL 3/u);assert.match(value.reminderKey??"",/^overdue_3_/u);});

const weeklyDeliveredAt=new Date(reminderNow-24*60*60_000).toISOString();
test("read weekly report never reminds",()=>assert.equal(evaluateProductionEvidenceWeeklyReportReadReminder({status:"read",deliveredAt:weeklyDeliveredAt},reminderNow).status,"none"));
test("proxy read weekly report never reminds",()=>{const value=evaluateProductionEvidenceWeeklyReportReadReminder({status:"proxy_read",deliveredAt:weeklyDeliveredAt},reminderNow);assert.equal(value.status,"none");assert.equal(value.label,"代理確認済み");});
test("unresolved weekly recipient never reminds",()=>assert.equal(evaluateProductionEvidenceWeeklyReportReadReminder({status:"unresolved",deliveredAt:weeklyDeliveredAt},reminderNow).shouldNotify,false));
test("weekly unread waits first 24 hours",()=>{const value=evaluateProductionEvidenceWeeklyReportReadReminder({status:"unread",deliveredAt:new Date(reminderNow-23*60*60_000).toISOString()},reminderNow);assert.equal(value.status,"waiting");assert.equal(value.shouldNotify,false);});
test("weekly unread LEVEL 1",()=>{const value=evaluateProductionEvidenceWeeklyReportReadReminder({status:"unread",deliveredAt:weeklyDeliveredAt},reminderNow);assert.equal(value.status,"remind");assert.equal(value.escalationLevel,1);assert.equal(value.shouldNotify,true);});
test("weekly unread LEVEL 2",()=>{const value=evaluateProductionEvidenceWeeklyReportReadReminder({status:"unread",deliveredAt:new Date(reminderNow-49*60*60_000).toISOString(),reminderCount:1},reminderNow);assert.equal(value.escalationLevel,2);assert.match(value.reminderKey??"",/^unread_2_/u);});
test("weekly unread LEVEL 3 urgent",()=>{const value=evaluateProductionEvidenceWeeklyReportReadReminder({status:"unread",deliveredAt:new Date(reminderNow-73*60*60_000).toISOString(),reminderCount:2},reminderNow);assert.equal(value.status,"escalated");assert.equal(value.escalationLevel,3);assert.equal(value.urgent,true);});
test("weekly unread stops after three reminders",()=>{const value=evaluateProductionEvidenceWeeklyReportReadReminder({status:"unread",deliveredAt:new Date(reminderNow-96*60*60_000).toISOString(),reminderCount:3,escalationLevel:3},reminderNow);assert.equal(value.shouldNotify,false);assert.equal(value.escalationLevel,3);});
test("weekly unread daily dedupe",()=>assert.equal(evaluateProductionEvidenceWeeklyReportReadReminder({status:"unread",deliveredAt:new Date(reminderNow-49*60*60_000).toISOString(),reminderCount:1,lastReminderAt:"2026-07-15T00:05:00.000Z"},reminderNow).shouldNotify,false));
test("weekly unread reminds on next Tokyo day",()=>assert.equal(evaluateProductionEvidenceWeeklyReportReadReminder({status:"unread",deliveredAt:new Date(reminderNow-49*60*60_000).toISOString(),reminderCount:1,lastReminderAt:"2026-07-14T00:05:00.000Z"},reminderNow).shouldNotify,true));
test("responsibility completed read",()=>assert.equal(evaluateProductionEvidenceWeeklyReportResponsibility({status:"read",deliveredAt:weeklyDeliveredAt},reminderNow).status,"complete"));
test("responsibility safe",()=>{const value=evaluateProductionEvidenceWeeklyReportResponsibility({status:"unread",deliveredAt:new Date(reminderNow-6*60*60_000).toISOString()},reminderNow);assert.equal(value.status,"safe");assert.equal(value.shouldAssign,false);});
test("responsibility watch",()=>assert.equal(evaluateProductionEvidenceWeeklyReportResponsibility({status:"unread",deliveredAt:new Date(reminderNow-13*60*60_000).toISOString()},reminderNow).status,"watch"));
test("responsibility predicts breach",()=>{const value=evaluateProductionEvidenceWeeklyReportResponsibility({status:"unread",deliveredAt:new Date(reminderNow-21*60*60_000).toISOString()},reminderNow);assert.equal(value.status,"at_risk");assert.equal(value.hoursRemaining,3);assert.equal(value.shouldAssign,true);});
test("responsibility pending approval",()=>{const value=evaluateProductionEvidenceWeeklyReportResponsibility({status:"unread",deliveredAt:new Date(reminderNow-21*60*60_000).toISOString(),assignedToEmail:"owner@example.jp",approvalStatus:"pending"},reminderNow);assert.equal(value.shouldAssign,false);assert.equal(value.requiresApproval,true);});
test("responsibility approved",()=>assert.equal(evaluateProductionEvidenceWeeklyReportResponsibility({status:"unread",deliveredAt:new Date(reminderNow-21*60*60_000).toISOString(),assignedToEmail:"owner@example.jp",approvalStatus:"approved"},reminderNow).requiresApproval,false));
test("responsibility overdue",()=>{const value=evaluateProductionEvidenceWeeklyReportResponsibility({status:"unread",deliveredAt:new Date(reminderNow-28*60*60_000).toISOString()},reminderNow);assert.equal(value.status,"overdue");assert.equal(value.overdueHours,4);assert.equal(value.riskScore,100);});
test("responsibility unresolved immediately at risk",()=>{const value=evaluateProductionEvidenceWeeklyReportResponsibility({status:"unresolved",deliveredAt:new Date(reminderNow-1*60*60_000).toISOString()},reminderNow);assert.equal(value.status,"at_risk");assert.equal(value.riskScore,95);assert.equal(value.shouldAssign,true);});
test("responsibility invalid delivery assigns",()=>assert.equal(evaluateProductionEvidenceWeeklyReportResponsibility({status:"unread",deliveredAt:null},reminderNow).shouldAssign,true));
test("responsibility owner deterministic and excludes recipient",()=>{const admins=["recipient@example.jp","a@example.jp","b@example.jp"];const first=selectProductionEvidenceWeeklyResponsibilityOwner("recipient@example.jp","2026-07-13",admins);assert.equal(first,selectProductionEvidenceWeeklyResponsibilityOwner("recipient@example.jp","2026-07-13",admins));assert.notEqual(first,"recipient@example.jp");});
test("responsibility owner unavailable",()=>assert.equal(selectProductionEvidenceWeeklyResponsibilityOwner("only@example.jp","2026-07-13",["only@example.jp"]),null));
test("approved responsibility never reassigns",()=>assert.equal(evaluateProductionEvidenceWeeklyResponsibilityReassignment({status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"owner@example.jp",approvalStatus:"approved",approvalDeadlineAt:new Date(reminderNow-60_000).toISOString()},reminderNow).status,"none"));
test("responsibility reassignment waits for deadline",()=>{const value=evaluateProductionEvidenceWeeklyResponsibilityReassignment({status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"owner@example.jp",approvalStatus:"pending",approvalDeadlineAt:new Date(reminderNow+31*60_000).toISOString()},reminderNow);assert.equal(value.status,"waiting");assert.equal(value.remainingMinutes,31);});
test("expired approval deadline reassigns",()=>{const value=evaluateProductionEvidenceWeeklyResponsibilityReassignment({status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"owner@example.jp",approvalStatus:"pending",approvalDeadlineAt:new Date(reminderNow-61*60_000).toISOString()},reminderNow);assert.equal(value.status,"expired");assert.equal(value.shouldReassign,true);assert.equal(value.urgent,true);});
test("invalid approval deadline reassigns",()=>assert.equal(evaluateProductionEvidenceWeeklyResponsibilityReassignment({status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"owner@example.jp",approvalStatus:"pending",approvalDeadlineAt:null},reminderNow).shouldReassign,true));
test("reassignment limit escalates",()=>{const value=evaluateProductionEvidenceWeeklyResponsibilityReassignment({status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"owner@example.jp",approvalStatus:"pending",approvalDeadlineAt:new Date(reminderNow-60_000).toISOString(),reassignmentCount:2},reminderNow);assert.equal(value.status,"escalated");assert.equal(value.shouldEscalate,true);assert.equal(value.escalationKey,"approval_exhausted_2");});
test("read responsibility never reassigns",()=>assert.equal(evaluateProductionEvidenceWeeklyResponsibilityReassignment({status:"read",deliveredAt:weeklyDeliveredAt,assignedToEmail:"owner@example.jp",approvalStatus:"pending",approvalDeadlineAt:new Date(reminderNow-60_000).toISOString()},reminderNow).shouldReassign,false));
test("responsibility owner ranking favors lower load",()=>{const value=rankProductionEvidenceWeeklyResponsibilityOwners("recipient@example.jp","2026-07-13",["a@example.jp","b@example.jp"],{"a@example.jp":4,"b@example.jp":1});assert.equal(value.primary,"b@example.jp");assert.equal(value.backup,"a@example.jp");});
test("responsibility owner ranking supplies backup",()=>assert.ok(rankProductionEvidenceWeeklyResponsibilityOwners("recipient@example.jp","2026-07-13",["a@example.jp","b@example.jp"]).backup));
test("responsibility owner ranking excludes recipient and previous owners",()=>{const value=rankProductionEvidenceWeeklyResponsibilityOwners("recipient@example.jp","2026-07-13",["recipient@example.jp","a@example.jp","b@example.jp"],{},["a@example.jp"]);assert.equal(value.primary,"b@example.jp");assert.equal(value.backup,null);});
test("responsibility owner ranking is deterministic on equal load",()=>{const input=["a@example.jp","b@example.jp","c@example.jp"];assert.deepEqual(rankProductionEvidenceWeeklyResponsibilityOwners("recipient@example.jp","2026-07-13",input).candidates,rankProductionEvidenceWeeklyResponsibilityOwners("recipient@example.jp","2026-07-13",input).candidates);});
test("responsibility owner ranking handles no candidate",()=>{const value=rankProductionEvidenceWeeklyResponsibilityOwners("only@example.jp","2026-07-13",["only@example.jp"]);assert.equal(value.primary,null);assert.equal(value.backup,null);});
test("weekly recipient summary",()=>{const value=summarizeProductionEvidenceWeeklyReportRecipients([{status:"read",deliveredAt:weeklyDeliveredAt},{status:"unread",deliveredAt:weeklyDeliveredAt,escalationLevel:3,assignedToEmail:"owner@example.jp",backupToEmail:"backup@example.jp",approvalStatus:"pending",reassignmentCount:1,approvalFlowStatus:"expired",responsibilityStatus:"at_risk"},{status:"unresolved",deliveredAt:weeklyDeliveredAt,responsibilityStatus:"overdue"}]);assert.deepEqual(value,{total:3,read:1,proxyRead:0,unread:1,unresolved:1,escalated:1,assigned:1,backedUp:1,pendingApproval:1,approved:0,reassigned:1,approvalExpired:1,atRisk:2,overdue:1,readRate:33});});
test("proxy read counts as read",()=>{const value=summarizeProductionEvidenceWeeklyReportRecipients([{status:"proxy_read",deliveredAt:weeklyDeliveredAt,escalationLevel:3,assignedToEmail:"owner@example.jp",backupToEmail:"backup@example.jp",approvalStatus:"approved",reassignmentCount:1,approvalFlowStatus:"expired"},{status:"read",deliveredAt:weeklyDeliveredAt}]);assert.deepEqual(value,{total:2,read:2,proxyRead:1,unread:0,unresolved:0,escalated:0,assigned:0,backedUp:0,pendingApproval:0,approved:0,reassigned:0,approvalExpired:1,atRisk:0,overdue:0,readRate:100});});
test("empty recipient summary is complete",()=>assert.deepEqual(summarizeProductionEvidenceWeeklyReportRecipients([]),{total:0,read:0,proxyRead:0,unread:0,unresolved:0,escalated:0,assigned:0,backedUp:0,pendingApproval:0,approved:0,reassigned:0,approvalExpired:0,atRisk:0,overdue:0,readRate:100}));

const responsibilityAnalytics=summarizeProductionEvidenceWeeklyResponsibilityAnalytics([
  {weekKey:"2026-07-06",status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"a@example.jp",backupToEmail:"c@example.jp",assignedAt:"2026-07-06T10:00:00.000Z",approvalStatus:"approved",approvalDeadlineAt:"2026-07-06T11:00:00.000Z",approvedAt:"2026-07-06T10:30:00.000Z",reassignmentCount:0},
  {weekKey:"2026-07-06",status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"b@example.jp",backupToEmail:"c@example.jp",previousAssignedToEmails:["a@example.jp"],assignedAt:"2026-07-06T10:00:00.000Z",lastReassignedAt:"2026-07-06T11:00:00.000Z",approvalStatus:"approved",approvalDeadlineAt:"2026-07-06T11:00:00.000Z",approvedAt:"2026-07-06T12:00:00.000Z",reassignmentCount:1},
  {weekKey:"2026-07-13",status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"a@example.jp",backupToEmail:"b@example.jp",assignedAt:"2026-07-13T10:00:00.000Z",approvalStatus:"pending",approvalDeadlineAt:"2026-07-13T11:00:00.000Z",reassignmentCount:0,approvalFlowStatus:"expired"},
  {weekKey:"2026-07-13",status:"unread",deliveredAt:weeklyDeliveredAt,assignedToEmail:"c@example.jp",previousAssignedToEmails:["b@example.jp"],assignedAt:"2026-07-13T10:00:00.000Z",lastReassignedAt:"2026-07-13T12:00:00.000Z",approvalStatus:"approved",approvalDeadlineAt:"2026-07-13T12:30:00.000Z",approvedAt:"2026-07-13T12:15:00.000Z",reassignmentCount:2,assignmentEscalationKey:"approval_exhausted_2",approvalFlowStatus:"escalated"},
]);
test("responsibility analytics sorts weeks",()=>assert.deepEqual(responsibilityAnalytics.weeks.map(value=>value.weekKey),["2026-07-06","2026-07-13"]));
test("responsibility analytics approval totals",()=>{assert.equal(responsibilityAnalytics.assignedTotal,4);assert.equal(responsibilityAnalytics.approvedTotal,3);assert.equal(responsibilityAnalytics.pendingTotal,1);});
test("responsibility analytics approval rate",()=>assert.equal(responsibilityAnalytics.approvalRate,75));
test("responsibility analytics on time rate",()=>{assert.equal(responsibilityAnalytics.onTimeApprovedTotal,2);assert.equal(responsibilityAnalytics.onTimeApprovalRate,67);});
test("responsibility analytics approval latency",()=>{assert.equal(responsibilityAnalytics.averageApprovalMinutes,35);assert.equal(responsibilityAnalytics.p95ApprovalMinutes,60);});
test("responsibility analytics reassignment totals",()=>{assert.equal(responsibilityAnalytics.reassignmentTotal,2);assert.equal(responsibilityAnalytics.reassignmentSuccessTotal,1);assert.equal(responsibilityAnalytics.reassignmentSuccessRate,50);});
test("responsibility analytics escalation",()=>{assert.equal(responsibilityAnalytics.escalatedTotal,1);assert.match(responsibilityAnalytics.headline,/緊急移管/u);});
test("responsibility analytics attributes previous owners",()=>{const owner=responsibilityAnalytics.owners.find(value=>value.email==="a@example.jp");assert.equal(owner?.primary,3);});
test("responsibility analytics counts backup load",()=>{assert.equal(responsibilityAnalytics.owners.find(value=>value.email==="c@example.jp")?.backup,2);assert.equal(responsibilityAnalytics.owners.find(value=>value.email==="b@example.jp")?.backup,1);});
test("responsibility analytics owner approval latency",()=>assert.equal(responsibilityAnalytics.owners.find(value=>value.email==="b@example.jp")?.averageApprovalMinutes,60));
test("responsibility analytics load spread",()=>assert.equal(responsibilityAnalytics.loadSpread,2));
test("responsibility analytics weekly rates",()=>{assert.equal(responsibilityAnalytics.weeks[0]?.approvalRate,100);assert.equal(responsibilityAnalytics.weeks[1]?.approvalRate,50);});
test("responsibility analytics recommends low approval",()=>assert.ok(responsibilityAnalytics.recommendations.some(value=>value.includes("承認率"))));
test("responsibility analytics keeps latest eight",()=>{const items=Array.from({length:10},(_,index)=>({weekKey:`2026-${String(index+1).padStart(2,"0")}-01`,status:"unread" as const,deliveredAt:null,assignedToEmail:"owner@example.jp"}));assert.equal(summarizeProductionEvidenceWeeklyResponsibilityAnalytics(items).weeks.length,8);});
test("empty responsibility analytics is healthy",()=>{const value=summarizeProductionEvidenceWeeklyResponsibilityAnalytics([]);assert.equal(value.approvalRate,100);assert.equal(value.reassignmentSuccessRate,100);assert.equal(value.loadSpread,0);assert.equal(value.owners.length,0);});

const responsibilityAlertSummary=evaluateProductionEvidenceResponsibilityAnalyticsAlerts(responsibilityAnalytics);
test("responsibility alert policy is automatic",()=>{const value=productionEvidenceResponsibilityAlertThresholds();assert.equal(value.approvalRateMin,90);assert.equal(value.p95ApprovalMinutesMax,120);assert.equal(value.pendingRateMax,20);});
test("responsibility alerts become critical",()=>assert.equal(responsibilityAlertSummary.status,"critical"));
test("responsibility alerts detect low approval",()=>assert.ok(responsibilityAlertSummary.alerts.some(value=>value.key==="approval_rate_low")));
test("responsibility alerts detect late approval",()=>assert.ok(responsibilityAlertSummary.alerts.some(value=>value.key==="on_time_approval_low")));
test("responsibility alerts detect failed reassignment",()=>assert.ok(responsibilityAlertSummary.alerts.some(value=>value.key==="reassignment_success_low")));
test("responsibility alerts detect emergency handoff",()=>assert.equal(responsibilityAlertSummary.alerts.find(value=>value.key==="emergency_handoff_detected")?.severity,"critical"));
test("responsibility alerts detect pending ratio",()=>assert.ok(responsibilityAlertSummary.alerts.some(value=>value.key==="pending_rate_high")));
test("responsibility alerts fingerprint is deterministic",()=>assert.equal(evaluateProductionEvidenceResponsibilityAnalyticsAlerts(responsibilityAnalytics).fingerprint,responsibilityAlertSummary.fingerprint));
test("responsibility alert custom policy",()=>{const value=evaluateProductionEvidenceResponsibilityAnalyticsAlerts(responsibilityAnalytics,{approvalRateMin:0,onTimeApprovalRateMin:0,p95ApprovalMinutesMax:999,reassignmentSuccessRateMin:0,escalatedTotalMax:9,loadSpreadMax:9,pendingRateMax:100});assert.equal(value.status,"healthy");assert.equal(value.alerts.length,0);});
test("empty responsibility alerts are healthy",()=>assert.equal(evaluateProductionEvidenceResponsibilityAnalyticsAlerts(summarizeProductionEvidenceWeeklyResponsibilityAnalytics([])).status,"healthy"));
test("load imbalance can become critical",()=>{const value=evaluateProductionEvidenceResponsibilityAnalyticsAlerts({...responsibilityAnalytics,approvalRate:100,onTimeApprovalRate:100,reassignmentSuccessRate:100,escalatedTotal:0,pendingTotal:0,loadSpread:6});assert.equal(value.alerts.find(alert=>alert.key==="owner_load_imbalance")?.severity,"critical");});

const executiveDigest=buildProductionEvidenceResponsibilityExecutiveDigest(responsibilityAnalytics,responsibilityAlertSummary,Date.parse("2026-07-15T00:00:00.000Z"));
test("executive digest covers analytics period",()=>assert.deepEqual(executiveDigest.period,{startWeek:"2026-07-06",endWeek:"2026-07-13",weeks:2}));
test("executive digest inherits alert status",()=>assert.equal(executiveDigest.status,"critical"));
test("executive digest has KPI deltas",()=>assert.equal(executiveDigest.kpis.find(value=>value.key==="approval")?.delta,-50));
test("executive digest has decisions",()=>assert.ok(executiveDigest.decisions.length>0));
test("executive digest markdown is board ready",()=>{assert.match(executiveDigest.markdown,/週次責任運用エグゼクティブレポート/u);assert.match(executiveDigest.markdown,/## 経営判断/u);});
test("executive digest generated time is fixed",()=>assert.equal(executiveDigest.generatedAt,"2026-07-15T00:00:00.000Z"));

const responsibilityCsv=buildProductionEvidenceResponsibilityAnalyticsCsv(responsibilityAnalytics,responsibilityAlertSummary);
test("responsibility CSV includes BOM",()=>assert.ok(responsibilityCsv.startsWith("\uFEFF")));
test("responsibility CSV includes weekly rows",()=>assert.match(responsibilityCsv,/"week","2026-07-13"/u));
test("responsibility CSV includes owner rows",()=>assert.match(responsibilityCsv,/"owner","","a@example.jp"/u));
test("responsibility CSV includes alert rows",()=>assert.match(responsibilityCsv,/"alert","","","emergency_handoff_detected"/u));
test("responsibility CSV prevents formula injection",()=>{const value=buildProductionEvidenceResponsibilityAnalyticsCsv({...responsibilityAnalytics,owners:[{...responsibilityAnalytics.owners[0]!,email:"=cmd|' /C calc'!A0"}]},responsibilityAlertSummary);assert.doesNotMatch(value,/,"=cmd/u);assert.match(value,/"'=cmd/u);});

const readTrend=summarizeProductionEvidenceWeeklyReadTrend([
  {weekKey:"2026-06-29",deliveredAt:"2026-06-29T00:00:00.000Z",total:4,read:2,proxyRead:0,unread:1,unresolved:1,escalated:1,readRate:50},
  {weekKey:"2026-07-06",deliveredAt:"2026-07-06T00:00:00.000Z",total:4,read:3,proxyRead:1,unread:1,unresolved:0,escalated:0,readRate:75},
  {weekKey:"2026-07-13",deliveredAt:"2026-07-13T00:00:00.000Z",total:4,read:4,proxyRead:1,unread:0,unresolved:0,escalated:0,readRate:100},
]);
test("read trend sorts weeks",()=>assert.deepEqual(readTrend.points.map(value=>value.weekKey),["2026-06-29","2026-07-06","2026-07-13"]));
test("read trend current and previous",()=>{assert.equal(readTrend.currentReadRate,100);assert.equal(readTrend.previousReadRate,75);});
test("read trend improved delta",()=>{assert.equal(readTrend.delta,25);assert.equal(readTrend.direction,"improved");assert.match(readTrend.headline,/25pt改善/u);});
test("read trend average",()=>assert.equal(readTrend.averageReadRate,75));
test("read trend proxy and unresolved totals",()=>{assert.equal(readTrend.proxyReadTotal,2);assert.equal(readTrend.unresolvedTotal,1);});
test("read trend keeps latest eight",()=>{const points=Array.from({length:10},(_,index)=>({weekKey:`2026-${String(index+1).padStart(2,"0")}-01`,deliveredAt:null,total:1,read:1,proxyRead:0,unread:0,unresolved:0,escalated:0,readRate:100}));assert.equal(summarizeProductionEvidenceWeeklyReadTrend(points).points.length,8);});
test("read trend decline",()=>assert.equal(summarizeProductionEvidenceWeeklyReadTrend([{...readTrend.points[2]!,weekKey:"2026-07-20",readRate:50},readTrend.points[2]!]).direction,"declined"));
test("empty read trend is stable complete",()=>{const value=summarizeProductionEvidenceWeeklyReadTrend([]);assert.equal(value.currentReadRate,100);assert.equal(value.direction,"stable");});

const executiveDeliveredAt="2026-07-14T00:00:00.000Z";const executiveRecipient={status:"unread" as const,deliveredAt:executiveDeliveredAt,reminderCount:0,lastReminderAt:null};
test("executive read reminder waits 24 hours",()=>assert.equal(evaluateProductionEvidenceExecutiveReportReadReminder(executiveRecipient,Date.parse(executiveDeliveredAt)+23*3_600_000).status,"waiting"));
test("executive unread level 1 at 24 hours",()=>{const value=evaluateProductionEvidenceExecutiveReportReadReminder(executiveRecipient,Date.parse(executiveDeliveredAt)+24*3_600_000);assert.equal(value.escalationLevel,1);assert.equal(value.shouldNotify,true);});
test("executive unread level 2 at 48 hours",()=>assert.equal(evaluateProductionEvidenceExecutiveReportReadReminder({...executiveRecipient,reminderCount:1},Date.parse(executiveDeliveredAt)+48*3_600_000).escalationLevel,2));
test("executive unread level 3 at 72 hours",()=>{const value=evaluateProductionEvidenceExecutiveReportReadReminder({...executiveRecipient,reminderCount:2},Date.parse(executiveDeliveredAt)+72*3_600_000);assert.equal(value.escalationLevel,3);assert.equal(value.urgent,true);});
test("executive read stops reminders",()=>assert.equal(evaluateProductionEvidenceExecutiveReportReadReminder({...executiveRecipient,status:"read"},Date.parse(executiveDeliveredAt)+96*3_600_000).shouldNotify,false));
test("executive proxy read stops reminders",()=>assert.equal(evaluateProductionEvidenceExecutiveReportReadReminder({...executiveRecipient,status:"proxy_read"},Date.parse(executiveDeliveredAt)+96*3_600_000).status,"none"));
test("executive unresolved does not notify",()=>assert.equal(evaluateProductionEvidenceExecutiveReportReadReminder({...executiveRecipient,status:"unresolved"},Date.parse(executiveDeliveredAt)+96*3_600_000).shouldNotify,false));

const executiveHistory=summarizeProductionEvidenceExecutiveReportHistory([
  {weekKey:"2026-07-07",deliveredAt:"2026-07-08T00:00:00.000Z",total:3,read:3,proxyRead:1,unread:0,unresolved:0,escalated:0,readRate:100,alertStatus:"watch",riskScore:12},
  {weekKey:"2026-07-14",deliveredAt:"2026-07-15T00:00:00.000Z",total:3,read:1,proxyRead:0,unread:1,unresolved:1,escalated:1,readRate:33,alertStatus:"critical",riskScore:61},
]);
test("executive history newest first",()=>assert.deepEqual(executiveHistory.points.map(value=>value.weekKey),["2026-07-14","2026-07-07"]));
test("executive history current read rate",()=>assert.equal(executiveHistory.currentReadRate,33));
test("executive history average read rate",()=>assert.equal(executiveHistory.averageReadRate,67));
test("executive history totals",()=>{assert.equal(executiveHistory.readTotal,4);assert.equal(executiveHistory.proxyReadTotal,1);assert.equal(executiveHistory.unreadTotal,1);assert.equal(executiveHistory.unresolvedTotal,1);assert.equal(executiveHistory.escalatedTotal,1);});
test("executive history headline flags unread",()=>assert.match(executiveHistory.headline,/未確認 2名/u));
test("executive history keeps latest eight",()=>{const points=Array.from({length:10},(_,index)=>({weekKey:`2026-${String(index+1).padStart(2,"0")}-01`,deliveredAt:null,total:1,read:1,proxyRead:0,unread:0,unresolved:0,escalated:0,readRate:100,alertStatus:"healthy",riskScore:0}));assert.equal(summarizeProductionEvidenceExecutiveReportHistory(points).points.length,8);});
test("empty executive history is ready",()=>{const value=summarizeProductionEvidenceExecutiveReportHistory([]);assert.equal(value.currentReadRate,100);assert.match(value.headline,/配信待ち/u);});

const decisionNow=Date.parse("2026-07-15T00:00:00.000Z");
const decisionTask=(overrides:Partial<ProductionEvidenceExecutiveDecisionTask>={}):ProductionEvidenceExecutiveDecisionTask=>({taskId:"decision-1",weekKey:"2026-07-13",title:"未承認案件の責任者を固定",priority:"critical",status:"open",ownerEmail:"admin@example.jp",dueAt:"2026-07-15T02:00:00.000Z",createdAt:"2026-07-14T00:00:00.000Z",startedAt:null,completedAt:null,completedByEmail:null,completionNote:null,lastReminderAt:null,reminderCount:0,maximumEscalationLevel:0,...overrides});
test("decision task due soon",()=>{const value=evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask(),decisionNow);assert.equal(value.status,"due_soon");assert.equal(value.remainingHours,2);assert.equal(value.shouldNotify,true);});
test("decision task waits before 24 hours",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask({dueAt:"2026-07-17T00:00:00.000Z"}),decisionNow).status,"none"));
test("decision task level one overdue",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask({dueAt:"2026-07-14T23:00:00.000Z"}),decisionNow).escalationLevel,1));
test("decision task level two overdue",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask({dueAt:"2026-07-14T00:00:00.000Z"}),decisionNow).escalationLevel,2));
test("decision task level three overdue",()=>{const value=evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask({dueAt:"2026-07-12T00:00:00.000Z"}),decisionNow);assert.equal(value.escalationLevel,3);assert.equal(value.urgent,true);});
test("decision task completed stops escalation",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask({status:"completed"}),decisionNow).status,"none"));
test("decision task daily reminder dedupe",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask({lastReminderAt:"2026-07-15T00:00:00.000Z"}),decisionNow+60_000).shouldNotify,false));
test("decision task missing deadline is critical",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionTaskDeadline(decisionTask({dueAt:null}),decisionNow).escalationLevel,3));
const decisionTasks=[decisionTask(),decisionTask({taskId:"decision-2",status:"in_progress",dueAt:"2026-07-14T00:00:00.000Z"}),decisionTask({taskId:"decision-3",status:"completed",priority:"normal",dueAt:"2026-07-15T00:00:00.000Z",completedAt:"2026-07-14T12:00:00.000Z",completedByEmail:"admin@example.jp",completionNote:"完了証跡を確認しました。"})];
const decisionSummary=summarizeProductionEvidenceExecutiveDecisionTasks(decisionTasks,decisionNow);
test("decision task summary totals",()=>{assert.equal(decisionSummary.total,3);assert.equal(decisionSummary.open,1);assert.equal(decisionSummary.inProgress,1);assert.equal(decisionSummary.completed,1);});
test("decision task summary completion rate",()=>assert.equal(decisionSummary.completionRate,33));
test("decision task summary overdue",()=>assert.equal(decisionSummary.overdue,1));
test("decision task summary on time",()=>assert.equal(decisionSummary.onTimeCompletionRate,100));
test("decision task summary completion hours",()=>assert.equal(decisionSummary.averageCompletionHours,12));
test("decision task summary headline",()=>assert.match(decisionSummary.headline,/期限超過 1件/u));
test("decision task CSV safe",()=>{const csv=buildProductionEvidenceExecutiveDecisionTasksCsv([decisionTask({title:"=IMPORTDATA(unsafe)"})],decisionNow);assert.match(csv,/deadline_status/u);assert.match(csv,/'=IMPORTDATA/u);});

const measuredOutcome={metricName:"承認時間",metricUnit:"分",metricDirection:"decrease" as const,baselineValue:120,targetValue:60,actualValue:45,investmentYen:50_000,benefitYen:200_000};
test("decision outcome calculates directional improvement",()=>{const value=evaluateProductionEvidenceExecutiveDecisionOutcome(measuredOutcome);assert.equal(value.improvementValue,75);assert.equal(value.improvementRate,62.5);});
test("decision outcome calculates target achievement",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome(measuredOutcome).targetAchievementRate,125));
test("decision outcome calculates net benefit",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome(measuredOutcome).netBenefitYen,150_000));
test("decision outcome calculates ROI",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome(measuredOutcome).roiPercent,300));
test("decision outcome excellent score",()=>{const value=evaluateProductionEvidenceExecutiveDecisionOutcome(measuredOutcome);assert.equal(value.status,"excellent");assert.ok(value.score>=85);});
test("decision outcome increase direction",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome({...measuredOutcome,metricDirection:"increase",baselineValue:100,targetValue:120,actualValue:130}).improvementValue,30));
test("decision outcome negative",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome({...measuredOutcome,actualValue:150}).status,"negative"));
test("decision outcome below target",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome({...measuredOutcome,actualValue:110,benefitYen:0}).status,"below_target"));
test("decision outcome zero investment avoids invalid ROI",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome({...measuredOutcome,investmentYen:0}).roiPercent,null));
test("decision outcome missing fields is unmeasured",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionOutcome({metricName:null,metricUnit:null,metricDirection:null,baselineValue:null,targetValue:null,actualValue:null,investmentYen:null,benefitYen:null}).status,"unmeasured"));
const measuredTask=decisionTask({taskId:"decision-4",status:"completed",completedAt:"2026-07-14T12:00:00.000Z",...measuredOutcome});
const outcomeSummary=summarizeProductionEvidenceExecutiveDecisionTasks([...decisionTasks,measuredTask],decisionNow);
test("decision summary counts measured outcomes",()=>{assert.equal(outcomeSummary.measured,1);assert.equal(outcomeSummary.unmeasuredCompleted,1);assert.equal(outcomeSummary.outcomeMeasurementRate,50);});
test("decision summary aggregates outcome score",()=>assert.ok(outcomeSummary.averageOutcomeScore>=85));
test("decision summary aggregates money",()=>{assert.equal(outcomeSummary.totalInvestmentYen,50_000);assert.equal(outcomeSummary.totalBenefitYen,200_000);assert.equal(outcomeSummary.netBenefitYen,150_000);});
test("decision summary portfolio ROI",()=>assert.equal(outcomeSummary.portfolioRoiPercent,300));
test("decision CSV contains outcome fields",()=>{const csv=buildProductionEvidenceExecutiveDecisionTasksCsv([measuredTask],decisionNow);assert.match(csv,/target_achievement_rate/u);assert.match(csv,/outcome_score/u);assert.match(csv,/300/u);});
test("decision recovery skips effective outcome",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionRecovery(measuredTask).status,"not_required"));
const negativeRecoveryTask=decisionTask({taskId:"decision-5",status:"completed",completedAt:"2026-07-14T12:00:00.000Z",...measuredOutcome,actualValue:150});
test("decision recovery detects negative execution",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionRecovery(negativeRecoveryTask).causeCode,"execution_gap"));
test("decision recovery makes negative critical",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionRecovery(negativeRecoveryTask).severity,"critical"));
test("decision recovery sets seven day correction",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionRecovery(negativeRecoveryTask).dueDays,7));
test("decision recovery builds follow up title",()=>assert.match(evaluateProductionEvidenceExecutiveDecisionRecovery(negativeRecoveryTask).followUpTitle,/再実行/u));
const unmeasuredRecovery=evaluateProductionEvidenceExecutiveDecisionRecovery(decisionTask({status:"completed"}));
test("decision recovery detects measurement gap",()=>assert.equal(unmeasuredRecovery.causeCode,"measurement_gap"));
test("decision recovery measurement is high priority",()=>assert.equal(unmeasuredRecovery.priority,"high"));
const economicRecoveryTask=decisionTask({taskId:"decision-6",status:"completed",completedAt:"2026-07-14T12:00:00.000Z",...measuredOutcome,actualValue:90,investmentYen:300_000,benefitYen:100_000});
test("decision recovery detects economics gap",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionRecovery(economicRecoveryTask).causeCode,"economics_gap"));
const belowTargetRecoveryTask=decisionTask({taskId:"decision-7",status:"completed",completedAt:"2026-07-14T12:00:00.000Z",...measuredOutcome,actualValue:100,investmentYen:10_000,benefitYen:20_000});
test("decision recovery detects process gap",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionRecovery(belowTargetRecoveryTask).causeCode,"process_gap"));
test("decision recovery recommendation is deterministic",()=>assert.deepEqual(evaluateProductionEvidenceExecutiveDecisionRecovery(belowTargetRecoveryTask),evaluateProductionEvidenceExecutiveDecisionRecovery(belowTargetRecoveryTask)));
const plannedRecoveryTask=decisionTask({status:"completed",recoveryPlan:{policyVersion:"recovery_v1",status:"planned",causeCode:"process_gap",selectedCauseCode:"process_gap",severity:"watch",priority:"high",dueDays:14,headline:"改善計画を固定",diagnosis:"工程差分を確認",recommendedAction:"確認点を追加",followUpTitle:"【目標未達・改善実行】確認",causeDetail:"承認工程の確認点が不足していた。",improvementPlan:"中間確認を追加して再実行する。",createdAt:"2026-07-15T00:00:00.000Z",createdByEmail:"admin@example.jp",followUpTaskId:"a".repeat(40)}});
test("decision recovery preserves planned state",()=>assert.equal(evaluateProductionEvidenceExecutiveDecisionRecovery(plannedRecoveryTask).status,"planned"));
test("decision recovery preserves follow up id",()=>assert.equal(plannedRecoveryTask.recoveryPlan?.followUpTaskId,"a".repeat(40)));
test("decision CSV contains recovery fields",()=>{const csv=buildProductionEvidenceExecutiveDecisionTasksCsv([negativeRecoveryTask],decisionNow);assert.match(csv,/recovery_cause/u);assert.match(csv,/execution_gap/u);assert.match(csv,/recovery_task_id/u);});

console.log(`production evidence difference monitor tests passed (${cases} cases)`);
