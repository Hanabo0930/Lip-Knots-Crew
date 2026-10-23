# スタッフ用A2アイコンのローカル組込・受入手順（2026-10-01）

代表承認済みのA2シャンパンゴールド案を、スタッフPWAのホーム画面・ブラウザー用アイコンとして組み込んだ。蝶・リボン・文字、白い中心、元の金線は承認画像と同じ。管理者アプリ、通知アイコン、画面内の元ロゴは変更していない。

## 資産と参照

| public資産 | サイズ | 用途 |
| --- | --- | --- |
| icon-a2-v1-192.png | 192×192 | manifest / any |
| icon-a2-v1-512.png | 512×512 | manifest / any と maskable |
| apple-touch-icon-a2-v1.png | 180×180 | index.html / apple-touch-icon |
| favicon-a2-v1-32.png | 32×32 | index.html / favicon |

全PNGは正方形・不透明。512pxの復号後ピクセルは承認画像と一致し、他のサイズは同じ画像から縮小した。ロゴの最大中心半径184pxは、512pxアイコンのmaskable安全円（半径204.8px）内に収まる。外側の装飾はマスクで切れることがあるが、蝶・リボン・文字を安全円に保つ。32pxなど小さい表示では文字判読に限界がある。

元の public/logo.png は保全した。manifestのname、short_name、start_url、display、theme_color、background_colorを変えていない。

## キャッシュ更新

新しい版付きURLへ切り替え、旧logo.pngへのホーム画面アイコン参照を置き換えた。既存のincludeAssetsとPNG対象のprecache globにより、新しい資産に内容ハッシュのrevisionが付く。新しいService Workerがインストールされた際、既存の更新通知から「画面を更新」を選ぶ流れを維持する。無条件のページ再読込、更新通知の迂回、サイトデータ消去は追加していない。

今後画像が変わる場合はv2等の新しい資産名へ進め、manifestとHTMLの参照を一緒に更新する。PWAのアプリ更新と、OSが保存しているホーム画面アイコンの更新は別の受入項目とする。既存のホーム画面アイコンが直ちに更新されることは保証しない。

## ローカル確認

release-evidence/staff-icon-integration-20261001 に、環境ファイルと継承VITE設定を使わないスタッフ専用icon-reviewビルド、資産ハッシュ、ブラウザー結果、表示画像を保存した。既存apps/staff/distは出力先にしていない。

確認はloopbackのみ。生成manifest、HTML参照、各画像の寸法、実際にビルドされたService Workerの内容revisionを確認した。旧版を模したworkerから新workerへの更新待ち、SKIP_WAITINGによる明示切替、オフラインで新アイコン4件と元logo.pngが期待する内容で返ることを確認した。業務画面、認証、クラウドAPI、募集や通知の操作は行っていない。これは実端末の追加・更新受入ではない。

## preview受入を準備する次の手順

1. 今回のスタッフアイコン4件とvite.config.ts、index.html、本書だけをレビュー対象に切り出す。既存のAdmin/Functions未コミット差分は混ぜず、保全する。
2. push/PR/mergeの個別許可後、対象HEADの必須CIを通す。公開previewは既存のstaging-hosting-preview.ymlと正規mainの成功CIを使う。現workflowはstaff/admin双方のpreviewを扱うため、staffだけの公開を希望する場合は、勝手にworkflowを変えず親で許可範囲を確定する。今回はworkflow・クラウドを実行していない。
3. TLS対応のstaff preview URLで、iPhone Safariからホーム画面へ追加、Androidの対応ブラウザーからインストールし、A2・名前・丸/角丸の欠け・起動先・オフラインのアイコン取得を確認する。業務データの投入やメール送信はしない。
4. 同じpreview originの旧版を追加済みの端末があれば、更新通知と更新後表示を確認する。新規追加と既存インストールのアイコン更新を別に記録し、未反映は未受入とする。実業務で使用中のアプリ削除・サイトデータ消去をこのアイコン受入に含めない。
5. 実iPhone/Androidでの結果と正確なpreview版を親へ返す。Live昇格・正式配備は別途許可後、既存保護経路で行う。

実iPhone/Androidの受入、公開preview、push/PR/merge/deployは未実施。新規依存・有料生成・追加課金・実送信・原本書込はない。
