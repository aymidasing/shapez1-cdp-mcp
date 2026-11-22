---
name: shapez1-play
description: 用 shapez1 MCP 游玩 Steam shapez 1，读取玩家选定工厂，规划满带产线、物流和电路，批量施工、复制蓝图并检查运行效果。
---

# 游玩 shapez 1

玩家在游戏窗口打开目标存档。调用 `status {}`，对照 `name`、`internalId`、`mode` 和关卡。要施工时，调用 `game {"op":"select","id":"刚核对的 internalId"}`。同一 MCP 进程重连时会核对存档 ID 并沿用此前的选择。切换到另一存档后重新核对并选择。玩家指定的档名与当前档不符时，让玩家打开目标档。观察模式可查图、速度和蓝图。

坐标用 tile 的 `[x,y]`，东为 x 增大，南为 y 增大。矩形 `[x0,y0,x1,y1]` 含左上角，右下角不含。`at` 表示一格，`tiles` 和 `targets` 表示多个点。先读 [建筑与产能](references/buildings.md) 决定配比和接线，精确到格的端口用 `game catalog` 加建筑 ID 查询。

## 读图和确定目标

| 工具或 game 操作 | 用法和结果 |
| --- | --- |
| `status` | 存档身份、绑定状态、关卡、能力、已加载区块和视口。相机的 `visibleTiles` 可用来选区。 |
| `game hub` / `speeds` | 查看目标图形短码、交付量或速率目标、升级、每游戏秒带速和机器速度。`fullBelt` 是按当前倍率算的一条带所需台数。 |
| `game catalog` | 精简数组列出建筑编号、变体、旋转变体、图层和可建标志。传 `id` 只返回该族，并给出原点为零时的物料入口、出口、信号脚。可传 `rotation:90` 等预览旋转后的端口。 |
| `map_region` | 如 `{"region":[12,-4,28,12],"layer":"both"}`。每边最多 32 格，返回区域相交的完整实体集，数组行为 `[原点x,原点y,code,rotation]`。建筑原点可能在框外。资源行 `[x,y,水平连续格数,keys下标]`。加 `"format":"image"` 看同一矩形的游戏蓝图贴图。电路层的 pins 行为 [x,y,朝外边,in/out]，显示常规层机器伸出的引脚；图上橙色箭头为输出，青色为输入。重叠时分别查 `regular` 和 `wires`。 |
| `game waypoints` / `view` | 路标行依次为标签、tile x、tile y、图层；`{"op":"view","at":[-132,109]}` 平移游戏相机，可结合电线视角截图核验。 |
| `game layer` | 空参读当前视角。绑定存档后传 `{"op":"layer","layer":"wires"}`，通过游戏的 E 键处理器切到电路视角；传 `regular` 切回。重复指定相同层保持当前视角。随后用 screenshot 查游戏实际画面，局部数据查询仍可独立指定层。 |
| `screenshot` | 当前屏幕及 HUD 的 PNG。窗口需能绘制帧。区域图可直接按 tile 取图。 |
| `entities` / `resources` | `{"mode":"summary","region":[0,0,32,32]}` 看分组。建筑按原点入选，资源按斑块中心入选。资源可传 `key:"color:red"` 或 `"shape:CuCuCuCu"`。用 `mode:"region"` 加区域取明细。冻结摘要的 `firstCursor`、后续的 `next` 交给同一工具的 `{"mode":"page","cursor":"…"}`。大厂优先用局部图，采矿前查 ground 确认矿格。 |
| `game building` / `path` | `{"op":"building","at":[3,4],"layer":"wires"}` 给实际占地、旋转后的端口、信号/冲突；在多格建筑任意占地可查。端口行是 `[x,y,朝外的边,类型?]`，带端口看 `belt=[入口边,出口边]`。`path` 在一段带上查首尾、长度和末端接收者。 |
| `game trace` | 从成品带或机器反查上游，例如 `{"op":"trace","at":[-4,32]}`。沿实际物料口、连续带和地下带查找，最多探查 2,048 个节点。返回一处故障及现场证据。若为 `inconclusive`，可根据 `waiting` 的坐标和缺料槽继续查；采样期间的吞吐用 `sample_flow`。 |
| `game check_signals` | 批量验线首选。例 `{"op":"check_signals","layer":"regular","reference":[-99,55],"tiles":[[-100,57],[-99,59]]}`。默认检查各点已接网且无冲突，可加同网参考点或 `network`、预期 `value`、零起算的 `pin` 和 `referencePin`。合格只回 `checked/failed`，异常才列坐标。网络 ID 可能重建，跨次检查宜用参考点。 |
| `game signals` | 传 `tiles` 和 `layer` 批查电线或建筑引脚。每行是 x、y、建筑编号和各脚的 `[网络ID,信号值,冲突标志]`，空网返回 null。 |
| `game flow` / `sample_flow` | `flow` 传区域看带上现有货物。`sample_flow {"region":[0,0,8,8],"points":[[3,3]],"seconds":5,"samples":3}` 连续取样。货物数量是瞬时在带量。交付速率是整个 Hub 的指标，速率关使用游戏报告的速率。验证某一支线时配合读带器、路线端点和上下游。 |

