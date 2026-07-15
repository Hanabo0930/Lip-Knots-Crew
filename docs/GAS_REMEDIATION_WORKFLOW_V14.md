# GAS修正管理 v1.4

各指摘は次の状態で管理できます。

- open
- in_progress
- fixed
- accepted_risk
- false_positive

再監査後は、解消、新規検出、未変更、スコア差、blocker差を比較します。

`accepted_risk` は理由と承認者を必須にする運用を推奨します。本番移行ゲートでは重大・高リスクを原則0件にします。
