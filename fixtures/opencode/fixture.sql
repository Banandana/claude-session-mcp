-- Synthetic opencode store, schema-faithful to opencode 1.18.x
-- (`~/.local/share/opencode/opencode.db`). Load into a temp SQLite file in
-- tests; never point tests at a real opencode database.
--
-- Contents: one project, one parent session + one child (sub-agent) session,
-- and one part of every type the adapter has to handle — including a
-- SUCCESSFUL tool call whose output contains the word "error", which must NOT
-- be counted as a failure.

CREATE TABLE `project` (
  `id` text PRIMARY KEY,
  `worktree` text NOT NULL,
  `vcs` text,
  `name` text,
  `icon_url` text,
  `icon_url_override` text,
  `icon_color` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_initialized` integer,
  `sandboxes` text NOT NULL,
  `commands` text
);

CREATE TABLE `project_directory` (
  `project_id` text NOT NULL,
  `directory` text NOT NULL,
  `type` text,
  `strategy` text,
  `time_created` integer NOT NULL,
  CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`)
);

CREATE TABLE `session` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `parent_id` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `path` text,
  `title` text NOT NULL,
  `version` text NOT NULL,
  `share_url` text,
  `summary_additions` integer,
  `summary_deletions` integer,
  `summary_files` integer,
  `summary_diffs` text,
  `metadata` text,
  `cost` real DEFAULT 0 NOT NULL,
  `tokens_input` integer DEFAULT 0 NOT NULL,
  `tokens_output` integer DEFAULT 0 NOT NULL,
  `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL,
  `tokens_cache_write` integer DEFAULT 0 NOT NULL,
  `revert` text,
  `permission` text,
  `agent` text,
  `model` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_compacting` integer,
  `time_archived` integer
);

CREATE TABLE `message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);

CREATE TABLE `part` (
  `id` text PRIMARY KEY,
  `message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);

CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);

INSERT INTO `project` VALUES
  ('proj_alpha_sha1', '/home/test/project-alpha', 'git', NULL, NULL, NULL, NULL, 1786900000000, 1787000000000, 1786900000000, '[]', NULL);

INSERT INTO `project_directory` VALUES
  ('proj_alpha_sha1', '/home/test/project-alpha', 'worktree', 'exact', 1786900000000);

INSERT INTO `session` VALUES
  ('ses_parent0000000000000001', 'proj_alpha_sha1', NULL, NULL, 'tidy-island',
   '/home/test/project-alpha', '', 'Add retry to fetch helper', '1.18.16', NULL,
   12, 3, 2, NULL, NULL,
   0.1925675, 10086, 2258, 134, 72576, 0,
   NULL, NULL, 'build', '{"id":"zai-glm-4.7","providerID":"cerebras","variant":"default"}',
   1787000000000, 1787000600000, NULL, NULL),
  ('ses_child00000000000000002', 'proj_alpha_sha1', NULL, 'ses_parent0000000000000001', 'brave-comet',
   '/home/test/project-alpha', '', 'Review the retry helper', '1.18.16', NULL,
   NULL, NULL, NULL, NULL, NULL,
   0.004, 500, 40, 0, 0, 0,
   NULL, NULL, 'explore', '{"id":"zai-glm-4.7","providerID":"cerebras","variant":"default"}',
   1787000300000, 1787000400000, NULL, NULL);

INSERT INTO `message` VALUES
  ('msg_user_0000000000000001', 'ses_parent0000000000000001', 1787000010000, 1787000010000,
   '{"role":"user","time":{"created":1787000010000},"agent":"build","model":{"providerID":"cerebras","modelID":"zai-glm-4.7"}}'),
  ('msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000020000, 1787000060000,
   '{"parentID":"msg_user_0000000000000001","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/home/test/project-alpha","root":"/home/test/project-alpha"},"cost":0.19,"tokens":{"input":10086,"output":2258,"reasoning":134,"cache":{"read":72576,"write":0}},"modelID":"zai-glm-4.7","providerID":"cerebras","time":{"created":1787000020000,"completed":1787000060000}}'),
  ('msg_asst_0000000000000003', 'ses_parent0000000000000001', 1787000070000, 1787000080000,
   '{"parentID":"msg_asst_0000000000000002","role":"assistant","mode":"build","agent":"build","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"modelID":"zai-glm-4.7","providerID":"cerebras","time":{"created":1787000070000,"completed":1787000080000},"error":{"name":"APIError","data":{"message":"Model is archived and unavailable.","statusCode":404,"isRetryable":false}}}'),
  ('msg_child_000000000000004', 'ses_child00000000000000002', 1787000310000, 1787000320000,
   '{"role":"assistant","mode":"explore","agent":"explore","cost":0.004,"tokens":{"input":500,"output":40,"reasoning":0,"cache":{"read":0,"write":0}},"modelID":"zai-glm-4.7","providerID":"cerebras","time":{"created":1787000310000,"completed":1787000320000}}');

