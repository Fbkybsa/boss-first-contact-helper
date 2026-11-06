-- BOSS直聘投递追踪 - SQLite 建表脚本（幂等，可重复执行）
PRAGMA foreign_keys = ON;

-- 职位维表（同一职位多行去重靠 job_key）
CREATE TABLE IF NOT EXISTS job (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key       TEXT NOT NULL UNIQUE,        -- 平台职位标识；缺失时用指纹 fp:xxxx
  title         TEXT,
  company_name  TEXT,
  company_size  TEXT,
  industry      TEXT,
  financing_stage TEXT,
  city          TEXT,
  address       TEXT,
  experience    TEXT,
  education     TEXT,
  job_tags_json TEXT,
  salary_raw    TEXT,                        -- 薪酬原文，如 "20-35K·16薪"
  salary_min_k  REAL,                        -- 折算为千元/月，解析失败为空
  salary_max_k  REAL,
  salary_months INTEGER,                     -- 发薪月数，如 16
  salary_capture_status TEXT,                -- readable / font_obfuscated / missing
  url           TEXT,
  jd_text       TEXT,                        -- 当前采集到的完整职位描述
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- HR 维表
CREATE TABLE IF NOT EXISTS hr (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  hr_key               TEXT NOT NULL UNIQUE,
  name                 TEXT,
  title                TEXT,
  activity_raw         TEXT,                 -- 原始表述，如 "今日活跃"
  activity_captured_at TEXT,                 -- 活跃度的采集时刻（非实时状态）
  last_seen_at         TEXT NOT NULL
);

-- 一次投递一条主记录；同一职位再次投递记为新的 attempt
CREATE TABLE IF NOT EXISTS application (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER NOT NULL REFERENCES job(id),
  hr_id               INTEGER REFERENCES hr(id),
  attempt             INTEGER NOT NULL DEFAULT 1,
  stage               TEXT NOT NULL DEFAULT '已沟通',  -- 招聘阶段
  viewed              TEXT NOT NULL DEFAULT '未知',    -- 简历查看情况
  ever_applied        INTEGER NOT NULL DEFAULT 1,      -- 已形成投递记录；兼容旧库保留
  ever_interview      INTEGER NOT NULL DEFAULT 0,      -- 曾到达"约面试"及以上（统计用）
  applied_at          TEXT,                             -- 投递起点（首次建立沟通）
  applied_at_source   TEXT,                             -- 页面 / 人工
  applied_at_precision TEXT,                            -- 日期 / 分钟 / 秒
  resume_exchange_at  TEXT,                             -- 简历附件交换时间，仅作投递时间候选
  last_change_at      TEXT,                             -- 最近一次状态(阶段/查看)变化时间
  last_message_at     TEXT,                             -- 最近一次我方消息时间（观测值）
  last_reply_at       TEXT,                             -- 最近一次HR回复时间（观测值）
  reply_latency_hours REAL,                             -- 最近可观测回复耗时
  interview_at        TEXT,                             -- 面试时间（多为人工填写）
  note                TEXT,
  source              TEXT,                            -- 页面回填 / 辅助投递 / 人工
  send_status         TEXT,                            -- confirmed / image_sent / complete / failed
  send_error          TEXT,
  manual_locked       INTEGER NOT NULL DEFAULT 0,      -- 人工修正保护位
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_job_attempt ON application(job_id, attempt);
CREATE INDEX IF NOT EXISTS idx_app_stage ON application(stage);
CREATE INDEX IF NOT EXISTS idx_app_applied ON application(applied_at);

-- 状态历史：每次阶段/查看变化一行，含依据与置信度
-- applied=0 表示"待确认变更"（页面含义不明确，等待人工采纳）
CREATE TABLE IF NOT EXISTS status_event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES application(id),
  field          TEXT NOT NULL,              -- stage / viewed / applied_at
  old_value      TEXT,
  new_value      TEXT,
  evidence       TEXT,                       -- 依据：页面原文 / 人工修正
  confidence     TEXT NOT NULL DEFAULT '确定',
  applied        INTEGER NOT NULL DEFAULT 1,
  occurred_at    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_app ON status_event(application_id);

-- 原始观测：仅保存扩展已经提取出的结构化字段，不保存整页或消息正文。
-- observation_key 用于拦截页面重复渲染、刷新和重复同步产生的相同数据。
CREATE TABLE IF NOT EXISTS raw_observation (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_key TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL,
  page_url        TEXT,
  job_key         TEXT,
  payload_json    TEXT NOT NULL,
  captured_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observation_job ON raw_observation(job_key);
CREATE INDEX IF NOT EXISTS idx_observation_captured ON raw_observation(captured_at);

-- 用户在职位页手动建立沟通后的事件；snapshot_json 保留当时页面的结构化快照。
CREATE TABLE IF NOT EXISTS contact_event (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id              TEXT NOT NULL UNIQUE,
  job_id                INTEGER REFERENCES job(id),
  hr_id                 INTEGER REFERENCES hr(id),
  action_label          TEXT,
  success_dialog_text   TEXT NOT NULL,
  contacted_at          TEXT NOT NULL,
  stay_button_text      TEXT,
  stay_button_clicked   INTEGER NOT NULL DEFAULT 0,
  capture_status        TEXT NOT NULL,
  missing_fields_json   TEXT,
  warnings_json         TEXT,
  snapshot_json         TEXT NOT NULL,
  source                TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_event_time ON contact_event(contacted_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_event_job ON contact_event(job_id);

-- 页面级累计数：保留平台显示的总量，用于提示逐条历史记录的采集覆盖率。
CREATE TABLE IF NOT EXISTS source_counter (
  source       TEXT PRIMARY KEY,
  total        INTEGER NOT NULL,
  captured_at  TEXT NOT NULL,
  page_url     TEXT,
  updated_at   TEXT NOT NULL
);

-- 同步运行记录（含暂停原因，供管理页显示"数据截至"）
CREATE TABLE IF NOT EXISTS sync_run (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT,
  status          TEXT,                      -- ok / partial / paused / requested
  message         TEXT,
  records_read    INTEGER,
  records_updated INTEGER,
  stage_changes   INTEGER,
  pending         INTEGER,
  started_at      TEXT,
  finished_at     TEXT NOT NULL
);