## 施工

下列 JSON 均传给 `game`。每次调用查看 `placed/removed/copies` 及 `reason/stoppedAt`。部分完成时，从现场查询确定剩余工作。游戏建造规则、当前模式和解锁进度均生效。

| 操作 | 参数例 | 行为 |
| --- | --- | --- |
| 批建 | `{"op":"place","items":[{"at":[2,3],"building":"miner","variant":"chainable","rotation":90},{"at":[8,3],"code":20}]}` | 编号已含变体；旋转角为 0/90/180/270，顺时针。加 `emptyOnly:true` 可保护已占用的格子。按输入顺序放置，遇阻报告位置和完成数。 |
| 拉带 | `{"op":"route","route":[[0,0],[5,0],[5,-3]]}` | 点序就是货流。从第一格到最后一格都铺，直段同向覆盖旧带。拐点由相邻两段的进出方向合成原生弯带。此例从西边进拐点、往北出。单次一条正交路径，至多 512 格，禁止对角、重复点和回头覆盖自身。需要一格直带用 `place` 加 `direction:"E"`。 |
| 拉线 | `{"op":"wire","color":"second","route":[[8,0],[8,5],[12,5]]}` | `first` 或 `second`。电线双向；路径端点对准电路脚朝外的相邻格。默认拒绝沿途碰到同色线、非预期引脚、隧道和两端均为输出的接法。计划内并网加 `"join":true`；可复用同色格，异色占同一格仍会被拒绝。跨线用电线隧道。放好后查 `building.network` 看网络 ID、值和 `conflict`。 |
| 配置 | `{"op":"configure","at":[2,4],"layer":"wires","value":"red"}` | 常量信号可设置颜色、图形短码或布尔值。拉杆在 regular 层，以 `"true"` / `"false"` 设置开关。 |
| 拆除 | `{"op":"remove","region":[0,0,8,4],"layer":"wires"}` 或 `{"op":"remove","tiles":[[1,2],[3,4]]}` | 默认为 regular；每个相交建筑整体拆除一次。返回成功数和游戏保护的建筑数。 |
| 复制和蓝图 | `{"op":"blueprint","region":[2,4,8,10],"layer":"regular"}`，再 `{"op":"blueprint","blueprintMode":"paste","handle":"返回值","targets":[[20,4],[32,4]]}` | 目标点对应选框左上角。可加顺时针 `rotation` 绕该点旋转。使用游戏蓝图克隆、价格和余额，每个目标成功后扣费。选区可含部分相交的多格建筑，整个实体随蓝图复制。每个目标先检查全部占地，后面的目标失败保留前面已完成的副本。两层分开捕获。 |
| 跨会话蓝图 | 捕获时加 `"portable":true`，保存返回的 `items`。粘贴时将该数组放入 `blueprint`，用 `at` 或 `targets` 指定目标。 | 可携带结构、朝向、常量和开关设置。短句柄适合本次会话，保留最近 16 份。单次捕获最多 64×64 格，粘贴最多 64 处、共 4096 个实体。 |
| 保存 | `{"op":"save"}` | 绑定后调用玩家菜单的保存功能，返回 requested 或 in_progress。该回执表示游戏已接管存盘请求。 |
| 升级 | `{"op":"upgrade","id":"belt"}` | 按游戏价格购买一级。可用 ID 和当前级别看 `hub.upgrades`。 |

小范围改直带还可用 `preview_belts` 传 `region` 和最多 8 个 `{"op":"place_straight","tile":[x,y],"to":"E"}`（换已有直带用 `replace_straight`）。60 秒内用 `apply_belts` 提交 `plan` 和唯一 `requestId`。`operation_status` 以原键查回执，`restore_snapshot` 传 `snapshot`、`applyRequestId` 和新的 `requestId` 恢复布局。快照、计划、回执在服务内存中；恢复前会检查存档会话和目标格。

批建、拉带、接线或粘贴蓝图时可带唯一 `requestId`，如 `batch-mam-000001`。同一 MCP 进程内，同键同参数返回原结果，同键不同参数返回 `CONFLICT`。批建按顺序遇阻即停，`stoppedAt` 是失败格，`skipped` 是后续尚未执行的数量。丢失写入回包后，MCP 自动查询原回执。若得到 `OUTCOME_UNKNOWN`，用错误中的键调 `operation_status`，仍是 `unknown` 时核对现场。

同档只读查询遇到短暂断线可自动重试一次。冻结分页因重连失效时，服务用原区域、筛选和页大小重新获取第一页。`restarted:true` 表示需要丢弃此前已累计的行，从新页重新统计。切档返回 `SAVE_ID_MISMATCH`。MCP 进程重启后需要重新选择存档并从首页查询。

