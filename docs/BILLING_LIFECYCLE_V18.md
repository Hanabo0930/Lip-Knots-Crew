# 契約・請求ライフサイクル v1.8

trialing → active → past_due → unpaid / cancelled

past_dueは短い猶予期間へ移し、データは削除しません。
unpaidは原則読取専用または停止。
ダウングレードは契約期間末、アップグレードは即時反映を基本とします。
