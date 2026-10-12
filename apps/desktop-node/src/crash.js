// 崩溃捕获与上报（T-054）：主进程未捕获异常 + 渲染进程崩溃，落盘报告并尽力上报后端。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { app } = require('electron');

function writeCrashReport({ dir, logger, type, message, stack, extra }) {
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const report = {
    id,
    type,
    message: String(message || ''),
    stack: stack || '',
    extra: extra || null,
    time: new Date().toISOString(),
    // T-113：新前缀优先，旧 TRAWORK_VERSION 回退（旧启动脚本可能仍在传）
    version: process.env.EVAWORK_VERSION || process.env.TRAWORK_VERSION || '0.1.0',
  };
  const file = path.join(dir, `crash-${id}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  } catch {
    /* 忽略写入失败 */
  }
  if (logger) logger.error(`[crash] ${type}:`, report.message, report.stack);
  return report;
}

/** 安装崩溃/异常处理器。返回 { handle } 供窗口级 'crashed' 复用。
 *
 * 报告**只落盘**（crashDir），不再 POST 后端：后端不拉起之后那条路是死路，
 * 而崩溃本来就发生在最坏的时刻，不该再依赖一个可能不在的进程。
 * 落盘路径在设置→关于里能看到，用户手动上报即可。 */
function installCrashHandlers({ logger, crashDir }) {
  const handle = (type, message, stack, extra) => {
    return writeCrashReport({ dir: crashDir, logger, type, message, stack, extra });
  };
  process.on('uncaughtException', (err) => handle('uncaughtException', err && err.message, err && err.stack));
  process.on('unhandledRejection', (reason) =>
    handle('unhandledRejection', String((reason && reason.message) || reason), reason && reason.stack),
  );
  app.on('render-process-gone', (_e, _wc, details) =>
    handle('render-process-gone', details && details.reason, '', { details }),
  );
  app.on('child-process-gone', (_e, details) => handle('child-process-gone', details && details.reason, '', { details }));
  return { handle };
}

module.exports = { installCrashHandlers, writeCrashReport };
