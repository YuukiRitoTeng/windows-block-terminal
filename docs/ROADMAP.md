# 总判断

是的，当前正确的下一步就是做“实现落点设计”。

但它必须是一个短周期、可验收的架构阶段，而不是继续无限研究 Wave。它的产物必须直接回答：

- B2+ 的每个领域边界落在 Wave 哪个真实接缝。
- 最少需要修改哪些上游文件。
- PTY 输出在哪里被复制到 Command Output Store。
- OSC C/D 在哪里解析、排序和持久化。
- 哪些状态由 PowerShell Integration 决定，哪些由 Runtime 决定。
- 哪些失败会触发 B2+ 路线重新评估。

完成落点设计后，不应立刻建设完整产品，而应先做一个无精致 UI 的“生命周期与输出可行性闸门”。如果 C/D、输出边界或 Wave 输出接缝不可靠，越早发现越好。

总体主线应是：

```text
先证明生命周期和输出归属
→ 再证明完整产品闭环
→ 再消灭异常与交互兼容风险
→ 再冻结持久化模型
→ 再处理 Fork、发布和规模
→ 最后投入高级产品 UI
```

# 推荐主干 Roadmap

## 阶段 0：实现落点设计

唯一核心目标：把 B2+ 的领域边界映射到 Wave 当前真实源码，并确定最小 downstream 修改面。

为什么必须现在做：如果没有这一步，Command Journal 很容易侵入 `waveobj.Block`、`ShellController`、`TermWrap` 等上游核心，后续无法低成本合并 upstream。

完成后证明：

- B2+ 不是概念图，而是在当前 Wave 上有明确接缝的方案。
- Command Journal 可以独立于 Wave Block。
- PTY、OSC、输出存储、UI 投影分别有唯一所有者。

进入下一阶段的验收条件：

- `TerminalRuntimeAdapter` 的责任边界明确。
- C/D、PTY bytes、CommandRecord、Command Card 的事件顺序明确。
- 输出捕获点和输出存储策略明确。
- 列出必须修改的 Wave 文件，以及只新增、不修改上游的模块。
- 定义 downstream patch budget 和路线否决条件。
- 不再存在“以后开发时再决定在哪里接入”的核心问题。

---

## 阶段 1：PowerShell Lifecycle / Output Feasibility Gate

唯一核心目标：证明 PowerShell 7 生命周期事件和 PTY 输出边界在真实 Wave Runtime 中可靠可用。

为什么必须现在做：这是整个 B2+ 最可能导致路线失败的假设。它不能拖到 UI、数据库或产品功能完成后再验证。

完成后证明：

- OSC C/D 能稳定识别命令开始和结束。
- C/D 不影响 xterm.js 原始终端行为。
- PTY 输出可以同时进入 xterm.js 和独立 Output Sequencer。
- PowerShell cmdlet、原生程序、pipeline、失败命令具有明确完成语义。
- integration lost 可以被识别，而不是生成错误历史。

进入下一阶段的验收条件：

- 每个测试命令恰好产生一次 C 和一次 D。
- command ID、session epoch、事件顺序可以校验。
- 输出起点、终点可重复验证，没有 prompt、下一条命令或 OSC marker 混入。
- `$LASTEXITCODE`、`$?` 和产品 `success/exitCode` 的映射已经确定。
- 初步验证 Ctrl+C 后 PowerShell 能回到可用 prompt。
- 如果纯 OSC 不可靠，已明确切换到“控制侧信道 + PTY marker”方案。
- 如果输出无法在不深改 Wave 的情况下稳定捕获，应在此阶段重新评估 B2+，而不是继续堆功能。

这是第一个真正的 Go/No-Go 闸门。

---

## 阶段 2：第一条产品垂直切片

唯一核心目标：形成从 PowerShell 输入到 Command Card 的最小完整产品闭环。

为什么必须现在做：阶段 1 只证明机制可行；本阶段要证明领域层、Runtime、输出和 UI 可以组合成产品。

完成后证明：

- Command Journal 是独立领域层，而不是 Wave Block 的附属字段。
- xterm.js 可以保持活动终端，完成的普通命令可以转换为 Command Card。
- Copy Command / Output / All 的数据来源正确。

