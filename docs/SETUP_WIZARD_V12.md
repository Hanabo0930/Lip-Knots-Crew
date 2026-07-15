# 導入ウィザード v1.2

## 目的

シフト表とスタッフ管理表を読取専用で検査し、会社ごとの設定下書きを自動生成します。

## 入力

- シフト表のGoogleスプレッドシートURLまたはID
- スタッフ管理表のURLまたはID
- 確認する月タブ
- 現役スタッフタブ
- 除外タブ

## 自動検出

- スプレッドシートID
- 月別タブ
- 見出し行
- 実施日・スタッフ・クライアント・店舗・メーカー・メニュー等の列
- スタッフ氏名・メール・電話・最寄り駅等の列
- 数式列
- 入力規則列
- 案件ID列の候補

## 出力

- shiftImportConfig
- staffImportConfig
- shiftMapping
- rowCreation
- monthCreation
- companyFeatureSettings

## 安全性

生成される設定はすべてOFFです。

- 自動同期OFF
- スプシ書込OFF
- 新規行追加OFF
- 新月タブ作成OFF
- 管理画面からの本番公開OFF

Firestoreへ保存する場合も `setupWizardDrafts` へ下書きとして保存し、実設定へ自動反映しません。
