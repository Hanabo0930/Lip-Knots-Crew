param([ValidateSet('Prepare','All')][string]$Task='All')
$ErrorActionPreference='Stop'
$repoRoot=Split-Path $PSScriptRoot -Parent
$dependencyArchive=Join-Path $repoRoot 'release-evidence/environment/node22-win64-dependencies.tar.gz'
$lockHash=(Get-FileHash -LiteralPath (Join-Path $repoRoot 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$archiveLockFile=Join-Path $repoRoot 'release-evidence/environment/node22-win64-dependencies.lock.sha256'
if(-not (Test-Path -LiteralPath $archiveLockFile) -or (Get-Content -LiteralPath $archiveLockFile).Trim() -ne $lockHash){throw '依存アーカイブとlockfileが一致しません。固定依存を再準備してください。'}
$cacheRoot=Join-Path $env:LOCALAPPDATA "LipKnotsCrew/cache/$lockHash"
$sourceRoot=Join-Path $cacheRoot ('source-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))
$evidenceRoot=Join-Path $repoRoot 'release-evidence/batch49'
New-Item -ItemType Directory -Force $cacheRoot,$sourceRoot,$evidenceRoot | Out-Null
$nodeMajor=& node -p 'process.versions.node.split(".")[0]'
if($nodeMajor -ne '22'){throw 'Node.js 22 が必要です。'}
# H側の保存済みソースへ作業中の差分を重ねる。キャッシュからHへソースを戻さない。
& git -C $repoRoot archive --format=zip -o (Join-Path $sourceRoot 'source.zip') HEAD
if($LASTEXITCODE -ne 0){throw 'ソースの書き出しに失敗しました。'}
Expand-Archive -LiteralPath (Join-Path $sourceRoot 'source.zip') -DestinationPath $sourceRoot
if($LASTEXITCODE -ne 0){throw 'ソースの展開に失敗しました。'}
$changedPaths=@(& git -C $repoRoot -c core.quotepath=false diff HEAD --name-only --diff-filter=ACMRTUXB) + @(& git -C $repoRoot -c core.quotepath=false ls-files --others --exclude-standard)
foreach($relativePath in ($changedPaths | Sort-Object -Unique)){
  if(-not $relativePath){continue}
  $sourceFile=Join-Path $repoRoot $relativePath
  $cacheFile=Join-Path $sourceRoot $relativePath
  New-Item -ItemType Directory -Force (Split-Path $cacheFile -Parent) | Out-Null
  Copy-Item -LiteralPath $sourceFile -Destination $cacheFile
}
$deletedPaths=@(& git -C $repoRoot -c core.quotepath=false diff HEAD --name-only --diff-filter=D)
if($deletedPaths.Count){throw '削除を含む差分はこの検証ランナーでは扱いません。新しいコミットから実行してください。'}
$dependencyRoot=Join-Path $cacheRoot 'node_modules'
if(-not (Test-Path -LiteralPath (Join-Path $cacheRoot 'dependencies-ready'))){
  if(-not (Test-Path -LiteralPath $dependencyArchive)){throw 'Hドライブの依存アーカイブがありません。npm ciで固定lockfileから準備してください。'}
  & tar -xf $dependencyArchive -C $cacheRoot
  if($LASTEXITCODE -ne 0){throw '依存パッケージの展開に失敗しました。'}
  Set-Content -LiteralPath (Join-Path $cacheRoot 'dependencies-ready') -Value $lockHash
}
New-Item -ItemType Junction -Path (Join-Path $sourceRoot 'node_modules') -Target $dependencyRoot | Out-Null
Set-Content -LiteralPath (Join-Path $evidenceRoot 'cache-path.txt') -Value $sourceRoot
Write-Output "検証用キャッシュ: $sourceRoot"
if($Task -eq 'Prepare'){exit 0}
Push-Location $sourceRoot
try{
  & npm.cmd run build:staff
  if($LASTEXITCODE -ne 0){throw 'Staffビルド失敗'}
  & npm.cmd run build:admin
  if($LASTEXITCODE -ne 0){throw 'Adminビルド失敗'}
  & node scripts/test-admin-workspace.mjs
  if($LASTEXITCODE -ne 0){throw 'Admin業務検査失敗'}
  $env:LKC_VISUAL_EVIDENCE_DIR=$evidenceRoot
  & node scripts/test-staff-submission-flow.mjs --browser
  if($LASTEXITCODE -ne 0){throw 'Staffブラウザ検査失敗'}
  & node scripts/test-admin-workspace.mjs --browser
  if($LASTEXITCODE -ne 0){throw 'Adminブラウザ検査失敗'}
  Copy-Item -LiteralPath 'apps/staff/dist' -Destination (Join-Path $evidenceRoot ('staff-build-'+(Split-Path $sourceRoot -Leaf))) -Recurse -Force
  Copy-Item -LiteralPath 'apps/admin/dist' -Destination (Join-Path $evidenceRoot ('admin-build-'+(Split-Path $sourceRoot -Leaf))) -Recurse -Force
}finally{Pop-Location}
