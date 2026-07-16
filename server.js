const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const initSqlJs = require('sql.js');

// ======================== TOKEN (आपका) =========================
// ⚠️ अगर Environment Variable में BOT_TOKEN है तो वो Use होगा, नहीं तो नीचे वाला
const BOT_TOKEN = process.env.BOT_TOKEN || '8765838668:AAFLZNRe4bzMBramyFLOZp0r9uog5tabm0M';
// =================================================================

// =====================================================
// 🗄️ DATABASE (SQLite using sql.js – pure JS, no build)
// =====================================================
const DB_PATH = path.join(__dirname, 'panel.db');
let db = null;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message TEXT,
      response TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const defaultMsg = '🙏 नमस्ते! यह Telegram Bot है। आपको ऑटोमेटिक रिप्लाई मिल रही है।';
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_reply', ?)", [defaultMsg]);
  saveDB();
  console.log('✅ Database initialized.');
  return true;
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getSetting(key) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get(key);
  stmt.free();
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  saveDB();
}

function logChat(chatId, message, response) {
  db.run('INSERT INTO chat_logs (chat_id, message, response) VALUES (?, ?, ?)', [chatId, message, response]);
  saveDB();
}

function getChatLogs(limit = 50) {
  const stmt = db.prepare('SELECT * FROM chat_logs ORDER BY timestamp DESC LIMIT ?');
  const rows = stmt.all(limit);
  stmt.free();
  return rows;
}

function getUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const result = stmt.get(username);
  stmt.free();
  return result;
}

function createUser(username, password) {
  const hashed = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashed]);
  saveDB();
  return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
}

// =====================================================
// 🤖 TELEGRAM BOT
// =====================================================
if (!BOT_TOKEN || BOT_TOKEN === '8765838668:AAFLZNRe4bzMBramyFLOZp0r9uog5tabm0M') {
  console.log('⚠️ Using default token. If you want to change, set BOT_TOKEN env var.');
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 Telegram Bot is polling...');

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '[non-text]';
  const replyMsg = getSetting('auto_reply') || '🙏 नमस्ते!';
  try {
    await bot.sendMessage(chatId, replyMsg);
    logChat(chatId, text, replyMsg);
    console.log(`📩 [${chatId}] Replied: "${replyMsg}"`);
  } catch (err) {
    console.error('❌ Reply error:', err.message);
  }
});