进入下一阶段的验收条件：

- 同一 PowerShell Session 连续执行至少一个成功命令和一个受控失败命令。
- 每条命令形成独立 CommandRecord。
- 输出实时正常显示在 xterm.js。
- 完成后生成基础 Command Card。
- Card 显示命令、输出、成功/失败、exit code、执行时间。
- Copy Command、Copy Output、Copy All 内容准确。
- Copy Output 不包含 prompt、命令回显、OSC marker 或下一提示符。
- 第二条命令不会污染第一条命令的输出。
- cwd 和 PowerShell Session 没有因生成 Card 而重置。
- UI 只需要功能性样式，不做视觉产品化。

---

## 阶段 3：生命周期正确性与异常恢复

唯一核心目标：建立完整且不会撒谎的 CommandRecord 状态机。

为什么必须现在做：在持久化之前，必须先定义异常记录应该如何结束。否则数据库会固化错误语义。

完成后证明：

- 失败、取消、崩溃、断联和 integration lost 不会产生永久 `running` 记录。
- 系统不会把无法确认的结果错误标记为成功。
- 后台交错输出不会被错误归属为确定的前台输出。

进入下一阶段的验收条件：

- 覆盖 Ctrl+C、shell crash、Wave reconnect、integration lost、缺失 D、重复 D、乱序事件。
- 明确定义 `succeeded`、`failed`、`interrupted`、`aborted`、`unknown`。
- 输出边界算法完成并冻结。
- 后台输出采用安全策略：可标记为 mixed/unattributed，而不是假装准确归属。
- OSC 注入有协议版本、session epoch、command ID、nonce 和状态转换校验。
- 多行命令、pipeline、原生程序和 PowerShell cmdlet 有一致测试结果。

---

## 阶段 4：交互式兼容闸门

唯一核心目标：证明结构化 Command Card 不破坏终端兼容性。

为什么必须现在做：如果普通 Block 体验建立在牺牲 vim、ssh、fzf 或 REPL 的基础上，这条产品路线就不成立。

完成后证明：

- xterm.js 确实是唯一的活动终端兼容层。
- Command Card 只是一种完成后的投影，不接管交互程序。
- 普通命令和交互式命令可以共享同一生命周期模型。

进入下一阶段的验收条件：

- `vim`、`ssh`、`fzf`、Python REPL、nested `pwsh` 均能正常输入、调整尺寸、退出和回到外层 prompt。
- alternate screen 不被错误转换成普通文本 Card。
- SSH 会话作为一条外层 CommandRecord；远端命令不被错误识别成本地命令。
- REPL 内部输入不产生 PowerShell CommandRecord。
- nested `pwsh` 在 MVP 中可作为一条外层交互命令正常使用。
- 交互程序结束后生成摘要 Card，或按明确策略不展示完整输出。
- `TerminalRuntimeAdapter` 的最终能力边界可以冻结。

---

## 阶段 5：持久化、Clear 与数据安全

唯一核心目标：让 Command Journal 成为可靠、可迁移、可清理的数据系统。

为什么必须现在做：在状态机和兼容语义稳定之前持久化，会制造昂贵的数据迁移；现在才是冻结存储结构的正确时间。

完成后证明：

- 历史记录能够跨应用重启恢复。
- 输出不会因为 Wave 循环 term 文件覆盖而失效。
- Clear Visual History 不杀 Session、不 reset PowerShell。
- 敏感信息有明确边界。

进入下一阶段的验收条件：

- CommandRecord、CommandOutputSpan 和 Output Store 可持久化并恢复。
- 有 schema version 和迁移机制。
- 长输出支持截断、外部 blob 或分块存储。
- Clear 只改变视觉历史边界并清理 xterm scrollback，不关闭 PTY。
- Clear 后 cwd、env、venv 和 PowerShell 进程保持不变。
- 完整历史删除与 Clear Visual History 是两个独立操作。
- 不默认保存完整环境变量。
- 历史目录、保留期限、敏感数据和本地删除策略明确。
- 应用崩溃后未完成记录能够恢复为合理状态。

