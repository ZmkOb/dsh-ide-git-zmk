# 开发环境配置：GitHub 推送凭据

> 目标：让本机 git 能推送到 `https://github.com/ZmkOb/dsh-ide-git-zmk`
> 适用：Windows + Git 2.32.0 + Git Credential Manager 2.0.475

## 现状（实测，配置前）

```
credential.helper (global) = ''        ← 未配置
credential.helper (system) = ''        ← 未配置
系统级 gitconfig            = 不存在
~/.ssh                      = 只有 known_hosts（无密钥）
Windows 凭据管理器          = 无 github 记录
git user.name / user.email  = 均为空   ← 提交会失败
```

**结论**：什么都没配，`git push` 会失败或卡在交互提示。

**好消息**：Git Credential Manager 已随 Git 装好（无需额外安装）：

```
D:\Program Files\Git\mingw64\libexec\git-core\git-credential-manager.exe       ← helper 名 = manager
D:\Program Files\Git\mingw64\libexec\git-core\git-credential-manager-core.exe  ← helper 名 = manager-core
```

---

## 第 1 步：设置 git 身份（提交必需）

全局 `user.name` / `user.email` 都是空的，**不设就无法提交**。建议只设到本仓库，不动全局：

```powershell
cd D:\works\dsh-ide-git-zmk

git config user.name  "ZmkOb"
git config user.email "<你的 GitHub noreply 邮箱>"
```

> **邮箱怎么填**：去 GitHub → 右上头像 → **Settings** → **Emails**，
> 找到形如 `12345678+ZmkOb@users.noreply.github.com` 的地址。
> 用这个才能让提交正确归属到你的账号。简单的 `ZmkOb@users.noreply.github.com` 也能用，
> 但带数字 ID 的才是 GitHub 官方推荐形式。

验证：

```powershell
git config user.name
git config user.email
```

---

## 第 2 步：创建 Personal Access Token（PAT）

打开 👉 **https://github.com/settings/tokens?type=beta** （Fine-grained tokens）

1. 点 **Generate new token**
2. **Token name**：`dsh-ide-git-zmk-dev`
3. **Expiration**：按需（90 天或自定义；过期后需重新生成）
4. **Resource owner**：选 `ZmkOb`
5. **Repository access** → 选 **Only select repositories** → 只勾 `ZmkOb/dsh-ide-git-zmk`
   （最小权限，别选 All repositories）
6. **Permissions** → 展开 **Repository permissions**，设置：

| 权限 | 设为 | 为什么 |
|---|---|---|
| **Contents** | **Read and write** | ✅ **必须** —— 推送代码靠它 |
| **Metadata** | Read-only | 自动勾选，必须保留 |
| Pull requests | Read and write | 可选：以后要开 PR 就勾 |
| **Workflows** | **Read and write** | ⚠️ 见下方说明 |

> ⚠️ **关于 Workflows 权限**：这个仓库有 `.github/workflows/` 目录。
> GitHub 规定：**只要推送的提交修改了 workflow 文件，就要求该权限**，否则推送被拒
> （报 `refusing to allow a Personal Access Token to create or update workflow`）。
> 如果你后续要改 CI 配置，就得勾上；不改的话可以不勾。

7. 点 **Generate token**
8. **立刻复制** 那串以 `github_pat_` 开头的 token —— **页面关掉就再也看不到了**

> 如果你更习惯经典 token：https://github.com/settings/tokens/new
> 勾选 `repo`（必需）+ `workflow`（改 CI 时需要）。权限更宽但配置更简单。

---

## 第 3 步：让 git 使用凭据管理器

```powershell
git config --global credential.helper manager
```

> 如果之后推送时报找不到 helper，把 `manager` 换成 `manager-core` 再试一次
> （两个可执行文件都在，`manager` 是 GCM 2.x 的当前名字）。

验证配置写入成功：

```powershell
git config --global --get credential.helper
```

---

## 第 4 步：首次推送并完成认证

```powershell
cd D:\works\dsh-ide-git-zmk
git push origin main
```

首次会触发认证，Git Credential Manager 通常弹出一个窗口，给两种方式：

- **Sign in with your browser** —— 走浏览器 OAuth，不需要 PAT
- **Token** —— 选这个，然后：
  - Username：`ZmkOb`
  - Password：**粘贴刚才那个 PAT**（不是你的 GitHub 登录密码！）

认证成功后，凭据会存进 **Windows 凭据管理器**，之后的推送不再询问。

---

## 第 5 步：验证

```powershell
# 1. 凭据是否已存入 Windows 凭据管理器
cmdkey /list | Select-String github

# 2. 能读到远程分支说明认证通了
git ls-remote origin

# 3. 确认工作区与远程同步
git status --short --branch
```

三项都正常，就配好了。

---

## 排查表

| 现象 | 原因与处理 |
|---|---|
| `Authentication failed` | PAT 复制不全 / 已过期 / 权限没勾 `Contents: Read and write` |
| `Support for password authentication was removed` | 用登录密码当密码了 —— 必须用 **PAT** |
| `refusing to allow ... to create or update workflow` | 提交改了 `.github/workflows/`，需勾 **Workflows: Read and write** |
| 推送时一直卡住不动 | 在等交互输入。非交互环境（如由 agent 执行）会卡死 —— 必须先在交互终端里认证一次 |
| `could not read Username` | `credential.helper` 没配上，回到第 3 步 |
| 提交报 `Please tell me who you are` | 第 1 步的身份没设 |

---

## 安全检查清单

- [ ] PAT 使用 **fine-grained**，且只授权 `ZmkOb/dsh-ide-git-zmk` 这一个仓库
- [ ] PAT **不要**贴进聊天记录 / 提交到仓库 / 写进 `.git/config`
- [ ] 定期检查 https://github.com/settings/tokens 并清理不用的 token
- [ ] 若曾把 token 贴到聊天或日志里，视为已泄露，**立即吊销重建**

---

## 附：这台机器上还缺的东西

| 项 | 状态 | 影响 |
|---|---|---|
| git 版本 2.32.0（2021 年） | 偏旧 | 部分新命令（如 `git switch` 的部分参数、`merge-tree --write-tree`）不可用 |
| 全局 git 身份 | 空 | 任何仓库提交都会失败 |
| `core.quotepath` | 未设（默认转义） | 中文文件名显示为 `\346\241\243` 转义形式 |
