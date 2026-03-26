const colors = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const ts = () => new Date().toISOString().replace("T"," ").slice(0,19);

// Set LOG_LEVEL=quiet di .env untuk sembunyikan log tidak penting
const quiet = process.env.LOG_LEVEL === "quiet";

const logger = {
  info   : (...a) => { if (!quiet) console.log(`${colors.cyan}[${ts()}]${colors.reset}`, ...a); },
  warn   : (...a) => console.warn(`${colors.yellow}[${ts()}] ⚠️ ${colors.reset}`, ...a),
  error  : (...a) => console.error(`${colors.red}[${ts()}] ❌ ${colors.reset}`, ...a),
  success: (...a) => console.log(`${colors.green}[${ts()}] ✅ ${colors.reset}`, ...a),
  // Log penting yang selalu muncul walau quiet mode
  trade  : (...a) => console.log(`${colors.green}[${ts()}]${colors.reset}`, ...a),
  tick   : (...a) => console.log(`${colors.cyan}[${ts()}]${colors.reset}`, ...a),
};
module.exports = logger;