---

## 阶段 6：Fork 隔离与 Upstream 可维护性

唯一核心目标：证明这不是一个只能开发、无法长期合并 upstream 的 Fork。

为什么必须现在做：在大量 UI 产品化之前，需要确认 downstream 距离仍然受控。

完成后证明：

- 产品逻辑主要存在于新增模块。
- Wave 更新可以被持续吸收。
- Runtime 可以通过 Adapter 隔离，而不是渗透整个产品。

进入下一阶段的验收条件：

- 完成一次真实的 upstream 合并或升级演练。
- 冲突集中于少数 adapter/hook 文件。
- 产品模块不直接依赖大量 Wave 内部类型。
- upstream 核心改动清单可审计。
- 自动化兼容测试覆盖 PTY、C/D、输出、恢复和交互程序。
- 发现上游改动时，可以明确判断是适配器修改还是领域层修改。

---

## 阶段 7：可发布 MVP 基础

唯一核心目标：把正确的技术闭环变成可安装、可承受真实数据量的 Windows 产品。

为什么必须现在做：打包、升级、性能和大量历史不能留到 UI 完成后才验证。

完成后证明：

- 产品可以在干净 Windows 11 环境安装和升级。
- 大量 Command Cards 和长输出不会使 UI 失控。
- 基础交互已经达到日常使用水平。

进入下一阶段的验收条件：

- Windows 安装、卸载、升级和数据迁移可用。
- 代码签名和发布通道有明确方案。
- 应用崩溃不会破坏 PowerShell Session 历史数据库。
- Command Card 列表虚拟化。
- 输出按需加载，不因历史规模全部进入内存。
- 达到预先定义的启动、内存、滚动和长输出性能预算。
- 键盘导航、选择、复制、焦点、搜索基础体验可用。
- 完成基础而克制的产品 UI。
- 达到“可发布 MVP”标准。

---

## 阶段 8：Beta 产品化与视觉身份

唯一核心目标：把 MVP 打磨成可供外部用户长期试用的 Beta。

为什么必须现在做：此时架构、性能和兼容性已经稳定，视觉投入不会被底层重构浪费。

完成后证明：

- 产品具有独立于 Wave 的使用体验和视觉身份。
- 真实用户环境中的兼容与升级问题可控。
- Windows 材质不会损害性能、可读性和兼容性。

进入下一阶段的验收条件：

- 产品导航、设置、错误状态、恢复提示完成。
- Acrylic/Mica 在支持环境下可用，并有可靠降级。
- Command Card 基础动效不影响大量历史性能。
- 完成无障碍、对比度、高 DPI、多屏和缩放测试。
- 完成 Beta 崩溃、升级、数据库迁移和安全反馈闭环。
- 清理用户可见的 Wave 品牌与无关产品入口，同时保留许可要求。

---

## 阶段 9：正式产品发布

唯一核心目标：证明产品不仅能运行，而且能被持续发布、支持和商业运营。

为什么必须现在做：正式发布需要的是运营闭环，而不只是功能完成。

完成后证明：

- 有稳定的构建、签名、升级、回滚和支持机制。
- 许可证、隐私、数据删除和第三方组件责任明确。
- 产品具备正式商业交付能力。

进入正式发布的验收条件：

- 发布构建可复现。
- 安装器、签名、自动更新和回滚通过验证。
- Apache-2.0、NOTICE、第三方许可证和品牌边界完成审查。
- 本地历史、诊断数据和可选 telemetry 有清晰隐私说明。
- 安全审查和依赖漏洞流程建立。
- Beta 阻断级问题关闭。
- 支持版本、升级策略和故障恢复文档明确。

# 当前下一步是否应该做实现落点设计

应该，但要控制范围。

当前不是继续做广泛源码调研，也不是设计完整数据库和漂亮 UI。阶段 0 应只冻结以下内容：

- 领域所有权。
- Wave 接入点。
- 事件顺序。
- 输出捕获点。
- Adapter 边界。
- 最小上游修改面。
- 阶段 1 的 Go/No-Go 条件。

