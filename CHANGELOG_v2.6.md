# v2.6 変更内容

- staff/admin本体HTML・manifest・Service Workerを実URLで検査する6項目スモークを追加
- HTTPS固定、production redirect拒否、timeout、retry、1MiB応答上限を追加
- preflight・readiness・checkpoint・deployment result・remote smokeをGo/No-Goへ統合
- 判定JSON・Markdown・SHA-256をrelease checkpointへ保存
- smoke証跡の改ざん・欠落・release/project/deployment不一致をcheckpoint検証へ統合
- staging自動生成を6ファイルへ拡張し、実URL設定をGit・ZIP・checkpointから除外
- checkpoint関連15ケース、smoke・Go/No-Go 14ケースを自動検証
