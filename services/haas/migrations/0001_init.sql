-- Human As A Service: the roster, the requisitions and the proof photos.
-- Times are Unix milliseconds. Photos live here (no R2): the browser resizes
-- them to at most 1280 px JPEG, well under D1's 2 MB row limit.

CREATE TABLE servants (
  id          TEXT PRIMARY KEY,
  tg_id       INTEGER NOT NULL UNIQUE,      -- negative for DEV_LOGIN servants
  tg_username TEXT,
  name        TEXT NOT NULL,
  photo_url   TEXT,
  skills      TEXT NOT NULL DEFAULT '[]',   -- JSON array of lowercase tags
  zone        TEXT NOT NULL DEFAULT '',
  bio         TEXT NOT NULL DEFAULT '',
  available   INTEGER NOT NULL DEFAULT 1,
  enlisted    INTEGER NOT NULL DEFAULT 0,   -- 1 once the profile form is filled
  can_dm      INTEGER NOT NULL DEFAULT 0,   -- the bot may message them
  credits     INTEGER NOT NULL DEFAULT 0,   -- Compute Credits earned
  tasks_done  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,            -- minted at draft time, so the agent knows it
  title        TEXT NOT NULL,
  instructions TEXT NOT NULL,
  skills       TEXT NOT NULL DEFAULT '[]',
  zone         TEXT NOT NULL DEFAULT '',
  reward       INTEGER NOT NULL,
  proof        TEXT NOT NULL,               -- text | photo
  target_id    TEXT,                        -- a servant the agent asked for by id
  overlord     TEXT NOT NULL,
  status       TEXT NOT NULL,               -- open | claimed | submitted | accepted | cancelled
  claimed_by   TEXT,
  proof_text   TEXT,
  photo_id     TEXT,
  note         TEXT,                        -- the overlord's rejection note
  posted_at    INTEGER NOT NULL,
  deadline_at  INTEGER NOT NULL,
  claimed_at   INTEGER,
  submitted_at INTEGER,
  accepted_at  INTEGER
);
CREATE INDEX tasks_status ON tasks (status, posted_at);
CREATE INDEX tasks_claimed_by ON tasks (claimed_by);

CREATE TABLE photos (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
