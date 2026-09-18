# 《牵丝》Gitee 协作规范

> 面向：项目负责人（你）
> 目标：把项目托管到 Gitee，并建立可持续的协作流程

---

## 0. 先说结论：你只需要做 5 件事

本地仓库骨架我已经建好了（含 `.gitignore`、`.gitattributes`、README、决策记录，并已完成首次提交）。

**剩下这 5 步只有你能做**（需要账号和网络权限）：

| # | 事 | 耗时 |
|---|---|---|
| 1 | 注册 Gitee 并实名认证 | 10 分钟 |
| 2 | 创建仓库 | 3 分钟 |
| 3 | 配置 SSH 公钥 | 10 分钟 |
| 4 | 关联远程并推送 | 2 分钟 |
| 5 | 在 Gitee 上建里程碑与标签 | 5 分钟 |

总计约 30 分钟。

---

## 1. 注册与实名认证

**注册**：https://gitee.com/signup

**实名认证**：`设置` → `账号信息` → 实名认证

| 实名类型 | 用途 | 说明 |
|---|---|---|
| 个人实名 | 创建公开仓库、用 Pages、用流水线 | 身份证，几分钟通过 |
| 企业认证 | 企业主体、更多协作人数 | 需营业执照 |

> ⚠️ **未实名的账号功能受限**，建议一开始就做个人实名。

---

## 2. 创建仓库

`右上角 +` → `新建仓库`

| 字段 | 填什么 | 说明 |
|---|---|---|
| 仓库名称 | `qiansi` | 英文小写，避免中文路径问题 |
| 归属 | 你的用户名 | |
| 路径 | `qiansi` | |
| 介绍 | 单机 2D 物理动作游戏 · 没有连招表，只有物理定律 | |
| **是否开源** | **私有**（推荐） | 商业项目，先私有 |
| 语言 | Lua / TypeScript（后续再改） | 现在随便选 |
| **初始化仓库** | **❌ 全部不勾** | 本地已有内容，勾了会冲突 |
| .gitignore | 不选 | 本地已写好 |
| 开源许可证 | 不选 | 未定 |
| 默认分支 | 若可选，选 **main** | 不可选则建完去设置里改 |

建完后仓库地址形如：

```
HTTPS:  https://gitee.com/<你的用户名>/qiansi.git
SSH:    git@gitee.com:<你的用户名>/qiansi.git
```

> **如果 Gitee 默认分支是 `master`**：去 `仓库设置` → `仓库信息` → `默认分支` 改成 `main`。
> 或者本地改用 master（见 §4 的备选方案）。

---

## 3. 配置 SSH 公钥（推荐）

HTTPS 每次推送都要输密码；SSH 一次配置长期有效。

### 3.1 生成密钥

打开 **Git Bash**（不要用 PowerShell，路径处理更省事）：

```bash
ssh-keygen -t ed25519 -C "1246154165@qq.com"
```

一路回车（默认路径 `~/.ssh/id_ed25519`，密码可留空）。

> 若提示 `ed25519` 不支持（老版本 OpenSSH），改用：
> `ssh-keygen -t rsa -b 4096 -C "1246154165@qq.com"`

### 3.2 复制公钥

```bash
cat ~/.ssh/id_ed25519.pub
```

复制全部输出（以 `ssh-ed25519` 开头的一整行）。

### 3.3 贴到 Gitee

`设置` → `安全设置` → `SSH 公钥` → 标题随意（如 `work-pc`）→ 粘贴 → 确定

### 3.4 验证

```bash
ssh -T git@gitee.com
```

首次会问 `Are you sure you want to continue connecting?` → 输入 `yes`

成功提示：`Hi <用户名>! You've successfully authenticated...`

---

## 4. 关联远程并推送

本地仓库已初始化并完成首次提交。执行：

```bash
cd /d/AICoding/QianSi

# 关联远程（换成你的用户名）
git remote add origin git@gitee.com:<你的用户名>/qiansi.git

# 重命名分支为 main（如果本地还不是）
git branch -M main

# 首次推送并建立追踪关系
git push -u origin main
```

### 备选方案：远端是 master

如果 Gitee 那边默认分支是 `master` 且你不想改：

```bash
git branch -M master
git push -u origin master
```

### 如果推送被拒（远端有内容）

比如建仓时手滑勾了「初始化仓库」：

```bash
git pull origin main --allow-unrelated-histories
# 解决冲突后
git push -u origin main
```

### 用 HTTPS 的话

```bash
git remote add origin https://gitee.com/<你的用户名>/qiansi.git
git push -u origin main
```

