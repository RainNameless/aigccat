// 会话状态的落盘位置 —— 全项目只有这一处定义，避免三个模块各写一份漂移。
//
// 为什么需要它：同一份代码要在两种地方跑。
//   · 宿主机（开发/旧方式）：状态在 <仓库>/.ai/browser-state/，跟以前一样；
//   · 单容器（对外交付）：状态要落进数据卷 /data，这样「备份一个卷」
//     就把登录凭据、会话、生成任务一起备走了，且宿主机上不留任何东西。
// 靠环境变量切换，不改业务逻辑。
const path = require('node:path');

const ROOT = process.env.STUDIO_ROOT || path.resolve(__dirname, '../..');
const STATE_DIR = process.env.STUDIO_STATE_DIR || path.join(ROOT, '.ai/browser-state');

module.exports = {
  ROOT,
  STATE_DIR,
  SESSION_FILE: process.env.STUDIO_SESSION_FILE || path.join(STATE_DIR, 'studio-session.auth.json'),
  TOKEN_FILE: path.join(STATE_DIR, 'studio-runner-token'),
  JOBS_DIR: path.join(STATE_DIR, 'studio-jobs'),
};