INSERT INTO `part` VALUES
  -- user prompt
  ('prt_0000000000000000000001', 'msg_user_0000000000000001', 'ses_parent0000000000000001', 1787000010000, 1787000010000,
   '{"type":"text","text":"add a retry to the fetch helper"}'),
  -- assistant step boundary
  ('prt_0000000000000000000002', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000020000, 1787000020000,
   '{"type":"step-start","snapshot":"7e947f0f260825eb10cd431c95526132d5637644"}'),
  -- reasoning (thinking)
  ('prt_0000000000000000000003', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000021000, 1787000021000,
   '{"type":"reasoning","text":"The helper has no backoff. Bound it at three attempts.","time":{"start":1787000021000,"end":1787000021400}}'),
  -- SUCCESSFUL tool call whose output contains the word "error" (regression trap)
  ('prt_0000000000000000000004', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000030000, 1787000031000,
   '{"type":"tool","tool":"bash","callID":"call_bash_1","state":{"status":"completed","input":{"command":"npm test"},"output":"3 passing, 0 errors reported","time":{"start":1787000030000,"end":1787000031000}}}'),
  -- genuinely failed tool call
  ('prt_0000000000000000000005', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000032000, 1787000033000,
   '{"type":"tool","tool":"read","callID":"call_read_1","state":{"status":"error","input":{"filePath":"/home/test/project-alpha/missing.ts"},"error":"ENOENT: no such file or directory","time":{"start":1787000032000,"end":1787000033000}}}'),
  -- sub-agent spawn: the task tool carries the child session id
  ('prt_0000000000000000000006', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000034000, 1787000035000,
   '{"type":"tool","tool":"task","callID":"call_task_1","state":{"status":"completed","title":"Review the retry helper","metadata":{"parentSessionId":"ses_parent0000000000000001","sessionId":"ses_child00000000000000002","model":{"modelID":"zai-glm-4.7","providerID":"cerebras"}},"input":{"description":"Review the retry helper","subagent_type":"explore","prompt":"check for unbounded loops"},"output":"Bounded at 3 attempts."}}'),
  -- file edits
  ('prt_0000000000000000000007', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000040000, 1787000040000,
   '{"type":"patch","hash":"317e7e83a95afe8dd4a8fc94350d5d1cbb80d927","files":["/home/test/project-alpha/src/fetch.ts","/home/test/project-alpha/src/retry.ts"]}'),
  -- assistant prose
  ('prt_0000000000000000000008', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000050000, 1787000050000,
   '{"type":"text","text":"Added a bounded retry with backoff to fetchJson and a new retry.ts helper."}'),
  -- per-step usage and cost
  ('prt_0000000000000000000009', 'msg_asst_0000000000000002', 'ses_parent0000000000000001', 1787000060000, 1787000060000,
   '{"type":"step-finish","reason":"stop","snapshot":"7e947f0f260825eb10cd431c95526132d5637644","tokens":{"total":85054,"input":10086,"output":2258,"reasoning":134,"cache":{"write":0,"read":72576}},"cost":0.1925675}'),
  -- context compaction
  ('prt_0000000000000000000010', 'msg_asst_0000000000000003', 'ses_parent0000000000000001', 1787000075000, 1787000075000,
   '{"type":"compaction","auto":true,"overflow":true,"tail_start_id":"msg_asst_0000000000000002"}'),
  -- child session content
  ('prt_0000000000000000000011', 'msg_child_000000000000004', 'ses_child00000000000000002', 1787000310000, 1787000310000,
   '{"type":"text","text":"Bounded at 3 attempts. No unbounded loop."}');