> Gitee 的 HTTPS 推送需要**账号密码**或**私人令牌**（`设置` → `私人令牌`）。
> 2021 年后 Gitee 要求部分账号使用私人令牌代替密码。

---

## 5. 在 Gitee 上建里程碑与标签

### 5.1 里程碑（对应发布阶段）

`仓库` → `里程碑` → 新建：

| 里程碑 | 说明 | 关联 |
|---|---|---|
| `M0 物理原型` | 3 周，灰盒房间验证三键操作 | D-015 |
| `M1 垂直切片` | 3 个月，序章 12 分钟 | **AC-01** |
| `M2 小游戏验证版` | 4 个月，3–5 关 + 挑战模式 | R2 的 104 条需求 |
| `M3 完整版` | 12–18 个月，6 章 | R3 的 76 条需求 |

### 5.2 标签（对应需求模块）

`仓库` → `标签` → 新建：

```
FR-PHY  物理与丝线核心
FR-ACT  操作与输入
FR-CBT  战斗与敌人
FR-PRG  成长与心法
FR-LVL  关卡与流程
FR-UI   界面与 HUD
FR-NAM  命名与成就
FR-SAV  存档与进度
FR-CHL  挑战与速通
FR-SOC  社交与分享
FR-IAP  商业化
FR-ADS  广告接口
FR-RND  渲染与分层
FR-LIV  运营与热更
NFR     非功能需求
CR      合规需求
```

### 5.3 导入需求条目（可选）

`docs/需求追踪矩阵.csv` 有 234 行，可以批量导入 Issue。

Gitee 支持 CSV 导入 Issue（`仓库` → `管理` → `导入`），但字段映射需要人工调整。
**建议**：先把 P0 + R1 的 51 条手工建 Issue，其余等排期时再建。

---

## 6. 分支策略

**小队（1–3 人）用这套就够了**，不要上 Git Flow：

```
main       ← 永远可运行。只接受合并，不直接提交
  │
  ├── feat/FR-PHY-002-reel-speed     功能分支
  ├── fix/AC-07-tension-sound        修复分支
  └── chore/upgrade-git              杂项分支
```

**规则**：

| 规则 | 说明 |
|---|---|
| `main` 永远可运行 | 合并前必须本地跑通 |
| 一个分支一件事 | 不要在一个分支里混多个需求 |
| 分支名带需求 ID | `feat/FR-PHY-002-reel-speed`，方便追溯 |
| 合并用 Squash | 保持 main 历史干净 |
| 合并后删分支 | 别囤积 |

---

## 7. 提交信息规范

用 **Conventional Commits**，并且**带上需求 ID**：

```
<类型>(<需求ID>): <描述>
```

**类型**：

| 类型 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `docs` | 文档 |
| `refactor` | 重构（不改行为） |
| `perf` | 性能优化 |
| `test` | 测试 |
| `chore` | 构建/工具/杂项 |

**示例**：

```bash
git commit -m "feat(FR-PHY-002): 实现收丝速度上限与疾丝心法倍率"
git commit -m "fix(AC-07): 修正张力 95% 时颤音未触发的问题"
git commit -m "docs(SRS): 补充广告合规章节 CR-ADS-001~007"
git commit -m "perf(NFR-PERF-007): 物理单帧耗时从 9ms 降到 5.2ms"
```

**为什么带需求 ID**：这样每个提交都能在 `需求追踪矩阵.csv` 里找到对应条目——
**从代码一路追回设计意图**。这是这份 SRS 存在的意义。

---

## 8. 日常流程

```
1. 从 main 切分支
     git checkout main && git pull
     git checkout -b feat/FR-XXX-短描述

2. 开发 + 提交
     git add -A
     git commit -m "feat(FR-XXX): ..."

3. 推送
     git push -u origin feat/FR-XXX-短描述

4. 在 Gitee 发起 Pull Request（合并请求）
     - 关联对应 Issue
     - 描述里写清「验证了哪条 AC」

5. 自查通过 → 合并到 main → 删分支
```

**单人项目也别省这一步。** PR 的价值不是代码审查，是**留下「这次改了什么、验证了什么」的记录**。

---

## 9. 容量管理 ★

