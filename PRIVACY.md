# 上传前如何检查自己的信息

## 本次检查结论（2026-11-06）

检查开始时，GitHub `main` 有 63 个文件、9 个历史提交，历史中共有 87 份不同文件内容。当前文件与本地已审阅发布副本相比，仅 README 有使用者的措辞修改；这些修改已保留。

本次对当前文件和上述历史内容检查后，未发现已知真实姓名、个人邮箱、真实岗位/公司/地址样本、简历文件、数据库、私密设置、原始网页、导出表格或常见格式的密钥。测试中的岗位、公司、HR及正文是虚构占位内容。提交作者使用 GitHub noreply 地址；GitHub 自身的提交者地址属于 github.com。仓库所有者账号和 LICENSE 中的账号署名属于主动保留的公开署名。

**历史清理（2026-11-06）：使用者已明确授权移除旧评分提交。** GitHub main 重建为不含评分代码的初始提交与当前发布版，不保留指向旧评分提交的分支或标签；当前源码、README 修改及简介图保留，清理时仓库保持私有，2026-11-09 经使用者确认改为公开。这里清理的是分支/标签可达历史，不代表 GitHub 服务器中的旧对象或其他克隆已被物理删除。本说明不是“任何个人信息都不可能存在”的保证；仍需人工审阅新增文本、截图和测试样例。

## 重点检查的位置

| 位置 | 可能出现的内容 | 检查方法 |
|---|---|---|
| GitHub Code 文件树 | 简历、配置、数据库、JD、Excel、截图 | 对照 `release-files.txt`，不应出现个人数据目录或文件 |
| README、其他文档与测试代码 | 真名、个人优势、具体经历、实际公司/HR、真实 JD 样例 | 阅读每次新增或修改的文本，确认示例为虚构 |
| 图片和其他附件 | 截图中的姓名、头像、岗位、聊天、文件路径 | 打开图片逐一查看；只允许已审阅的通用介绍图 |
| Commits 和旧分支/标签 | 曾经提交、后来才删除的资料 | 在 GitHub 查看历史；本地检查每个拟上传的分支和标签 |
| Commit 作者和提交者 | Git 姓名、邮箱 | 使用 GitHub noreply 邮箱，检查仓库 Commits 页面 |
| Issues、Pull requests、评论与 Releases | 调试日志、截图、附件和下载包 | 单独检查，文件树扫描不会覆盖这些区域 |

本地的 `db/private-settings.json`、`db/private/`、`db/tracker.db`、`docs/samples/`、日志和导出文件可以留作自己使用，但不得添加到发布清单或强制提交。

## 每次上传前执行

在发布副本根目录执行：

```powershell
python tools/check_release_privacy.py --worktree
git status --short --ignored
git diff --name-only
git diff
```

脚本会阻止不在清单内的文件、常见密钥、手机号码、个人用户目录路径、需审阅的邮箱和未经审阅的二进制图片。报告只显示文件及问题类型，不回显匹配到的私密文本。检查真实姓名、特定公司或独有语句时，可以仅在本地额外传入：

```powershell
python tools/check_release_privacy.py --worktree --private-term "你的真实姓名" --private-term "需要排除的独有语句"
```

上面是占位文本，执行时自行替换；不要把真实关键词写进源码、配置清单、Issue 或截图。命令可能留在本机终端历史中，也不要上传终端历史。

添加待提交文件后，再检查**实际暂存区**：

```powershell
python tools/check_release_privacy.py --staged
git diff --cached --name-only
git diff --cached
```

默认运行 `python tools/check_release_privacy.py` 会检查当前 HEAD 的已提交文件。工作区、暂存区、HEAD 是三个不同状态，检查工作区不能替代检查即将上传的提交。

## 检查历史和署名

```powershell
git log --all --format="%h %an <%ae> | %cn <%ce>"
git log --all --name-status
git log --all -G "需要排除的独有语句" --oneline
git ls-files
```

这些命令只读取本地已有历史；不会自动检查未拉取的远程分支、其他克隆、GitHub 附件或服务器缓存。发现历史包含资料时，先保持仓库私有。不要仅删除当前文件就改为公开，历史重写或重新建立干净发布仓库应单独处理。

GitHub 网页可在 **Settings → Emails** 查找自己的 noreply 地址，本地发布副本可设置：

```powershell
git config --local user.name "你的GitHub账号"
git config --local user.email "你的GitHub noreply邮箱"
```

更换本地配置不会修改既有提交署名。

## 后续防止误上传的规则

- 发布只使用独立副本与 `release-files.txt` 白名单；不要整体复制个人工作区，也不要推送所有本地分支和标签。
- `.gitignore` 是第一层防护，但无法保护已跟踪文件；禁止用强制添加绕过私密文件的忽略规则。
- 新文件先人工审阅，再加入白名单；新增内容必须再次运行检查。文本文件被允许，不代表可以在里面填写真实资料。
- 图片仅允许 `assets/overview.png`，且必须匹配 `release-assets.json` 的 SHA-256。换图需要重新目视审阅并更新哈希。
- 本副本启用仓库级 Git 钩子：提交前检查暂存内容，推送前检查 HEAD。新克隆需执行 `git config --local core.hooksPath .githooks`。它只作用于本仓库，可用 `git config --local --unset core.hooksPath` 取消。
- 钩子可以被跳过，GitHub 网页和连接器也不会执行本机钩子，因此所有同步方式仍须先运行隐私检查，并核对实际上传清单。

本仓库约定已写入 [AGENTS.md](AGENTS.md)，后续协作继续遵守。自动检查不能识别所有自然语言中的真实经历、无格式密钥或图片文字，最终仍需人工审阅。
