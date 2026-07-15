# staging smoke・Go/No-Go v2.6

## 1. 設定preview

```bash
npm run smoke:staging:preview
```

実URL・Project ID・秘密値を表示せず、remote検査6項目と判定条件を確認します。

## 2. 実行条件

次を先に完了します。

- `npm run setup:staging`
- stagingへの明示デプロイ
- `npm run checkpoint:staging`でcheckpoint作成
- `npm run evidence:staging:record`で`status=succeeded`とrelease refを記録

`config/staging-smoke.json`はsetup時に権限600で生成され、Git・checkpoint・ZIPへ含めません。

## 3. Go/No-Go判定

```bash
npm run smoke:staging -- \
  --checkpoint release-evidence/staging/<release-id>
```

次をすべて満たす場合だけ`GO`です。

- staging preflight合格
- デプロイreadiness合格
- checkpointの全SHA-256検証合格
- deployment resultが`succeeded`
- staff/admin本体HTMLが200・必要marker一致
- staff/admin manifestが200・アプリ名一致
- staff/admin Service Workerが200・JavaScript・必要marker一致

HTTPS以外、production hostへのredirect、1MiB超の応答は拒否します。各remote検査はtimeout付きで最大2回retryします。

## 4. 証跡

checkpoint内へ権限600で次を保存します。

- `smoke-report.json`
- `GO_NO_GO.md`
- `smoke-evidence.sha256`

既存証跡は暗黙上書きしません。意図した再試行だけ`--replace`を付けます。`NO_GO`でも証跡を保存し、終了コード1で停止します。デプロイ・rollbackは自動実行しません。
