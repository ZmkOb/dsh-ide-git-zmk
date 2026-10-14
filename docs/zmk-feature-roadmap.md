# dsh-ide-git-zmk 功能改造路线图

> 目标仓库：https://github.com/ZmkOb/dsh-ide-git-zmk
> 基线：dsh-ide-git **v0.18.4**（fork 自 KannaKuron/dsh-ide-git），115 次提交，分支 `main`
> 本地路径：`D:\works\dsh-ide-git-zmk`

---

## 0. 背景与总体目标

公司代码仓库是 **SVN**，不是 git。而 SVN 缺少"轻量本地分支"能力，无法支撑"边写边试、随时切回"的开发方式。

因此本改造的核心思路是：

> **用 git 做本地版本管理与分支切换，用 SVN 做最终交付。**

插件要在同一个工作区里驾驭两套版本控制系统，并把接近 IDEA 的可视化体验带进 DSH。

---

## 1. 插件现状（已实测）

| 项 | 现状 |
|---|---|
| 形态 | `dsh-better-sidebar` 的一个 tab 插件（v0.13.0 起也可挂主对话区） |
| 版本 | 0.18.4 |
| 结构 | `src/index.js`（Host 半：注册路由 + git CLI 封装）/ `src/client.js`（Client 半：面板组件） |
| 后端 | 纯 `git` CLI 驱动 |
| 已有能力 | status / diff / log / show / stage / unstage / discard / commit / checkout / branch(增删改) / merge / rebase / cherry-pick / revert / reset / fetch / pull / push / stash / worktree / 删除可撤回浮窗 / 右键发送到对话 |
| **缺失** | ① 变更文件是**平铺列表**，无目录树<br>② **无冲突解决 UI**（仅识别并分组，`conflicted: decorate(...)`）<br>③ **无任何 SVN 能力**<br>④ **无选区级历史**<br>⑤ **无工作流强制介入** |

缺口与需求一一对应：需求 1 ↔ ①，需求 2 ↔ ②，需求 3/4/5 ↔ ③④，需求 6 ↔ ⑤。

---

## 2. 需求清单

### 需求 1：变更文件的目录树视图

**问题**：变更现在是**平铺列表**。改动落在深层目录时（如
`transfer-common/transfer-common-core/src/main/java/com/medicom/common/...`），
只看列表无法判断"改动集中在哪个模块"。

**期望**
- 变更以**目录树**呈现，可折叠
- 目录节点聚合子项统计（文件数、`+n −m`）
- **保留平铺列表**作为可切换视图（两种都要，不要只留树）
- 只显示"有改动的路径"；单子节点目录链做压缩，避免层层展开

**技术要点**
- `git status --porcelain=v2 -z` 取完整路径集（含 rename 的旧路径）
- 前端把路径列表构树；注意 `core.quotepath` 与中文路径
- 与现有 staged / unstaged / untracked / conflicted 分组共存

**开放问题**
- 树与分组如何组合？→ 倾向「**一棵树 + 状态角标**」，切分组时做过滤

---

### 需求 2：合并冲突的三栏视图（IDEA 风格）

**问题**：当前冲突**没有任何解决界面**。且 `git diff` 在冲突时输出的是
**组合差异（combined diff, `diff --cc`）**，格式与普通 diff 完全不同
（三段行号 `@@@`、**两列** `+/-` 标记），现有渲染器无法正确表达 —— 所以看起来"没做好"。

**期望（对齐 IDEA）**
- **三栏**：左 = 我方(Ours)，中 = 合并结果，右 = 对方(Theirs)
- 顶部 `<<<` `===` `>>>` 冲突块逐个跳转
- 每个冲突块提供：**采用我方 / 采用对方 / 两者都保留**
- 实时保存合并结果

**技术要点（已实测可用）**
- 冲突期间 git 把**三份内容都存在索引的三个 stage**：
  - `:1:<path>` = base（共同祖先）
  - `:2:<path>` = ours（当前分支）
  - `:3:<path>` = theirs（被合入分支）
