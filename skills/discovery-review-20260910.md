# 创作 Skill 候选审核 · 2026-09-10

目标：为 Clash 的六类创作 Task 补充可组合的方法。候选尚未作为新的
Official Picks 上架，也未自动安装到全局。已有 per-Task pack 挂载保持有效。

发现路径：skills.sh 榜单、`skills find cinematography`、
`skills find character consistency`、`skills find sound design`，然后读取
GitHub 源码。Star 属于整个仓库，安装量属于目录条目，都不代表创作效果。
以下数字为本日查询快照；CLI 与网页的缓存可能不同。

## 优先候选

| 上游条目 | 热度与来源 | 读后判断 | Clash 适配方向 |
| --- | --- | --- | --- |
| [cinematography](https://github.com/fal-ai-community/skills/blob/9ca850412943251fc9a466c4c29fdaf7a303a3d8/skills/cinematography/SKILL.md) | fal-ai-community；仓库 237★；约 700 次安装 | 有具体景别、机位、运动、灯光、材质与色彩词汇；正文和三个 references 已读。执行依赖 genmedia、model-routing，并硬编码模型优先级 | 拆成“镜头设计”“灯光与材质可读性”，接 Clash 实际能力；焦段写法作为设计意图，不冒充从图中测得的参数 |
| [character-design](https://github.com/fal-ai-community/skills/blob/9ca850412943251fc9a466c4c29fdaf7a303a3d8/skills/character-design/SKILL.md) | 同仓库 237★；283 次安装 | 固定身份特征与当前镜头变量分开；正文和 anchor、prompt、example 三份参考已读。含三视图、表情与换装模板 | 补进已有 `clash-multiview-consistency`、`clash-reference-composition`；不再建重复的三视图入口。需要保留参考图真实传入与失败处理 |
| [storytelling](https://github.com/fal-ai-community/skills/blob/9ca850412943251fc9a466c4c29fdaf7a303a3d8/skills/storytelling/SKILL.md) | 同仓库 237★；270 次安装 | 按叙事作用组织镜头、记录参考和衔接；正文和三份参考已读。固定 hook/setup/turn 结构偏广告，不能强加给所有片段 | 只抽“镜头覆盖与剪辑衔接”方法，复用现有叙事、广告编排；生成结果进入真实 Timeline |
| [sound-design-film](https://github.com/guia-matthieu/clawfu-skills/blob/a69bf676d7fbc532f898f092e6326871052e414a/skills/audio/sound-design-film/SKILL.md) | Guia / ClawFu；仓库 149★；CLI 显示 447 次安装 | 正文已读。声音提示点、空间透视、声音先入/后出有用；包本身只提供设计说明。固定优先级、层数、“50% 情绪影响”等缺乏足够依据，名人引语与归因未独立核实 | 拆“声音提示点设计”“声场与声音衔接”；去掉固定层数/响度/未核实引语，用实听和实际平台要求验收；不能把提示表称为已混音 |
| [remotion-best-practices](https://github.com/remotion-dev/skills/blob/9ae8048a84690098b1059f7f5d30e6d05833b824/skills/remotion-best-practices/SKILL.md) | Remotion 官方；仓库 4,532★；目录约 518.1K 安装 | 已读路由入口、markup 入口与 timing。适合帧驱动动效；上游当前为 4.0.523，Clash 锁定 4.0.507；含新建项目、独立 Studio、包安装等分支 | 按实际运行版本选用 timing/sequencing 等规则，挂在品牌动效/MV/图形解释 Task 的执行能力层；不整包覆盖 Clash 渲染流程 |

热度核对：[摄影目录](https://www.skills.sh/fal-ai-community/skills/cinematography)、
[角色目录](https://www.skills.sh/fal-ai-community/skills/character-design)、
[叙事目录](https://www.skills.sh/fal-ai-community/skills/storytelling)、
[Remotion 目录](https://www.skills.sh/remotion-dev/skills/remotion-best-practices)。
声音安装量来自本日 Skills CLI，仓库元数据通过 GitHub API 核对。

## 保留观察与未选项

- [scene-asset](https://github.com/62656456/ai-film-skills/blob/678edc06d3318c1516f6eb73503f740427fdd831/skills/scene-asset/SKILL.md)：
  源于 Open Film Skills，仓库仅 14★，不称为高赞精选。正文和两份参考已读。
  门窗、出入口、地标、光源及状态变化的空间约束值得试验；强制人审、固定编号、
  必填字段和旧多段式模板需要改。候选原子是“场景地理与反打一致性”，与主体三视图不同。
- [jeurtr/seedance-skill](https://github.com/jeurtr/seedance-skill/blob/9b12d582d6a18702edf399f3e4440d948e479d82/SKILL.md)：
  仓库 2★，正文已读。混合多平台限制、默认能力和固定用量经验，缺少逐项一手依据；
  同时包含固定重试次数与路由建议。本轮不收录，参考角色分工已经由现有 Clash 原子覆盖。
- `storyboard-manager` 搜索热度约 1.4K，但内容主要处理小说人物、章节和时间线；
  没有将安装量当作电影分镜能力的证据，本轮不推荐。
- `canvas-design` 仍不在本轮范围。封面、信息图、漫画继续使用前次已审核的 Clash 适配。

## 来源与分发边界

- fal-ai-community 当前 README 声明 MIT，但本次检出的根目录没有独立 LICENSE 文件，
  GitHub API 的 license 也为空。候选链接与审核可保留；正式复制发布前要把具体适用许可、
  作者说明与 NOTICE 补齐，不能借其他子目录的 LICENSE 冒充。
- ClawFu 的根 LICENSE 为 MIT、Copyright 2026 Guia。正文前后还有 ClawFu / MKTG Skills
  的作者字段差异；适配时同时记录直接来源和原文署名，不把 Walter Murch 写成 Skill 作者。
- Remotion skills 快照没有独立 LICENSE，package.json 指回 remotion 主仓库。
  此处仅推荐核对版本后使用其官方规则；本轮没有把源码复制成 Clash 自有发布物。
- Open Film Skills 根许可为 Apache-2.0。低热度和缺少 Clash 实测仍是候选限制，
  许可明确不等于效果通过。

## 与 Task pack 的组合建议

以下是候选适配后的挂载计划，不是已经完成的新安装：

| 可复用方法 | 使用它的 Task |
| --- | --- |
| 镜头设计 | 广告、叙事、MV；其他品类按任务需要 |
| 灯光与材质可读性 | 产品广告、角色/场景参考、叙事 |
| 镜头覆盖与衔接 | 叙事、访谈、产品演示 |
| 声音提示点与声场衔接 | 有声叙事、广告、访谈、MV |
| 场景地理与反打一致性 | 多镜头同场景；单图不默认加载 |
| 帧驱动动效规则 | 使用 Remotion 的品牌动效、MV、图形解释 |

每个方法只读当前任务需要的材料。身份/场景基准复用已有 Project Asset 与精确版本；
生成、Timeline 和交付验收使用 Clash 正式流程。技能内容审核、挂载验证、真实 Agent
行为和媒体效果各自留证，见[实测记录](../docs/creative-category-e2e-status.md)。
