# GitHub 与双远程方案

> 面向：《牵丝》项目负责人
> 回答：「GitHub 有大小限制吗？该用哪个？」

---

## 1. 直接回答：有，但比 Gitee 宽松得多

| 项 | **Gitee 社区版** | **GitHub Free** |
|---|---|---|
| 仓库数量 | 1000 个 | **无限制** |
| **单仓库容量** | **500 MB（硬上限）** | 建议 < 1 GB；**硬上限 5 GB** |
| **单文件** | **50 MB（硬）** | 50 MB 警告；**100 MB 硬拒绝** |
| **Git LFS** | 有配额，**与仓库容量共享** | **10 GiB 存储 + 10 GiB/月带宽** |
| 账号总容量 | 5 GB | 无硬性总容量（按仓库算） |
| 私有仓库协作 | **≤ 5 人** | **不限** |
| Release 附件 | 单文件 100 MB | 单文件 2 GB |
| CI | Gitee Go（额度有限） | **Actions 2,000 分钟/月**（私有仓库） |
| 实名认证 | **必须** | 不需要 |
| **国内访问速度** | **快** | **慢 / 不稳定** |

数据来源：
- [Gitee 产品配额说明](https://help.gitee.com/questions/Gitee%E4%BA%A7%E5%93%81%E9%85%8D%E9%A2%9D%E8%AF%B4%E6%98%8E)
- [GitHub Git LFS 计费](https://docs.github.com/zh/billing/concepts/product-billing/git-lfs)
- [GitHub 大文件说明](https://docs.github.com/zh/repositories/working-with-files/managing-large-files/about-large-files-on-github)

---

## 2. 关键差异：LFS 的算法完全不同

这是两个平台**最本质**的区别，比仓库容量数字更重要。

### Gitee

LFS 对象**占用同一个 500 MB 配额**。所以 LFS 治标不治本——你只是把大文件从 git 历史挪到了 LFS，总量还是 500 MB。

### GitHub

LFS 是**独立的 10 GiB 配额**，不占仓库容量。

```
GitHub Free 账本：
  Git 仓库本身    ≤ 1 GB（建议）
  Git LFS 存储    10 GiB   ← 独立
  Git LFS 带宽    10 GiB/月 ← 每月重置
```

**10 GiB ≈ Gitee 单仓库上限的 20 倍。**

### 对本项目的意义

回到 `DECISIONS.md` 的 **D-013（大体积素材存放位置）**：

| 阶段 | 素材体积 | Gitee | GitHub |
|---|---|---|---|
| R1（无美术） | < 20 MB | ✅ | ✅ |
| R2（+ 水墨资源 + 音频） | 100–400 MB | ⚠️ 逼近上限 | ✅ 轻松 |
| R3（+ 6 章资源） | 可能 > 1 GB | ❌ **必然超限** | ⚠️ 需 LFS，但 10 GiB 够用 |

**结论：R3 阶段 Gitee 单仓库装不下这个项目。**

---

## 3. 但是：国内访问是个真问题

GitHub 在中国大陆的访问**经常不稳定**，表现：

| 操作 | 体验 |
|---|---|
| `git push`（小提交） | 通常能成，偶尔超时 |
| `git clone`（全历史） | 慢，可能中断 |
| `git pull`（拉取大改动） | 慢 |
| GitHub Actions | 不受影响（跑在境外） |
| 网页访问 | 时好时坏 |

对一个每天要提交十几次的开发流程，这是实打实的摩擦。

---

## 4. 推荐方案：双远程（一次推送，两边都有）

**不要二选一。** Git 支持给一个远程配多个 push URL：

```
origin  fetch ← Gitee（快）
        push  → Gitee + GitHub（一次命令推两边）
```

### 4.1 一次性配置

```bash
cd /d/AICoding/QianSi

# 主地址用 Gitee（因为要经常 fetch/pull，这个必须快）
git remote add origin git@gitee.com:<你的Gitee用户名>/qiansi.git

# 追加两个 push 地址
git remote set-url --add --push origin git@gitee.com:<你的Gitee用户名>/qiansi.git
git remote set-url --add --push origin git@github.com:<你的GitHub用户名>/qiansi.git

# 验证
git remote -v
```

期望输出：

```
origin  git@gitee.com:<user>/qiansi.git (fetch)
origin  git@gitee.com:<user>/qiansi.git (push)
origin  git@github.com:<user>/qiansi.git (push)
```

> 注意 fetch 只有一个，push 有两个。这是正常的——拉取走 Gitee（快），推送两边都发。

### 4.2 之后每次推送

```bash
git push origin main
```

**一条命令，推两个平台。** 不需要记两条命令。

### 4.3 或者用脚本（推荐）

仓库里提供了脚本，自动完成上面 3 条命令：

```cmd
cd /d D:\AICoding\QianSi
scripts\setup-remotes.cmd -GiteeUser 你的Gitee名 -GitHubUser 你的GitHub名
```

先看它要做什么（不修改任何东西）：

```cmd
scripts\setup-remotes.cmd -GiteeUser 你的Gitee名 -GitHubUser 你的GitHub名 -DryRun
```

> ⚠️ **必须用 `.cmd` 而不是直接跑 `.ps1`。**
> 这台机器的 PowerShell 执行策略禁止直接运行脚本，`.\setup-remotes.ps1` 会报
> `running scripts is disabled on this system`。
> `.cmd` 包装脚本内部用 `-ExecutionPolicy Bypass` 绕过，等价于下面这条命令：
>
> ```
> powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-remotes.ps1 ...
> ```

---

## 5. 容量策略（更新 D-013）

有了 GitHub 的 10 GiB LFS，策略可以简化：

| 内容 | 放哪 | 理由 |
|---|---|---|
| 代码、文档、配置表 | Git（两边同步） | 体积小 |
| 导出后的游戏资源（PNG/音频） | **GitHub LFS** | 10 GiB 独立配额 |
| 美术源文件（PSD/ASE/Blend） | **对象存储**（OSS/COS）或 Google Drive | 体积无上限，且 LFS 不适合频繁改动的大二进制 |
| 构建产物（apk/ipa） | **GitHub Releases**（单文件 2 GB） | 不进 git 历史 |

### 5.1 在 GitHub 上启用 LFS

```bash
# 安装 git-lfs：https://git-lfs.com
git lfs install

# 让已有规则生效（.gitattributes 里已列好，取消注释即可）
git lfs track "*.png"
git lfs track "*.psd"

# 提交 .gitattributes 的变更
git add .gitattributes && git commit -m "chore: 启用 Git LFS"
```

> ⚠️ **Gitee 不支持同样的 LFS 配额**。如果同时推到两边，LFS 文件会各占一份配额。
> **建议**：LFS 只对 GitHub 用。可以在 `.gitattributes` 里保持 LFS 规则注释状态，
> 需要时再开；或者干脆**把大素材放在单独的仓库**，只在 GitHub 上建。

### 5.2 更稳妥的做法：素材独立仓库

```
qiansi          ← 代码 + 文档 + 配置（两边同步，体积永远很小）
qiansi-assets   ← 美术与音频（只在 GitHub，开 LFS）
```

主仓库通过**版本号或清单文件**引用素材版本，而不是直接包含它们。

**好处**：主仓库永远轻量，克隆快，Gitee 的 500 MB 上限永远不会成为问题。

---

## 6. 三个方案的取舍

| 方案 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| **只用 Gitee** | 国内快、简单 | R3 必然超限；协作 ≤ 5 人 | R1 快速启动 |
| **只用 GitHub** | 容量大、LFS 充足、Actions 强 | 国内慢 | 有稳定代理 |
| **双远程** ⭐ | 两边好处都占 | 配置稍复杂；推送要发两次 | **推荐** |

### 我的建议

**现在就配双远程。** 理由：

1. R1 阶段就能建立一致的提交历史，避免以后迁移
2. 成本只是一次 3 分钟的配置
3. R2 需要 LFS 时，基础设施已经就位
4. Gitee 挂了的时候，GitHub 是天然备份（反之亦然）

---

## 7. 顺带一提：GitHub Actions 对这个项目很有用

`NFR-REL-003` 要求**确定性回归测试** —— 固定输入集的输出哈希在版本间保持稳定。这正是 CI 的典型场景：

```yaml
# .github/workflows/determinism.yml（R1 之后再写）
name: 确定性回归
on: [push, pull_request]
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test -- --replay fixtures/*.replay --expect-hash
```

GitHub Free 私有仓库有 **2,000 分钟/月**，跑这个绰绰有余。

Gitee Go 也能做，但额度和生态都弱一些。

---

## 8. 常见问题

### 8.0 【已发生】GitHub 推送被拒：`! [rejected] main -> main (fetch first)`

**症状**：Gitee 推上去了，GitHub 报

```
! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'git@github.com:...'
hint: Updates were rejected because the remote contains work that you do
hint: not have locally.
```

**原因**：建 GitHub 仓库时勾了「Initialize this repository with a README」（或 .gitignore / license）。
远端因此多了一个本地没有的提交，git 拒绝覆盖。

**⚠️ 关键**：这种情况下 **`git pull origin main` 是没用的** ——
双远程配置里 `origin` 的 **fetch 走的是 Gitee**，不是 GitHub。必须显式指定 GitHub。

---

#### ✅ 方案 A（推荐）：删掉 GitHub 仓库重建

GitHub 上那个提交只是自动生成的 README，没有价值。重建最干净。

1. GitHub → 仓库页 → `Settings` → 拉到最底 `Danger Zone` → `Delete this repository`
2. `New repository`，名字仍填 `qiansi`
   **⚠️ 所有初始化选项一个都不要勾**（Add a README / Add .gitignore / Choose a license）
3. 回本地：

```cmd
cd /d D:\AICoding\QianSi
git push origin main
```

完成。`origin` 的两个 push 地址会同时收到。

---

#### 方案 B：保留远端内容并合并

如果 GitHub 上已经有值得保留的东西：

```cmd
cd /d D:\AICoding\QianSi

:: 从 GitHub 拉取（不带 push 语义，用专门的 github 远程）
git pull github main --allow-unrelated-histories -X ours

:: 推送（两个平台一起）
git push origin main
```

`-X ours` 表示冲突时以本地为准（比如两边都有 `README.md`，会保留我们的）。

**代价**：会产生一个 `Merge ... into main` 的提交，对全新项目来说历史不够干净。
**所以推荐方案 A。**

---

#### 验证

```cmd
git log --oneline -3
git remote -v
```

期望 `git remote -v` 显示：

```
origin  git@gitee.com:<user>/qiansi.git (fetch)
origin  git@gitee.com:<user>/qiansi.git (push)
origin  git@github.com:<user>/qiansi.git (push)
github  git@github.com:<user>/qiansi.git (fetch)   ← 备用，用于单独操作 GitHub
github  git@github.com:<user>/qiansi.git (push)
```

---

| 问题 | 答案 |
|---|---|
| 两边都能推，冲突怎么办？ | 正常情况不会。fetch 只走 Gitee，所以以 Gitee 为准。真要同步，`git push --all github` 单独推 |
| Gitee 挂了还能提交吗？ | 能。`git push github main` 单独推 GitHub。远程名可以自己加 |
| LFS 文件推到 Gitee 会怎样？ | 会占 Gitee 的 500 MB 配额。**建议大文件只在 GitHub 侧管理** |
| GitHub 会不会因为超 1 GB 封我仓库？ | 不会封，但会邮件提醒。超 5 GB 推送会被拒绝 |
| 国内的 GitHub 代理怎么弄？ | 这是你自己的环境问题，常见做法是配置 `https.proxy`。但**不要把代理写进仓库配置** |
| 能只用 HTTPS 吗？ | 能，但 GitHub 从 2021 起不再接受账号密码，必须用 **Personal Access Token** |

---

## 9. 行动清单

| # | 事 | 谁做 |
|---|---|---|
| 1 | 注册 GitHub 账号 | 你 |
| 2 | 在 GitHub 建空仓库 `qiansi`（**不勾任何初始化**） | 你 |
| 3 | 配 GitHub 的 SSH 公钥（和 Gitee 可以复用同一把） | 你 |
| 4 | 跑 `scripts/setup-remotes.ps1` | 你 |
| 5 | `git push -u origin main` | 你 |

> **SSH 公钥可以复用。** `~/.ssh/id_ed25519.pub` 里的同一把公钥，分别贴到 Gitee 和 GitHub 即可。