- 取法：`git show :1:<path>` / `:2:` / `:3:` —— 可仿照现有 `git.show` 路由扩展
- 写回：用户确认后 `git add <path>` 标记该文件已解决
- 解析冲突块：按 `<<<<<<<` / `=======` / `>>>>>>>` 切分（diff3 风格还会多一段 `|||||||` base）
- ⚠️ **方向陷阱**：**merge** 里 `--ours`=当前分支、`--theirs`=被合入分支；
  **rebase** 里两者相反。UI 必须按操作类型给正确标签，别写死

**开放问题**
- 中间栏可编辑还是只读？（可编辑更接近 IDEA，但复杂度高）
- 是否需要"整个文件采用某一侧"的快捷操作？→ 建议要，配二次确认

---

### 需求 3：SVN 接入 —— add / delete / commit

**背景**：推送（`git push`）对本项目**不重要**。真正需要的是把本地开发结果交付给 SVN。

**期望**
- 用 git 做本地分支与实验；编码完成后把这个分支的**工作区现场**提交给 SVN
- 需要"从 SVN 添加/删除文件"（`svn add` / `svn delete`）——
  因为 git 的新增/删除**不会自动反映**到 SVN 的版本控制
- 提交目标通常取 **master**

**技术要点**
- `svn status` 给出 SVN 视角状态（`?` 未纳管 / `A` 待加 / `D` 待删 / `M` 修改 / `!` 缺失 / `C` 冲突）
- `svn add` / `svn delete` / `svn commit -m`
- ⚠️ **关键设计问题**：工作区是 **git 仓库与 SVN 工作副本并存**（同时有 `.git` 和 `.svn`）吗？
  - 若是：两套 VCS 各自独立追踪，插件必须清楚"当前视图是 git 视角还是 svn 视角"
  - 实测参考：你现有的 `pip2-transfer-tool` **只有 `.git`、没有 `.svn`**，所以目标形态待确认
- 参考：本机已有 `~/.dsh/plugins/dsh-better-sidebar-svn`（ztyhehe 版），
  已实现 `svn status/diff/log/commit/update/revert/add/resolve/cat/info`，**现成最佳范本**

**开放问题**
- `svn add/delete` 是"手动逐个操作"还是"扫描 git 变更自动建议"？
  → 倾向后者（"一键把 git 的新增/删除同步给 svn"）
- `svn update` 的结果与本地 git 改动冲突时如何处理？

---

### 需求 4：提交 SVN 前的目录树差异视图 + 仓库/传入视图

对齐 **IDEA 的 Subversion 工具窗口**，分两块：

#### 4a. 变更视图（对应 IDEA"本地修改"/ Commit 对话框）
- 以**目录树**展示"当前工作区 vs 上次版本（SVN BASE revision）"的差异
- 目录聚合统计、可展开到文件、点文件看 diff
- 用途：**提交前审查**

#### 4b. 仓库 / 传入视图（对应 IDEA Repository / Incoming）
- 查看**整个提交历史**（`svn log`）
- 查看**其他同事提交了什么**（"传入" = 服务端有而本地没有的修订）
- **每次提交的详情可按文件目录树展开**（该次提交改了哪些文件，树形呈现）

**技术要点**
- `svn status --xml` / `svn diff` / `svn log --xml -v`
  —— **`-v` 才带变更路径列表**，这是"提交详情可展开"的数据来源
- "传入"范围：`svn log -r HEAD:<base>`；或 `svn status -u` 联网查服务端更新
- XML 输出优于文本输出（你现有 SVN 插件已确立这条原则）
- 性能：`svn log` 是**唯一必须联网**的命令 → 需要缓存与分页（你的 SVN 插件已实现 TTL 缓存）

**开放问题**
- "传入"要做到真正的双栏对比（本地 BASE vs 服务端 HEAD），还是只需列出"服务端有而本地没有的修订"？
- 大仓库的 `svn log` 分页策略

---

### 需求 5：历史查询 —— 文件级 / 选区级（SVN + 本地 git）

