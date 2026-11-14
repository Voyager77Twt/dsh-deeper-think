# dsh-deeper-think uninstaller (v0.1.1)
# 从 profile 的补丁层移除注册行、删除 vendor 副本、清理历史残留。
$ErrorActionPreference = 'Stop'

$web  = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'
$patch = Join-Path $web 'cordis.patch.yml'
$bak   = $patch + '.bak-dsh-deeper-think'
$dest  = Join-Path $web 'vendor\dsh-deeper-think'

if (Test-Path $patch) {
    if (Test-Path $bak) {
        Copy-Item $bak $patch -Force
        Remove-Item $bak -Force
        Write-Host '[ok] 补丁层已从备份还原'
    } else {
        $txt = Get-Content $patch -Raw -Encoding UTF8
        if ($null -ne $txt) {
            $marker = '# dsh-deeper-think'
            $idx = $txt.IndexOf($marker)
            if ($idx -ge 0) {
                $txt = $txt.Substring(0, $idx).TrimEnd() + "`r`n"
                Set-Content -Path $patch -Value $txt -Encoding UTF8 -NoNewline
                Write-Host '[ok] 补丁层注册块已移除'
            } else {
                Write-Host '[ok] 补丁层中没有该插件的注册块'
            }
        }
    }
}

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force; Write-Host '[ok] vendor 副本已删除' }
else { Write-Host '[ok] vendor 副本本就不存在' }

$nm = Join-Path $web 'node_modules\dsh-deeper-think'
if (Test-Path $nm) { Remove-Item $nm -Recurse -Force; Write-Host '[ok] node_modules 旧副本已删除' }

Write-Host ''
Write-Host '[完成] 重启 DSH Desktop 后插件卸载生效。'
