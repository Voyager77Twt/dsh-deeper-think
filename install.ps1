# dsh-deeper-think installer (v0.1.1)
# 安装方式：vendor 目录 + profile 的用户补丁层（profiles/web/cordis.patch.yml）。
# 这是 DSH 的常规插件通道：profile 根下的 cordis.patch.yml 是用户可写的覆盖层，
# 启动时由 loader 组合；插件文件放在 profile 的 vendor/ 下，用相对路径引用。
# 已验证：客户端（闪电开关）与宿主（pre-step / pre-execute / post-execute / turn-end）都会加载。
# 不使用 package.json 的 dependencies/bundles：那条路要求 pnpm 真实链接，启动时会被 heal 掉。
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$web  = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'
if (-not (Test-Path (Join-Path $web 'package.json'))) {
    throw "找不到 DSH 的 web profile：$web（请确认装的是 DSH Desktop）"
}

$vendor = Join-Path $web 'vendor'
$dest   = Join-Path $vendor 'dsh-deeper-think'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $here 'lib') (Join-Path $dest 'lib') -Recurse -Force
Copy-Item (Join-Path $here 'package.json') $dest -Force
Copy-Item (Join-Path $here 'cordis.patch.yml') $dest -Force
if (-not (Test-Path (Join-Path $dest 'lib\index.js'))) { throw '安装失败：lib/index.js 缺失' }

# 新版 DSH 用严格 JSON 解析 package.json；PowerShell 的 UTF8 会带 BOM，必须剥掉
$pkgPath = Join-Path $dest 'package.json'
$pkgTxt = [IO.File]::ReadAllText($pkgPath).TrimStart([char]0xFEFF)
[IO.File]::WriteAllText($pkgPath, $pkgTxt, (New-Object System.Text.UTF8Encoding($false)))
$bomBytes = [IO.File]::ReadAllBytes($pkgPath)
if ($bomBytes.Length -ge 3 -and $bomBytes[0] -eq 0xEF -and $bomBytes[1] -eq 0xBB -and $bomBytes[2] -eq 0xBF) {
    throw 'package.json 仍带 BOM：新版 DSH 会禁用插件'
}
Write-Host '[ok] 插件文件已复制到 vendor/dsh-deeper-think（package.json 无 BOM）'

$relRow = "      name: './vendor/dsh-deeper-think/lib/index.js'"
$patch = Join-Path $web 'cordis.patch.yml'
$bak   = $patch + '.bak-dsh-deeper-think'
if (-not (Test-Path $patch)) { Set-Content -Path $patch -Value '' -Encoding UTF8 }
if (-not (Test-Path $bak)) { Copy-Item $patch $bak -Force; Write-Host '[ok] 补丁层已备份' }
else { Write-Host '[ok] 补丁层备份已存在' }

$txt = Get-Content $patch -Raw -Encoding UTF8
if ($null -eq $txt) { $txt = '' }
if ($txt.Contains('dsh-deeper-think')) {
    $txt = $txt.Replace("name: 'dsh-deeper-think'", $relRow.Trim())
    $txt = $txt.Replace('name: "dsh-deeper-think"', $relRow.Trim())
    Set-Content -Path $patch -Value $txt -Encoding UTF8 -NoNewline
    Write-Host '[ok] 补丁层已有该插件，已规范化为相对路径'
} else {
    $block = "`r`n# dsh-deeper-think: composer lightning + settings（用户补丁层）`r`n- insert:`r`n    - id: dsh-deeper-think`r`n$relRow`r`n"
    Add-Content -Path $patch -Value $block -Encoding UTF8
    Write-Host '[ok] 已写入补丁层注册行'
}

# 清理历史安装残留（node_modules 副本、package.json 登记）
$nm = Join-Path $web 'node_modules\dsh-deeper-think'
if (Test-Path $nm) { Remove-Item $nm -Recurse -Force; Write-Host '[ok] 已移除 node_modules 旧副本' }
$manifestPath = Join-Path $web 'package.json'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dirty = $false
if ($manifest.dependencies -and $manifest.dependencies.PSObject.Properties.Name -contains 'dsh-deeper-think') {
    $manifest.dependencies.PSObject.Properties.Remove('dsh-deeper-think'); $dirty = $true
}
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $b = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-deeper-think' })
    if ($b.Count -ne @($manifest.dsh.profile.bundles).Count) { $manifest.dsh.profile.bundles = $b; $dirty = $true }
}
if ($dirty) {
    $manifest | ConvertTo-Json -Depth 40 | Set-Content $manifestPath -Encoding UTF8
    Write-Host '[ok] 已清理 package.json 中的旧登记'
}

Write-Host ''
Write-Host '[完成] 请完全退出并重新打开 DSH Desktop。'
Write-Host '验证：模型选择器左侧出现闪电；点击变实心；设置侧栏出现「更深思考」。'
