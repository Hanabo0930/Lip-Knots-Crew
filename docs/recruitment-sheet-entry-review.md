# シートの募集ボタンを既存管理画面へ接続する変更案

ソースと隔離検証の候補。GAS実反映・プロパティ設定・Hosting反映・実メール送信は未実施。

## 変更内容

既存GASの`lkRmV1Open`、`lkRmV1Bootstrap`、`lkRmV1Generate`、`lkRmV1AddMenu_`という入口名を維持し、`LK_RecruitMailV1.gs`と`RecruitMailDialog.html`の2ファイルを候補へ置き換える。既存onOpenの呼出しはそのまま利用し、新しいtriggerは追加しない。

シートの「案件メール作成 → 作成画面を開く」は、固定されたSTAGING管理画面の`/?entry=recruitment-mail`を開く案内になる。実際の文面生成は既存`RecruitmentDraftPanel`→`generateJobExport(purpose=recruitment-draft)`→同じ承認receipt・現在Source/台帳・地域・版照合→同じformatterを使う。旧A/C基準の抽出や過去の93件を利用しない。

管理画面では、認証の準備が済んだ後だけ「案件 → 案件一覧」の募集メール作成を開く。地域・対象は選択し直す。URLは案件IDや氏名を持たず、文面作成・送信・公開・月別転記を自動実行しない。コピーも既存の再照合を通す。募集文に掲載する選択と、ネームアップ後に月別へ移す選択は別のまま。

## 実反映に必要な正確な範囲

- 既存GAS2ファイルの最新前像を再読し、固定版を退避してから置換・再読する。他のスクリプトを変更しない。
- 同じGASプロジェクトのScript Propertiesに`LK_RM_SOURCE_BOOK_ID`を1件設定する。値は既存の実業務原本IDを私的に照合して使い、GitHubやURLへ含めない。未設定・別bookでは開かない。
- 既存の公開設定読取ログで確認されたAdmin Hosting siteは`lip-knots-crew-staging-admin`。入口はその固定HTTPS originのみ。実際のアプリ反映/URLとAuthの確認は別の受入工程。
- シートの業務行は読まず、値・数式・金額・メモ・チェック・タブ・台帳を更新しない。UrlFetch・Gmail・Drive操作、新しいOAuth権限やtriggerは追加しない。
- 古いダイアログの`lkRmV1Generate`呼出しは、開き直す案内で停止する。旧抽出へfallbackしない。

これは以前の55→65列見出し対応と異なる画面/動作の変更であり、一般の継続指示をGASへの追加反映許可に読み替えない。上記の具体的な2ファイル置換と1プロパティ設定を反映前に提示する。Functionsや本番、IAM、Rules、索引、停止解除、実送信、実原本書戻しを含めない。

## 検証と残件

`test-recruitment-sheet-entry.mjs`が実GAS/HTML/入口判定・実Appの認証待ち効果を合成境界で検証する。既存の募集文画面・再照合・認証変更試験と、実Appのブラウザー入口試験は正式CIへ接続する。

この入口候補だけで実運用完了とはしない。対応する管理アプリ/APIの反映、実ログイン、募集可能案件の確認、実コピー、許可された実送信/応募/転記/カレンダー表示は別途受入が必要。