**期望**
- **单个文件的 SVN 提交历史**（`svn log <path>`）
- **某个选区的历史**：选中一段代码，查它被谁、何时、为何改过
- **依托本地 git 的选区本地历史**：git 有完整本地历史，可做到**不联网**、逐次提交回溯某选区的演变

**技术要点**
- 文件级 SVN：`svn log -v <path>`
- 选区级 SVN：**SVN 没有原生行级历史**，可行路径：
  1. `svn blame`（逐行作者/修订号）→ 取选区涉及行 → 汇总修订号 → 逐修订 `svn log`/`svn diff` 取详情
     （本质是 IDEA "Annotate" 能力的延伸）
  2. 或 `svn log --diff` + 逐修订 diff 文本匹配（成本高，必须缓存）
- 选区级本地 git：**`git log -L <start>,<end>:<file>`** —— git 原生支持行范围历史，
  是最强的工具，能逐次提交展示该行区间如何演变；也可用 `git blame -L`
- 前端需要"选区 → 行号 → 查询"的交互闭环

**开放问题**
- 选区历史结果如何呈现？（列表 + 逐修订 diff / 时间轴？）
- 是否需要"跟随模式"（选区随文件变动自动跟踪）？复杂，建议后置

---

### 需求 6：强制性的分支工作流介入

**期望**（把前面能力串成自动化闭环）
- DSH 开始开发某个工程时，**默认自动启用一个分支**（无需用户手动建）
- 开发完成后，**默认自动暂存**本次开发涉及的文件
- 用户只需决定两件事：
  - **是否合并**这个分支
  - **何时**把 master 提交给 SVN

**技术要点**
- "强制介入"意味着插件要**监听 DSH 会话/工具事件**，而不是被动等点击
  - 可介入点：会话开始、turn 开始/结束、文件写操作、agent 工具调用前后
  - 可行性参考：`dsh-better-sidebar` 的"本轮文件视角"已能**实时追踪模型读/写/编辑的每个文件**，
    说明这类介入是可行的
- 分支命名策略（`dsh/<session 短码>` 或 `dsh/<时间戳>`）
- 自动暂存范围：只暂存 agent 改动的文件，还是全部变更？
- 决策点要**显式且低摩擦**：一个"合并 / 丢弃 / 再改改"的选择器

**开放问题**
- 自动建分支的触发时机：会话绑定工作区时？还是第一次文件写入时？
- 若工作区**已有未提交改动**，新的自动分支怎么处理？（先 stash？先提示？）
- "强制"是默认行为还是设置开关？→ 建议**默认开启但可关**，且首次使用时明确告知
- 与 SVN 的关系：自动分支是 **git 分支**；提交 SVN 是独立的手动动作（见需求 3/4）

---

## 3. 架构决定

### ✅ 已定：同一目录双 VCS（`.git` + `.svn` 并存）

工程目录**本身就是 SVN 工作副本**，在其中 `git init` 叠加本地分支能力。
**同一批文件由两套 VCS 同时追踪**，彼此独立。

**对架构的直接影响**

| 影响面 | 说明 |
|---|---|
| 状态来源 | 两套状态**互不相通**：`git status` 是本地分支视角，`svn status` 是交付视角。插件必须**同时维护两个视角**并明确标识当前在哪个 |
| "上次版本"有两种 | git 的"上次" = 上一个提交；svn 的"上次" = `.svn` 里的 BASE revision。需求 4a 的差异对比必须指明比的是哪一个 |
| `svn add/delete` 不能省 | git 的新增/删除**不会**自动同步给 svn —— 这正是需求 3 存在的理由 |
| 提交给 SVN 的语义 | "把 master 的现场提交给 svn" = 对工作区跑 `svn commit`，**与 git 当前在哪个分支无关**（svn 只看文件系统当前状态） |
| 冲突可能层叠 | svn 冲突（工作副本标记）与 git 冲突（stage 1/2/3）**可能同时存在**，UI 需分别呈现、避免混淆 |
| 忽略规则独立 | `.gitignore` 与 `svn:ignore` 两套规则各自维护，互不影响 |

