<#
.SYNOPSIS
    配置《牵丝》项目的双远程：一次 git push 同时推到 Gitee 和 GitHub。

.DESCRIPTION
    fetch 只走 Gitee（国内快），push 同时发往两个平台。
    配置完成后，日常只需 `git push origin main`。

.PARAMETER GiteeUser
    你的 Gitee 用户名。

.PARAMETER GitHubUser
    你的 GitHub 用户名。

.PARAMETER RepoName
    仓库名，默认 qiansi。

.PARAMETER UseHttps
    使用 HTTPS 而非 SSH。默认 SSH（推荐，免密）。

.PARAMETER DryRun
    只打印将要执行的命令，不做任何修改。

.EXAMPLE
    .\scripts\setup-remotes.ps1 -GiteeUser zhangsan -GitHubUser zhangsan-git

.EXAMPLE
    .\scripts\setup-remotes.ps1 -GiteeUser zhangsan -GitHubUser zhangsan-git -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GiteeUser,
    [Parameter(Mandatory = $true)][string]$GitHubUser,
    [string]$RepoName = 'qiansi',
    [switch]$UseHttps,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ── 0. 环境检查 ────────────────────────────────────────────
if (-not (Test-Path '.git')) {
    throw "当前目录不是 Git 仓库根目录。请先 cd 到 D:\AICoding\QianSi"
}

$gitVersion = (git --version) -replace 'git version ', ''
Write-Host "Git 版本：$gitVersion" -ForegroundColor DarkGray
if ($gitVersion -match '^2\.([0-9]|1[0-9])\.') {
    Write-Warning "Git 版本较旧（< 2.20），建议升级到 2.40+"
}

# ── 1. 组装地址 ────────────────────────────────────────────
if ($UseHttps) {
    $giteeUrl  = "https://gitee.com/$GiteeUser/$RepoName.git"
    $githubUrl = "https://github.com/$GitHubUser/$RepoName.git"
} else {
    $giteeUrl  = "git@gitee.com:$GiteeUser/$RepoName.git"
    $githubUrl = "git@github.com:$GitHubUser/$RepoName.git"
}

Write-Host ""
Write-Host "将配置 origin：" -ForegroundColor Cyan
Write-Host "  fetch → $giteeUrl"
Write-Host "  push  → $giteeUrl"
Write-Host "  push  → $githubUrl"
Write-Host ""

# ── 2. 已存在的 origin 处理 ────────────────────────────────
$existing = git remote 2>$null
if ($existing -contains 'origin') {
    Write-Host "检测到已存在的 origin：" -ForegroundColor Yellow
    git remote -v
    if (-not $DryRun) {
        $ans = Read-Host "是否移除并重新配置？(y/N)"
        if ($ans -notmatch '^[Yy]') {
            Write-Host "已取消，未做任何修改。" -ForegroundColor DarkGray
            exit 0
        }
    }
    Write-Host "  git remote remove origin" -ForegroundColor DarkGray
    if (-not $DryRun) { git remote remove origin }
}

# ── 3. 配置 ────────────────────────────────────────────────
$cmds = @(
    "git remote add origin $giteeUrl",
    "git remote set-url --add --push origin $giteeUrl",
    "git remote set-url --add --push origin $githubUrl"
)

foreach ($c in $cmds) {
    Write-Host "  $c" -ForegroundColor DarkGray
    if (-not $DryRun) {
        Invoke-Expression $c
        if ($LASTEXITCODE -ne 0) { throw "命令失败：$c" }
    }
}

if ($DryRun) {
    Write-Host ""
    Write-Host "（DryRun 模式，未做任何修改）" -ForegroundColor Yellow
    exit 0
}

# ── 4. 验证 ────────────────────────────────────────────────
Write-Host ""
Write-Host "配置结果：" -ForegroundColor Green
git remote -v

$pushUrls = @(git remote get-url --push --all origin)

Write-Host ""
if ($pushUrls.Count -eq 2) {
    Write-Host "✓ 双远程配置成功" -ForegroundColor Green
    Write-Host ""
    Write-Host "之后每次推送只需：" -ForegroundColor Cyan
    Write-Host "    git push origin main"
    Write-Host ""
    Write-Host "首次推送：" -ForegroundColor Cyan
    Write-Host "    git push -u origin main"
} else {
    Write-Warning "push 地址数量为 $($pushUrls.Count)，预期 2。请检查上面输出。"
}
