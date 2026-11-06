# 设计

## 领域定义

- **沟通成功事件**：职位页出现可见的“已向BOSS发送消息”弹窗，且同一弹窗内同时存在留页选项和“继续沟通”。该证据表示平台已经建立沟通，也是本项目认定投递开始的确定证据。
- **岗位快照**：沟通成功事件发生时，从当前职位详情区域取得的结构化字段。它表示当时页面展示的内容，后续页面变化不回写历史快照。
- **投递**：从平台建立沟通并标记“已沟通”开始；附件简历、HR筛选、业务筛选、审核和面试是同一次投递的后续动作或阶段。

## 浏览器端流程

投递页继续由 `stay_on_page.js` 监听成功弹窗。发现满足条件的新弹窗后按以下顺序执行：

1. 为当前弹窗生成一次性事件 ID，并锁定该弹窗，防止 MutationObserver 重复触发。
2. 调用独立的岗位提取模块，从当前详情区域构建岗位快照。
3. 点击留页选项，记录点击是否成功。
4. 通过扩展后台将沟通事件和岗位快照提交给本地服务。
5. 写入失败时将完整结构化请求放入 `chrome.storage.local` 待写队列；后续重试沿用相同事件 ID。

提取发生在点击留页之前，因为弹窗关闭或页面重绘后，职位详情 DOM 可能改变。保存失败不阻止留页点击，避免改变用户当前操作结果。

## 提取字段

### 岗位基础字段

- `job_key`：优先取职位详情链接，其次取沟通按钮的 `ka` 或跳转属性。
- `title`、`company_name`、`city`、`address`、`experience`、`education`。
- `url`：移除查询参数后的稳定职位详情地址。
- `jd_text`：跳过 `display:none`、`visibility:hidden`、`font-size:0`、`style`、`script` 和 `noscript` 节点后的可见文字。
- `job_tags`：页面独立展示的职位标签；工作经验和学历从标签中拆出后不重复写入。

### 公司字段

- `company_size`、`industry`、`financing_stage`。
- 新版页面没有公司信息区域时允许为空；公司名称可以从“公司 · HR职位”回退取得。

### 薪资字段

- `salary_raw`：页面可读原文，例如 `10-14K` 或 `20-35K·16薪`。
- `salary_min_k`、`salary_max_k`、`salary_months`：只从可读原文解析；页面未写发薪月数时保持空值。
- `salary_capture_status`：`readable`、`font_decoded`、`font_obfuscated` 或 `missing`。
- `salary_dom_raw`：薪资节点过滤隐藏内容并清理外围空白后的 DOM 原始字符；字体混淆时保留私用区字符。
- `salary_codepoints`：按字符顺序保存完整 Unicode 码点，包含私用区数字、分隔符和单位；服务端根据 `salary_dom_raw` 重建，不信任客户端传入值。
- `salary_font_family`：采集时薪资节点的计算字体名称；无法读取时为空。
- `salary_decode_method`：成功使用 `U+E031–U+E03A` 码点偏移解码时保存 `pua_codepoint_minus_e031`。
- `U+E031–U+E03A` 按“码点减 `0xE031`”转换为数字；解码后再解析薪资上下限和发薪月数，同时保留全部原始证据。
- 出现范围外的私用区字符时标记为 `font_obfuscated`，不生成薪资上下限。

### HR 与事件字段

- HR：`name`、`title`、`activity_text`、`activity_captured_at`。
- 事件：`event_id`、`captured_at`、`success_dialog_text`、`stay_button_text`、`stay_button_clicked`、`source`、`capture_status`、`missing_fields` 和 `warnings`。
- 如果能从当前页面稳定确认用户点击的按钮，保存 `action_label`；无法确认时保持为空，不推断按钮文案。

## 必填与降级

`job_key`、`title` 和 `jd_text` 是形成规范岗位记录的最低条件。公司附加信息、详细地址、岗位标签、HR 和薪资均为可选字段，页面没有展示时不阻止保存。

缺少最低条件时仍保存一条失败的沟通事件，写明 `capture_status=failed` 和缺失字段，但不创建不可靠的岗位主记录。这样既能追踪沟通已经发生，也不会把错误页面内容写进岗位表。

## 服务与数据模型

新增 `POST /api/contact-snapshots`：

- 按 `event_id` 幂等，重复提交返回原记录，不重复新增。
- 校验事件证据、时间和岗位字段。
- 按 `job_key` 更新岗位当前值；原始请求写入 `raw_observation`，保留当时快照。
- 更新或创建 HR 快照，活跃度必须同时保存采集时间。
- 新增 `contact_event` 表保存事件证据、留页结果、采集状态及关联的岗位和 HR。
- 若当前岗位存在未关闭的申请记录，将平台阶段推进到“已沟通”；没有记录时创建第一次投递记录。投递时间取沟通成功时间。

`job` 表新增：

- `address`
- `experience`
- `education`
- `financing_stage`
- `job_tags_json`
- `salary_capture_status`

`contact_event` 表包含：

- `event_id` 唯一键
- `job_id`、`hr_id`
- `action_label`、`success_dialog_text`
- `contacted_at`
- `stay_button_text`、`stay_button_clicked`
- `capture_status`、`missing_fields_json`、`warnings_json`
- `snapshot_json`，保留该事件发生时的完整结构化快照
- `source`、`created_at`

## 查询与可验证性

新增 `GET /api/contact-snapshots?limit=N`，按沟通时间倒序返回岗位、HR 和事件摘要。它用于人工验收和后续界面接入；本轮不要求新增复杂统计页面。

## 隐私与数据边界

只保存扩展已经提取的结构化字段。待写队列和服务端均不保存完整网页 HTML、聊天正文、头像或地图图片。JD 是岗位公开描述，按沟通发生时的可见文字保存。

## 参考方案比较

开源 BOSS 工具通常提取岗位、公司、地点、薪资、JD、HR 和活跃度；部分工具通过固定映射、字体文件或登录态接口处理薪资字体混淆。平台映射可能随部署或会话变化，因此当前方案先保留 DOM 原文、码点和计算字体，不加入固定映射解码或自动投递。