阶段 0 结束后必须立即进入可行性 Spike。不能因为“架构还可以再完善”而推迟真实验证。

需要提前设定三条路线否决条件：

1. C/D 无法在 PowerShell 7 中达到稳定、可恢复的生命周期语义。
2. 输出无法在保持 xterm.js 原行为的同时稳定建立边界。
3. 实现输出 tap 和生命周期接入必须大范围重写 Wave Controller、PTY 或 Block 模型。

第一项失败可先尝试“侧信道生命周期 + PTY marker”。第二或第三项持续失败，才应重新比较 Windows Terminal Core，而不是继续扩大 Fork。

# 第一个垂直切片

当前候选的方向正确，既不过大，也不过小，但只执行一次 `git status` 太弱。

建议改成“两条连续命令、一个最小闭环”：

```text
同一个 PowerShell Session
        ↓
执行一条普通成功命令
        ↓
C → CommandRecord running
        ↓
输出同时进入 xterm.js 和 Output Store
        ↓
D → success / exit code / duration
        ↓
生成基础 Command Card
        ↓
执行一条受控失败命令
        ↓
形成第二张失败 Card
        ↓
验证两条输出没有串线
        ↓
验证 Copy Command / Output / All
        ↓
验证下一 prompt、cwd 和 Session 仍然正常
```

必须加入的验证点：

- 两条命令连续执行，证明边界不会串线。
- 一次成功、一次失败，证明状态不是写死的。
- Copy Output 排除 prompt、命令回显、OSC 和下一提示符。
- 输出先实时显示在 xterm.js，Card 只在完成后产生。
- 使用独立输出范围，不依赖 Wave 循环 term 文件永久有效。
- Card 生成后仍是同一个 PowerShell 进程和 cwd。

第一切片明确不包含：

- 持久化恢复。
- Clear。
- vim/ssh/REPL。
- 后台输出。
- 精致 UI。
- 动画、Mica、Liquid Glass。
- 完整设置系统。

这些不是第一切片的成立条件。

# 各阶段必须消灭的风险

| 风险 | 最晚解决阶段 | 必须得到的结果 |
|---|---:|---|
| PowerShell OSC C/D 是否可靠 | 阶段 1 | 可靠，或切换到侧信道混合方案 |
| 输出起止边界 | 阶段 1 初证、阶段 3冻结 | 具有稳定序列范围，不依赖 UI 行号 |
| xterm.js 与 Command Card 共存 | 阶段 2 | xterm 管活动态，Card 管完成态 |
| 成功/失败和 PowerShell exit 语义 | 阶段 2 | `$LASTEXITCODE`、`$?`、success 含义固定 |
| Ctrl+C、shell crash、integration lost | 阶段 3 | 不产生错误成功或永久 running |
| 后台输出交错 | 阶段 3 | 能识别 mixed/unattributed，不错误归属 |
| OSC 注入和乱序 | 阶段 3 | 有身份、版本、顺序和状态校验 |
| vim/ssh/fzf/REPL/nested pwsh | 阶段 4 | 保持完整交互兼容 |
| TerminalRuntimeAdapter 是否足够隔离 | 阶段 4 | 接口冻结，领域层不依赖 Wave 内部类型 |
| Command Journal 持久化 | 阶段 5 | 可恢复、可迁移、输出不会因循环文件失效 |
| Clear 不破坏 Session | 阶段 5 | 仅清视觉历史，PTY和 PowerShell 不变 |
| 环境和历史敏感数据 | 阶段 5 | 最小采集、可删除、可配置保留 |
| Wave upstream merge 成本 | 阶段 2 初测，最晚阶段 6形成机制 | 冲突集中且可持续升级 |
| Windows 打包和升级 | 阶段 7 | 干净系统可安装、升级、卸载和迁移 |
| 大量 Card 和长输出性能 | 阶段 7 | 虚拟化、按需加载并达到性能预算 |
| Electron 发布安全 | 阶段 8 | 依赖、IPC、内容策略、更新链完成审查 |
| 正式商业许可和隐私 | 阶段 9 | 许可证、NOTICE、隐私和发布责任清晰 |

