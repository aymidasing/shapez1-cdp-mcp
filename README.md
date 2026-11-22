# shapez 1 游玩 MCP

本地 stdio 服务连接 Steam shapez 1.5.6 的调试端口。项目配置入口为 `dist/server.mjs`，默认允许写入。玩家在游戏里打开目标档，agent 通过 `status` 核对名称与内部 ID，再用 `game select` 绑定当前世界。切档、重新加载和重连后需要重新绑定。服务依赖本机 Node.js 22+、已安装的游戏和监听在 `127.0.0.1:9222` 的调试端口。若尚未启用，在 Steam 游戏启动选项加入 `--remote-debugging-port=9222` 并重新启动游戏。

在 Codex 中打开本项目，使用项目自带的 [shapez1-play skill](.agents/skills/shapez1-play/SKILL.md)。完整的[建筑、端口、电路和满带配比](.agents/skills/shapez1-play/references/buildings.md)随项目提供。其他 MCP 客户端可用 `node` 启动本目录下 `dist/server.mjs` 的绝对路径，并将该 skill 目录加入客户端的技能发现路径。要仅观察游戏，可设置 `SHAPEZ_MODE=observe`。

## 一段实际游玩流程

| 工具 | 参数 | 效果 |
| --- | --- | --- |
| status | `{}` | 当前存档名、internalId、世界规模、活动图层、写入绑定状态 |
| game | `{"op":"select","id":"从 status 读取"}` | 绑定该存档 |
| map_region | `{"region":[-8,0,8,8]}` | 区域实体和逐格资源，或加 `format:"image"` 查看 PNG |
| game | `{"op":"route","route":[[-8,3],[-2,3],[-2,0]]}` | 覆盖直段并按进出方向铺出折角 |
| game | `{"op":"layer","layer":"wires"}` | 通过 E 键对应的游戏处理器切到电路视角 |
| game | `{"op":"wire","route":[[1,2],[6,2]],"color":"second"}` | 铺电线并检查沿线意外接网 |
| game | `{"op":"building","at":[3,2],"layer":"wires"}` | 查询信号、网络编号及冲突 |
| game | `{"op":"blueprint","region":[0,0,8,8]}` | 缓存所选建筑并返回短句柄和单次粘贴费用 |
| game | `{"op":"blueprint","blueprintMode":"paste","handle":"返回的句柄","targets":[[12,0],[24,0]]}` | 按玩家蓝图规则连续复制两份 |

排查停产时用 `game {"op":"trace","at":[-4,32]}`，从出料端沿物料端口反查。批量验线用 `game {"op":"check_signals","layer":"regular","reference":[-99,55],"tiles":[[-100,57],[-99,59]]}`。正常只返回检查数和失败数，查询原始网络值仍可用 `signals`。

同档重连会自动恢复只读查询。分页返回 `restarted:true` 时，从该页重新累计。写操作支持唯一 `requestId`，重连后先查原回执。已知部分成功的批建会列出首个失败格及其后跳过的数量。MCP 进程重启后，游标和服务端回执失效。

矩形右下角不包含在内。区域图每边最多 32 格，一次返回覆盖该矩形的全部实体；当前屏幕与 HUD 用 `screenshot`。较大范围可按块平铺，或用 `entities`、`resources` 的摘要和冻结分页。坐标推荐 `[x,y]`，兼容旧式坐标对象。批建回报完成数量及首个失败位置。预演直带的快照只记录该批格子的带布局，MCP 重启后失效。

## 构建、运行与验证

```powershell
npm ci
npm test
npm run verify:live
npm run verify:engine
```

已有依赖时直接运行 `npm test`。离线测试不访问游戏。两项实机检查需游戏调试端口已启动。`verify:live` 通过官方 stdio 客户端以只读模式验证当前存档、分页、区域图像和产能；`verify:engine` 在同版本引擎中创建独立的内存工厂，验证折弯连通、电线并网冲突、蓝图设置、扣费和拆除。修改后重新构建并重连 MCP，使客户端重新发现工具。旧设计稿中的固定存档、只读限制和待实现清单属于历史记录。
