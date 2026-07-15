# Lip Knots Crew Git運用手順

## 正本

- リモート: https://github.com/Hanabo0930/Lip-Knots-Crew
- 基準ブランチ: main
- Node.js: 22
- CI: mainへのpushとPull Requestでnpm run verify

## 開発開始

    git switch main
    git pull --ff-only origin main
    git switch -c feature/作業名
    npm ci

## 完了

    npm run verify
    git status
    git add -A
    git commit -m "feat: 変更内容"
    git push -u origin feature/作業名

GitHubでPull Requestを作成し、CI通過後にmainへ統合します。

## mainを揃える

    git switch main
    git pull --ff-only origin main
    git status

git statusが「working tree clean」、git rev-list --left-right --count main...origin/mainが「0 0」なら一致です。

## コミット禁止

- 環境変数の実値
- Firebase／Googleの認証鍵
- configディレクトリの本番実値
- node_modules、テスト生成物
- release-evidence、rollback-sources
- 配布ZIP

設定例は.exampleまたはconfig-samplesだけを管理します。

## 禁止操作

履歴を失うgit reset --hard、共有済みmainへのforce push、秘密値を含むコミットは禁止です。