最重要的风险截止线是：

```text
阶段 1 之前不投入产品功能
阶段 3 之前不冻结数据库
阶段 4 之前不做产品级 UI
阶段 7 之前不投入高级视觉
```

# MVP 边界

## 主干必须完成

不完成就不能称为可靠 MVP：

- Windows 11 / PowerShell 7 稳定运行。
- 普通命令一条一个 CommandRecord。
- 命令、输出、exit code、成功失败、执行时间。
- Copy Command、Copy Output、Copy All。
- 输出边界不串线。
- Ctrl+C、shell crash、integration lost 的安全状态。
- vim、ssh、fzf、REPL、nested pwsh 可以正常工作。
- nested pwsh 和 SSH 在 MVP 中允许作为一条外层交互记录。
- Command Journal 持久化和迁移。
- Clear Visual History 不杀 Session。
- cwd、env、venv 由同一 PowerShell Session 保持。
- 大量 Card 虚拟化和长输出按需加载。
- Windows 安装、升级、卸载。
- 基础安全、隐私和历史删除。
- Wave upstream 合并机制。
- 基础可用 UI和键盘体验。

## MVP 后再做

重要，但不能阻塞核心产品成立：

- SSH 远端每条命令结构化。
- nested pwsh 内层命令结构化。
- 后台 Job 输出的完美逐任务归属。
- PowerShell 以外的完整 Shell 支持。
- 多窗口、Workspace、跨设备同步。
- 高级历史搜索、标签和收藏。
- 大规模删除 Wave 内部功能。
- 用 Windows Terminal Core 替换 Runtime。
- 高级插件系统。

## 可选增强

- 高级 Liquid Glass shader。
- 复杂 Command Card 过渡动画。
- AI 命令解释和摘要。
- 协作与分享。
- 云历史同步。
- 自定义视觉主题市场。
- GPU 特效和环境响应动画。

# 架构冻结点

架构不应一次性冻结，而应在风险被验证后分层冻结。

| 核心边界 | 冻结阶段 | 冻结内容 |
|---|---:|---|
| PowerShell Integration | 阶段 3 | C/D 协议、事件身份、exit 语义、异常状态 |
| Command Journal 生命周期 | 阶段 3 | CommandRecord 状态机和领域事件 |
| TerminalRuntimeAdapter | 阶段 4 | 输入、输出、resize、resync、session、状态接口 |
| Output Store | 阶段 5 | 序列、范围、blob、截断、恢复和迁移 |
| Command Journal 持久化 | 阶段 5 | schema、版本、迁移和数据所有权 |
| Command Card 数据契约 | 阶段 5 | Card 能读取的稳定 projection |
| Command Card 交互契约 | 阶段 7 | 复制、选择、折叠、焦点和虚拟化 |
| 视觉系统 | 阶段 8 | 设计 token、材质、降级和动效规则 |

阶段 5 结束后，可以认为核心架构已经冻结。

之后允许：

- 增加版本字段。
- 通过迁移扩展 schema。
- 增加 Adapter 能力。
- 增加新的 Card projection。

之后不允许随意：

- 改写 CommandRecord 身份语义。
- 让 Card 直接依赖 Wave 内部对象。
- 让 Wave Block 取代 CommandRecord。
- 用 UI buffer 作为历史数据源。
- 绕过 Adapter 调用 Wave Runtime。

任何涉及这些边界的变更都必须使用 ADR 和版本迁移，而不是普通重构。

# UI 进入时机

## 阶段 2：基础 UI

只做能够验证架构的 Command Card：

- 命令。
- 输出。
- 状态。
- 时间。
- 三种 Copy。
- 基础折叠。

允许难看，但必须真实使用最终数据流。

## 阶段 7：产品基础 UI

此时开始：

- 正式布局。
- Command Card 信息层级。
- 焦点与键盘交互。
- 大量历史虚拟化。
- 选择、滚动和长输出。
- 基础设计系统。
- Light/Dark 和高 DPI。

## 阶段 8：Acrylic / Mica

只有在以下条件成立后开始：