**关键推论**：git 分支切换会**直接改写文件系统**，而 SVN BASE 绑定在目录上。
所以在 git 分支间反复切换时，`svn status` 会显示大量"修改"—— 这是预期行为，不是错误。
插件需要一个"**把当前 git 分支的现场同步给 svn 视角**"的心智模型（见需求 6）。

### ⏳ 待定

1. **git 与 svn 的分工边界**：是"所有文件两套都管"，还是"部分文件只给 git 管"（如不受 svn 纳管的构建产物）？
2. **提交单位**：提交给 SVN 时，是"整个工作区当前状态"，还是只提交某个 git 分支引入的差异？
3. **视图切换**：git 视角与 svn 视角是同面板切换，还是两个独立 tab？
4. **改造方式**：直接在 `dsh-ide-git` 上扩展，还是新建独立插件？
   - 倾向：需求 1/2/6 在 `dsh-ide-git` 上做（纯 git）；
     SVN 部分（3/4/5）**借鉴或合并** `dsh-better-sidebar-svn`

---

## 4. 建议分期

| 期 | 内容 | 理由 |
|---|---|---|
| **P0** | 需求 1（目录树视图） | 纯前端 + 已有 status 数据；改动最小、收益立竿见影；用来跑通"改造 → link 装进 dsh2 → 验证"的闭环 |
| **P1** | 需求 2（三栏冲突） | 纯 git、缺口明确、三个 stage 数据现成，技术风险可控 |
| **P2** | 需求 3 + 4a（SVN add/delete/commit + 提交前目录树） | SVN 接入第一步，可参考本机已有的 SVN 插件 |
| **P3** | 需求 4b（仓库/传入视图） | 依赖 `svn log -v` 与缓存，工作量中等 |
| **P4** | 需求 5（选区历史） | 技术上最有意思但最复杂，尤其选区级 SVN 历史 |
| **P5** | 需求 6（强制工作流） | 需与 DSH 会话事件深度耦合，放最后 —— 它要调用前面所有能力 |

---

## 5. 参考资料

- **本机现成范本**：`~/.dsh/plugins/dsh-better-sidebar-svn` ——
  完整实现 SVN 的 status/diff/log/commit/update/revert/add/resolve/cat/info，
  且 README 明确"与 Git 面板对称"。**需求 3/4/5 直接从它抄。**
- 生态参考：
  - `yq04/dsh-git-remotes` —— 分支/上游/ahead-behind、fetch/pull/push
  - `thirsty5034/dsh-git-forge` —— 账号授权与推送策略
  - `Lzh3070/dsh-file-review-tab` —— 行级 diff + 撤销 + 深链回 chat
  - `yq04/dsh-turn-review` —— 逐回合审查 agent 改动
- 插件机制：`dsh-better-sidebar` 的 `registerTab` / `registerFileViewer` 扩展点

---

## 6. 开发环境

| 项 | 值 |
|---|---|
| 仓库 | `D:\works\dsh-ide-git-zmk` |
| 远程 | `origin` = https://github.com/ZmkOb/dsh-ide-git-zmk.git |
| 基线 | v0.18.4，115 次提交，分支 `main` |
| 试验台 | dsh2（`D:\works\dsh2`，独立 DSH 0.2.0-rc.2 + 独立 home，端口 3081） |

装本次开发中的插件到 dsh2（**link 方式，改完即生效**）：

```powershell
$env:DSH_HOME = "D:\works\dsh2\dsh2-home\.dsh"
$env:npm_config_prefix = "D:\works\dsh2\npm-global"
$env:PATH = "D:\works\dsh2\npm-global;" + $env:PATH
cd $env:DSH_HOME
dsh plugin --profile web add link:D:\works\dsh-ide-git-zmk
```

> **热加载差异**：Client 半（`src/client.js`）改动 **硬刷新浏览器**即可；
> Host 半（`src/index.js`）改动**需重启 dsh2**。

---

## 7. 待办（未决）

- [ ] 回复第 3 节的 5 个设计问题
- [ ] 配置 GitHub 推送凭据（当前无 credential.helper、无 SSH 密钥）
- [ ] 设置仓库级 git 身份（全局 `user.name` / `user.email` 目前为空）
