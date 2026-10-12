// 文件日志（T-054）：主进程日志落盘到 dir，并转发渲染层 console（仅 error/warn，避免刷屏）。
const fs = require('fs');
const path = require('path');

function ts() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return '[unserializable]';
    }
  }
}

/** 创建日志器。dir 不存在会自动创建；日志按天滚动到不同文件。 */
function createLogger({ dir, name = 'eva' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${new Date().toISOString().slice(0, 10)}.log`);
  const write = (level, args) => {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    const line = `${ts()} [${level}] ${msg}\n`;
    try {
      fs.appendFileSync(file, line);
    } catch {
      /* 磁盘满/权限问题：忽略，避免主流程崩溃 */
    }
    const out = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    out(`[${level}]`, ...args);
  };
  return {
    file,
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
    /** 转发渲染层 console-message 事件（兼容不同 Electron 版本的参数顺序）。 */
    forwardRenderer(win) {
      if (!win || !win.webContents) return;
      win.webContents.on('console-message', (event, arg1, arg2) => {
        let level = arg1;
        let message = arg2;
        if (typeof level === 'string') {
          message = level;
          level = arg2;
        }
        const map = { 0: 'DEBUG', 1: 'INFO', 2: 'WARN', 3: 'ERROR' };
        const lv = map[level] || 'INFO';
        if (lv === 'INFO' || lv === 'DEBUG') return; // 只收 error/warn
        write(lv, [`[renderer] ${message}`]);
      });
    },
  };
}

module.exports = { createLogger };