- xterm 与 Card 共存已经冻结。
- 滚动和内存预算通过。
- Windows 打包可运行。
- 基础可访问性完成。

Mica/Acrylic 必须有不透明背景降级方案。

## 阶段 8：Command Card 动效

可以加入轻量动效：

- Card 完成。
- 成功/失败状态切换。
- 折叠展开。
- 历史清除。

动效必须能禁用，并通过大量 Card 性能测试。

## Beta 后或接近正式版：高级 Liquid Glass / shader

高级 shader 属于可选视觉层。它不能成为：

- xterm 渲染依赖。
- Card 数据结构的一部分。
- Window 生命周期的一部分。
- 输入延迟和滚动性能的阻断条件。

绝对不能提前做的视觉工作：

- 自定义 shader。
- 大范围模糊和实时折射。
- 复杂标题栏重构。
- 高成本 Card 动画。
- 因视觉需要改写 xterm 渲染。
- 为了品牌化提前删除 Wave 功能和组件。

# Wave Fork / Upstream 策略

阶段 0 至阶段 5，只允许：

- 新增产品模块。
- 增加最小 adapter/hook。
- 通过 feature flag 隐藏 Wave 功能。
- 使用产品路由和配置替换入口。
- 对 PowerShell Integration 做隔离修改。

阶段 6 可以开始产品化裁剪，但应优先：

- 构建时排除。
- 路由关闭。
- feature flag。
- 菜单隐藏。
- 延迟加载移除。

不要直接删除大量上游代码。真正物理删除应等 Beta 后，并且只删除已确认不会影响 Runtime、升级和许可的产品表层。

最好长期不重写的 Wave 核心包括：

- PTY 创建和读写机制。
- ShellController 的进程生命周期。
- Block file / terminal stream。
- Controller 注册和 resync。
- RPC transport。
- xterm.js 终端解析和渲染。
- Wave Block 的基础持久化语义。

允许在这些位置增加极小、稳定的 hook，但不应把 Command Journal 逻辑写进去。

控制 downstream 距离的规则：

- 产品代码优先放入新目录。
- 上游文件只保留 adapter 调用和事件 hook。
- 禁止无关格式化。
- 保存明确的 upstream remote。
- 定期做 upstream 合并演练。
- 对上游修改维护可审计清单。
- 每次 Wave 升级运行完整终端兼容测试。
- 如果每次合并都同时冲突于 PTY、ShellController、Block 模型和 TermWrap，说明隔离边界已经失败，应暂停产品功能并修复架构。

# 从现在到正式发布的一张主干图

```text
0. 实现落点设计
   明确 Wave 接缝、Adapter、事件流和最小修改面
        ↓
1. PowerShell Lifecycle / Output Feasibility Gate
   验证 C/D、exit 语义、输出边界和路线可行性
        ↓
   Go / No-Go
        ↓
2. 第一条产品垂直切片
   两条连续命令 → Record → Output → Card → Copy
        ↓
3. 生命周期正确性与异常恢复
   Ctrl+C / crash / integration lost / 后台交错 / OSC 安全
        ↓
4. 交互式兼容闸门
   vim / ssh / fzf / REPL / nested pwsh
        ↓
5. 持久化、Clear 与数据安全
   Journal / Output Store / migration / privacy
        ↓
   核心架构冻结
        ↓
6. Fork 隔离与 Upstream 可维护性
   合并演练、patch 收敛、Runtime 边界验证
        ↓
7. Windows 分发、性能与基础产品 UI
   安装升级、虚拟化、长输出、可用性
        ↓
   可发布 MVP
        ↓
8. Beta 产品化
   Mica/Acrylic、轻量动效、可访问性、真实用户验证
        ↓
   Beta
        ↓
9. 发布与商业化闸门
   签名、更新、回滚、许可、隐私、安全、支持
        ↓
   正式产品
```

这条主干最关键的决策是：在阶段 1 就验证 B2+ 的生死假设，在阶段 4 之前消灭兼容性风险，在阶段 5 冻结领域与存储，最后才投入高成本视觉。这样即使路线存在根本问题，也会在最便宜的阶段暴露。