// =====================================================
// 🌐 EXPRESS WEB DASHBOARD
// =====================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'telegram_premium_bot_secret_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function isAuth(req, res, next) {
  if (req.session.userId) return next();
  if (['/login', '/signup', '/api/login', '/api/signup'].includes(req.path)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
app.use(isAuth);

// ===== DASHBOARD HTML (Premium Design) =====
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Premium Telegram Bot</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Segoe UI',sans-serif; }
    body { background:#0a0f14; color:#e8edf0; min-height:100vh; display:flex; justify-content:center; padding:20px; }
    .container { max-width:1200px; width:100%; }
    .header { display:flex; justify-content:space-between; align-items:center; padding:20px 30px; background:rgba(20,30,40,0.8); backdrop-filter:blur(12px); border-radius:20px; border:1px solid rgba(255,255,255,0.05); margin-bottom:30px; }
    .header h1 { font-size:26px; background:linear-gradient(135deg,#2b9cff,#0088cc); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .header h1 i { margin-right:10px; }
    .header .owner { color:#8899aa; font-size:14px; background:rgba(255,255,255,0.04); padding:6px 16px; border-radius:30px; border:1px solid rgba(255,255,255,0.06); }
    .header .owner i { color:#f5b342; margin-right:6px; }
    .logout-btn { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08); color:#e8edf0; padding:8px 22px; border-radius:30px; cursor:pointer; transition:0.3s; }
    .logout-btn:hover { background:#b33b3b; border-color:#b33b3b; }
    .stats { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:20px; margin-bottom:30px; }
    .stat-card { background:rgba(20,30,40,0.6); backdrop-filter:blur(6px); border-radius:16px; padding:20px; border:1px solid rgba(255,255,255,0.05); text-align:center; }
    .stat-card h3 { font-size:32px; color:#2b9cff; }
    .stat-card p { color:#8899aa; font-size:14px; margin-top:6px; }
    .add-section { background:rgba(20,30,40,0.7); backdrop-filter:blur(8px); border-radius:20px; padding:28px 32px; border:1px solid rgba(255,255,255,0.05); margin-bottom:30px; display:flex; flex-wrap:wrap; gap:18px; align-items:flex-end; }
    .add-section .field { flex:1 1 220px; min-width:180px; }
    .add-section label { display:block; font-size:13px; color:#8899aa; margin-bottom:6px; font-weight:500; }
    .add-section label i { color:#2b9cff; margin-right:6px; }
    .add-section input { width:100%; padding:14px 18px; background:rgba(30,45,60,0.6); border:1px solid rgba(255,255,255,0.06); border-radius:12px; color:#e8edf0; font-size:15px; outline:none; transition:0.3s; }
    .add-section input:focus { border-color:#2b9cff; box-shadow:0 0 0 3px rgba(43,156,255,0.15); }
    .btn-primary { background:linear-gradient(135deg,#2b9cff,#0088cc); border:none; color:#0a0f14; padding:14px 32px; border-radius:12px; font-weight:700; font-size:15px; cursor:pointer; transition:0.3s; display:flex; align-items:center; gap:8px; height:52px; white-space:nowrap; box-shadow:0 6px 20px rgba(43,156,255,0.25); }
    .btn-primary:hover { transform:translateY(-2px) scale(1.02); box-shadow:0 10px 30px rgba(43,156,255,0.4); }
    .logs-section { background:rgba(20,30,40,0.5); backdrop-filter:blur(4px); border-radius:16px; padding:20px; border:1px solid rgba(255,255,255,0.05); margin-top:20px; max-height:400px; overflow-y:auto; }
    .log-item { display:flex; justify-content:space-between; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:14px; color:#8899aa; }
    .log-item .chat { color:#e8edf0; }
    .log-item .msg { color:#2b9cff; }
    .log-item .reply { color:#00d4aa; }
    .footer { margin-top:40px; padding:20px 0; text-align:center; color:#586b75; font-size:14px; border-top:1px solid rgba(255,255,255,0.04); }
    .footer i { color:#f5b342; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><i class="fab fa-telegram"></i> Premium Telegram Bot</h1>
    <div class="owner"><i class="fas fa-crown"></i> Owner: @anynomuospapa</div>
    <button class="logout-btn" onclick="logout()"><i class="fas fa-sign-out-alt"></i> Logout</button>
  </div>

  <div class="stats">
    <div class="stat-card"><h3 id="totalChats">-</h3><p>Total Messages</p></div>
    <div class="stat-card"><h3 id="botStatus">🟢 Online</h3><p>Status</p></div>
  </div>

  <div class="add-section">
    <div class="field">
      <label><i class="fas fa-reply"></i> Auto-Reply Message</label>
      <input type="text" id="replyInput" placeholder="नमस्ते! मैं Telegram Bot हूँ">
    </div>
    <button class="btn-primary" onclick="updateReply()"><i class="fas fa-save"></i> Update Reply</button>
  </div>

  <div class="logs-section">
    <h3 style="margin-bottom:12px;color:#e8edf0;"><i class="fas fa-history"></i> Recent Activity</h3>
    <div id="logsContainer"><p style="color:#586b75;">Loading...</p></div>
  </div>
  <div class="footer"><i class="fas fa-code"></i> Premium Telegram Bot &bull; Made with <i class="fas fa-heart" style="color:#b33b3b;"></i> by <strong>@anynomuospapa</strong></div>
</div>

<script>
async function fetchLogs() {
  const res = await fetch('/api/logs');
  const data = await res.json();
  const container = document.getElementById('logsContainer');
  if (data.length === 0) {
    container.innerHTML = '<p style="color:#586b75;">No logs yet.</p>';
    return;
  }
  container.innerHTML = data.map(log => \`
    <div class="log-item">
      <span class="chat">\${log.chat_id}</span>
      <span class="msg">"\${log.message}"</span>
      <span class="reply">→ \${log.response}</span>
      <span style="color:#586b75;">\${new Date(log.timestamp).toLocaleString()}</span>
    </div>
  \`).join('');
  document.getElementById('totalChats').textContent = data.length;
}

async function updateReply() {
  const msg = document.getElementById('replyInput').value.trim();
  if (!msg) { alert('Please enter a reply message.'); return; }
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'auto_reply', value: msg })
  });
  if (res.ok) alert('✅ Reply updated!');
  else alert('❌ Failed to update.');
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}

async function loadReply() {
  const res = await fetch('/api/settings/auto_reply');
  const data = await res.json();
  if (data.value) document.getElementById('replyInput').value = data.value;
}

fetchLogs();
loadReply();
setInterval(fetchLogs, 5000);
</script>
</body>
</html>`;

// =====================================================
// 🚀 ROUTES
// =====================================================
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Login</title><style>body{background:#0a0f14;color:#e8edf0;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Segoe UI',sans-serif;margin:0}.card{background:rgba(20,30,40,0.8);padding:40px;border-radius:20px;width:360px;text-align:center;border:1px solid rgba(255,255,255,0.05)}input{width:100%;padding:14px;margin:10px 0;background:rgba(30,45,60,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;color:#e8edf0;font-size:16px}button{width:100%;padding:14px;background:linear-gradient(135deg,#2b9cff,#0088cc);border:none;border-radius:12px;font-weight:700;font-size:16px;cursor:pointer;color:#0a0f14}a{color:#2b9cff}</style></head><body><div class="card"><h1 style="background:linear-gradient(135deg,#2b9cff,#0088cc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">🔐 Login</h1><form action="/api/login" method="POST"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button type="submit">Login</button></form><p style="margin-top:16px;color:#8899aa;">New? <a href="/signup">Sign up</a></p></div></body></html>`);
});

app.get('/signup', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Signup</title><style>body{background:#0a0f14;color:#e8edf0;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Segoe UI',sans-serif;margin:0}.card{background:rgba(20,30,40,0.8);padding:40px;border-radius:20px;width:360px;text-align:center;border:1px solid rgba(255,255,255,0.05)}input{width:100%;padding:14px;margin:10px 0;background:rgba(30,45,60,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;color:#e8edf0;font-size:16px}button{width:100%;padding:14px;background:linear-gradient(135deg,#2b9cff,#0088cc);border:none;border-radius:12px;font-weight:700;font-size:16px;cursor:pointer;color:#0a0f14}a{color:#2b9cff}</style></head><body><div class="card"><h1 style="background:linear-gradient(135deg,#2b9cff,#0088cc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">📝 Signup</h1><form action="/api/signup" method="POST"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button type="submit">Create Account</button></form><p style="margin-top:16px;color:#8899aa;">Already have? <a href="/login">Login</a></p></div></body></html>`);
});

app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.send(DASHBOARD_HTML);
});

// =====================================================
// 🔌 API ENDPOINTS
// =====================================================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = getUserByUsername(username);
  if (!user) return res.send('<h3>Invalid User</h3><a href="/login">Back</a>');
  if (!bcrypt.compareSync(password, user.password)) return res.send('<h3>Wrong Password</h3><a href="/login">Back</a>');
  req.session.userId = user.id;
  req.session.username = user.username;
  res.redirect('/');
});

app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  try {
    createUser(username, password);
    res.send('<h3>✅ Account Created! <a href="/login">Login</a></h3>');
  } catch(e) { res.send('<h3>❌ Username exists! <a href="/signup">Try again</a></h3>'); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/settings/:key', (req, res) => {
  const value = getSetting(req.params.key);
  res.json({ value });
});

app.put('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (key && value !== undefined) {
    setSetting(key, value);
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Missing key or value' });
  }
});

app.get('/api/logs', (req, res) => {
  const logs = getChatLogs(50);
  res.json(logs);
});

// =====================================================
// 🚀 START SERVER
// =====================================================
(async () => {
  await initDB();
  app.listen(PORT, () => {
    console.log(`\n🚀 Panel running at http://localhost:${PORT}`);
    console.log(`👑 Owner: @anynomuospapa`);
    console.log(`🤖 Telegram Bot is active! Send a message to test.\n`);
  });
})();

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Error:', err.message);
});
