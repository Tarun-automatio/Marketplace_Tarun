const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SILENT: 4 };

const currentLevel = (() => {
  const env = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
  return LOG_LEVELS[env] ?? LOG_LEVELS.INFO;
})();

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function log(level, tag, message, meta) {
  if (LOG_LEVELS[level] < currentLevel) return;

  const prefix = `[${timestamp()}] [${level}] [${tag}]`;
  const metaStr = meta ? ` | ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
  console.log(`${prefix} ${message}${metaStr}`);
}

const logger = {
  debug: (tag, message, meta) => log('DEBUG', tag, message, meta),
  info:  (tag, message, meta) => log('INFO', tag, message, meta),
  warn:  (tag, message, meta) => log('WARN', tag, message, meta),
  error: (tag, message, meta) => log('ERROR', tag, message, meta),

  section(title) {
    const line = '='.repeat(64);
    console.log(`\n${line}`);
    console.log(`  ${title}`);
    console.log(`${line}`);
  },

  subsection(title) {
    console.log(`\n--- ${title} ---`);
  },

  table(rows) {
    if (!rows.length) return;
    console.table(rows);
  },

  formatDuration,
  timestamp,
};

module.exports = logger;