**Gitee 社区版硬限制**（[官方配额说明](https://help.gitee.com/questions/Gitee%E4%BA%A7%E5%93%81%E9%85%8D%E9%A2%9D%E8%AF%B4%E6%98%8E)）：

| 项 | 上限 |
|---|---|
| **Git 单仓库容量** | **500 MB** |
| **单文件** | **50 MB** |
| 账号总仓库容量 | 5 GB |
| 私有仓库协作人数 | 5 人 |

### 9.1 对 Cocos 项目意味着什么

⚠️ **`library/` 一个目录就能超过 500MB。**

它已经写进 `.gitignore` 了。**永远不要提交 `library/`、`temp/`、`build/`、`local/`。**

### 9.2 各阶段预估

| 阶段 | 仓库内容 | 预估体积 | 是否安全 |
|---|---|---|---|
| R1 | 文档 + 代码（无美术） | < 20 MB | ✅ 很安全 |
| R2 | + 水墨资源 + 音频 | 100–400 MB | ⚠️ 需监控 |
| R3 | + 6 章资源 | **可能超限** | ❌ 需方案 |

### 9.3 R2 之前必须决策（对应 D-013）

| 方案 | 做法 | 评价 |
|---|---|---|
| ① 全部进 Git | — | ❌ 不可行 |
| ② Git LFS | `git lfs track "*.png"` | ⚠️ **占用同一 500MB 配额**，治标不治本 |
| ③ **对象存储** | 美术源文件放阿里云 OSS / 腾讯云 COS，仓库只提交导出的成品 | ✅ **推荐** |

### 9.4 检查仓库体积

```bash
# 查看 .git 目录大小
du -sh .git

# 找出最大的 10 个已跟踪文件
git ls-files -z | xargs -0 du -h | sort -rh | head -10
```

### 9.5 如果已经超了

Gitee 提供历史改写瘦身方案：
https://help.gitee.com/repository/base/仓库体积过大，如何减小

**但历史改写会重写所有 commit hash，协作成员必须重新克隆。** 事先防比事后救便宜得多。

---

## 10. 可以顺便用起来的 Gitee 功能

| 功能 | 用途 | 优先级 |
|---|---|---|
| **Issues** | 对应需求与缺陷 | ⭐⭐⭐ 必用 |
| **里程碑** | 对应 M0–M3 | ⭐⭐⭐ 必用 |
| **标签** | 对应需求模块 | ⭐⭐ 建议 |
| **Pull Request** | 变更记录 | ⭐⭐ 建议 |
| **Wiki** | 放设计文档（也可直接放 `docs/`） | ⭐ 可选 |
| **Gitee Go** | CI：每次推送自动跑确定性回归测试 | ⭐⭐ R1 后考虑 |
| **发行版 Release** | 每个里程碑打包构建产物 | ⭐⭐ 建议 |
| **代码质量分析** | 静态扫描 | ⭐ 可选 |

> **建议**：R1 阶段只上 Issues + 里程碑 + PR。别一上来配 CI，会拖慢启动。

---

## 11. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `Permission denied (publickey)` | SSH 公钥没配好 | 重跑 `ssh -T git@gitee.com`，检查公钥是否贴全 |
| `src refspec main does not match any` | 本地还没有提交 | 先 `git add -A && git commit` |
| 推送后中文文件名显示成 `\344\270\255` | `core.quotepath` 默认开启 | `git config --global core.quotepath false` |
| 换行符警告满屏 | Windows CRLF | 已由 `.gitattributes` 处理；若仍有，`git config --global core.autocrlf false` |
| `fatal: remote origin already exists` | 重复添加 | `git remote set-url origin <新地址>` |
| 推送卡住 | 大文件 | 检查是否误提交了 `library/` 或 `build/` |
| 仓库超 500MB 被锁定 | 提交了缓存目录 | 见 §9.5 |

---

## 12. 环境提醒

| 项 | 状态 | 建议 |
|---|---|---|
| Git 版本 | **2.7.2.windows.1**（2016 年） | **建议升级到 2.40+** |
| Git 全局身份 | `PuitungChan` / `1246154165@qq.com` | 已配置 |
| 仓库 | 本地已初始化，**尚未关联远程** | 见 §4 |

> Git 2.7.2 缺少不少现代特性（`git switch`、`git restore`、`init.defaultBranch`、部分 LFS 支持）。
> 从 https://git-scm.com/download/win 装新版即可，配置文件会保留。

---

## 13. 附：本次已完成的本地操作

供你核对：

| 操作 | 结果 |
|---|---|
| `git init` | ✅ 已初始化 |
| 默认分支 | ✅ `main` |
| `core.quotepath` | ✅ 已设为 `false`（中文文件名正常显示） |
| `i18n.commitencoding` | ✅ UTF-8 |
| 首次提交 | ✅ 已提交（见 `git log`） |
| 远程关联 | ⬜ **待你做**（§4） |

验证命令：

```bash
cd /d/AICoding/QianSi
git log --oneline
git status
git ls-files | wc -l
```
