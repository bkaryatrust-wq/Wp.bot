const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const initSqlJs = require('sql.js');

// =====================================================
// 🗄️ DATABASE
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
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      reply_type TEXT DEFAULT 'text',
      reply_content TEXT DEFAULT '🙏 नमस्ते! यह ऑटोमेटिक रिप्लाई है।',
      reply_caption TEXT DEFAULT '',
      auth_folder TEXT NOT NULL,
      status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  saveDB();
  console.log('✅ Database initialized.');
  return true;
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
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
function getAccounts(userId) {
  const stmt = db.prepare('SELECT * FROM accounts WHERE user_id = ?');
  const rows = stmt.all(userId);
  stmt.free();
  return rows;
}
function createAccount(userId, phone, authFolder, replyType = 'text', replyContent = '', replyCaption = '') {
  const content = replyContent || '🙏 नमस्ते! यह ऑटोमेटिक रिप्लाई है।';
  db.run(
    'INSERT INTO accounts (user_id, phone, auth_folder, reply_type, reply_content, reply_caption) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, phone, authFolder, replyType, content, replyCaption]
  );
  saveDB();
  return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
}
function updateAccountStatus(accountId, status) {
  db.run('UPDATE accounts SET status = ? WHERE id = ?', [status, accountId]);
  saveDB();
}
function updateAccountReply(accountId, type, content, caption) {
  db.run('UPDATE accounts SET reply_type = ?, reply_content = ?, reply_caption = ? WHERE id = ?', [type, content, caption, accountId]);
  saveDB();
}
function deleteAccount(accountId) {
  db.run('DELETE FROM accounts WHERE id = ?', [accountId]);
  saveDB();
}
function getAccount(accountId) {
  const stmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const result = stmt.get(accountId);
  stmt.free();
  return result;
}

// =====================================================
// 📱 WHATSAPP MANAGER
// =====================================================
const activeSockets = {};

async function startAccountSocket(accountId) {
  const account = getAccount(accountId);
  if (!account) return;

  const authFolder = path.join(__dirname, 'sessions', `user_${account.user_id}`, `acc_${accountId}`);
  if (activeSockets[accountId]) {
    try { await activeSockets[accountId].ws?.close(); } catch (e) {}
    delete activeSockets[accountId];
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
    browser: ['Chrome (Linux)', '', ''],
  });

  let pairingCode = null;
  if (!state.creds.registered) {
    try {
      pairingCode = await sock.requestPairingCode(account.phone);
      console.log(`📲 [${accountId}] Pairing Code: ${pairingCode}`);
    } catch (err) {
      console.error(`❌ [${accountId}] Code Error: ${err.message}`);
      updateAccountStatus(accountId, 'error');
      return;
    }
  } else {
    console.log(`♻️ [${accountId}] Session restored.`);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      updateAccountStatus(accountId, 'connected');
      console.log(`🟢 [${accountId}] Online.`);
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      updateAccountStatus(accountId, 'disconnected');
      delete activeSockets[accountId];
      if (shouldReconnect) {
        console.log(`🔄 [${accountId}] Reconnecting...`);
        setTimeout(() => startAccountSocket(accountId), 5000);
      } else {
        console.log(`🚫 [${accountId}] Logged out.`);
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
      }
    }
  });

  // ---------- ⭐ AUTO-REPLY (Text / APK / Voice / Link) ----------
  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages;
    if (!messages || messages.length === 0) return;

    const freshAccount = getAccount(accountId);
    if (!freshAccount) return;

    const processMessage = async (msg) => {
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
      const sender = msg.key.remoteJid;

      try {
        const type = freshAccount.reply_type || 'text';
        const content = freshAccount.reply_content || '🙏 नमस्ते!';
        const caption = freshAccount.reply_caption || '';

        if (type === 'text') {
          await sock.sendMessage(sender, { text: content });
          console.log(`📩 [${accountId}] Text reply to ${sender}`);
        } 
        else if (type === 'link') {
          await sock.sendMessage(sender, { text: `🔗 ${content}` });
          console.log(`📩 [${accountId}] Link reply to ${sender}`);
        }
        else if (type === 'document' || type === 'apk') {
          if (fs.existsSync(content)) {
            await sock.sendMessage(sender, {
              document: fs.readFileSync(content),
              mimetype: 'application/vnd.android.package-archive',
              fileName: path.basename(content),
              caption: caption || '📦 Here is your file!'
            });
            console.log(`📩 [${accountId}] APK/File sent to ${sender}`);
          } else {
            await sock.sendMessage(sender, { text: '❌ File not found on server!' });
          }
        }
        else if (type === 'audio' || type === 'voice') {
          if (fs.existsSync(content)) {
            await sock.sendMessage(sender, {
              audio: fs.readFileSync(content),
              mimetype: 'audio/ogg',
              ptt: true
            });
            console.log(`📩 [${accountId}] Voice note sent to ${sender}`);
          } else {
            await sock.sendMessage(sender, { text: '❌ Audio file not found!' });
          }
        }
        else {
          await sock.sendMessage(sender, { text: content });
        }
      } catch (err) {
        console.error(`❌ [${accountId}] Reply error:`, err.message);
      }
    };

    const BATCH_SIZE = 5;
    const DELAY_MS = 200;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(processMessage));
      if (i + BATCH_SIZE < messages.length) await new Promise(r => setTimeout(r, DELAY_MS));
    }
  });

  activeSockets[accountId] = sock;
  return { sock, pairingCode };
}

async function stopAccountSocket(accountId) {
  if (activeSockets[accountId]) {
    try { await activeSockets[accountId].ws?.close(); } catch (e) {}
    delete activeSockets[accountId];
    updateAccountStatus(accountId, 'disconnected');
    return true;
  }
  return false;
}

// =====================================================
// 🌐 EXPRESS SERVER + DASHBOARD
// =====================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'whatsapp_bot_secret_2026',
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

// =====================================================
// 🎨 DASHBOARD HTML (Premium Design)
// =====================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp Ultimate Bot</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
    body { background: #0a0f14; color: #e8edf0; min-height: 100vh; display: flex; justify-content: center; padding: 20px; }
    .container { max-width: 1300px; width: 100%; }
    .header { display: flex; justify-content: space-between; align-items: center; padding: 20px 30px; background: rgba(20,30,40,0.8); backdrop-filter: blur(12px); border-radius: 20px; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 30px; }
    .header h1 { font-size: 26px; background: linear-gradient(135deg, #00d4aa, #00a884); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .header h1 i { margin-right: 10px; }
    .header .owner { color: #8899aa; font-size: 14px; background: rgba(255,255,255,0.04); padding: 6px 16px; border-radius: 30px; border: 1px solid rgba(255,255,255,0.06); }
    .header .owner i { color: #f5b342; margin-right: 6px; }
    .logout-btn { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); color: #e8edf0; padding: 8px 22px; border-radius: 30px; cursor: pointer; transition: 0.3s; }
    .logout-btn:hover { background: #b33b3b; border-color: #b33b3b; }
    .add-section { background: rgba(20,30,40,0.7); backdrop-filter: blur(8px); border-radius: 20px; padding: 28px 32px; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 30px; }
    .add-section .row { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-end; }
    .add-section .field { flex: 1 1 200px; min-width: 160px; }
    .add-section label { display: block; font-size: 13px; color: #8899aa; margin-bottom: 6px; font-weight: 500; }
    .add-section label i { color: #00a884; margin-right: 6px; }
    .add-section input, .add-section select { width: 100%; padding: 14px 18px; background: rgba(30,45,60,0.6); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; color: #e8edf0; font-size: 15px; outline: none; transition: 0.3s; }
    .add-section input:focus, .add-section select:focus { border-color: #00a884; box-shadow: 0 0 0 3px rgba(0,168,132,0.15); }
    .add-section select option { background: #1a2a33; color: #e8edf0; }
    .btn-primary { background: linear-gradient(135deg, #00a884, #00d4aa); border: none; color: #0a0f14; padding: 14px 32px; border-radius: 12px; font-weight: 700; font-size: 15px; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px; height: 52px; white-space: nowrap; box-shadow: 0 6px 20px rgba(0,168,132,0.25); }
    .btn-primary:hover { transform: translateY(-2px) scale(1.02); box-shadow: 0 10px 30px rgba(0,168,132,0.4); }
    .btn-primary:active { transform: scale(0.97); }
    .btn-sm { padding: 6px 16px; font-size: 13px; border-radius: 30px; border: none; font-weight: 600; cursor: pointer; transition: 0.3s; display: inline-flex; align-items: center; gap: 6px; }
    .btn-reconnect { background: rgba(0,168,132,0.15); color: #00a884; }
    .btn-reconnect:hover { background: #00a884; color: #0a0f14; }
    .btn-danger { background: rgba(179,59,59,0.15); color: #b33b3b; }
    .btn-danger:hover { background: #b33b3b; color: white; }
    .btn-edit { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.06); color: #e8edf0; padding: 8px 14px; border-radius: 10px; cursor: pointer; transition: 0.3s; }
    .btn-edit:hover { background: #00a884; color: #0a0f14; }

    .accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 24px; }
    .account-card { background: rgba(20,30,40,0.6); backdrop-filter: blur(6px); border-radius: 18px; padding: 22px; border: 1px solid rgba(255,255,255,0.05); transition: 0.3s; border-left: 5px solid #2a3a4a; }
    .account-card:hover { transform: translateY(-4px); border-color: rgba(0,168,132,0.2); }
    .account-card.connected { border-left-color: #00a884; }
    .account-card.disconnected { border-left-color: #b33b3b; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .phone { font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .phone i { color: #00a884; }
    .status-badge { font-size: 12px; font-weight: 600; padding: 4px 16px; border-radius: 30px; background: #2a3a4a; color: #8899aa; }
    .status-badge.connected { background: rgba(0,168,132,0.2); color: #00a884; }
    .status-badge.disconnected { background: rgba(179,59,59,0.2); color: #b33b3b; }
    .reply-section { margin: 12px 0; }
    .reply-section .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .reply-section select { background: rgba(30,45,60,0.6); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 8px 12px; color: #e8edf0; outline: none; }
    .reply-section input { flex: 1; background: rgba(30,45,60,0.6); border: 1px solid rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; color: #e8edf0; font-size: 14px; outline: none; min-width: 120px; }
    .reply-section input:focus, .reply-section select:focus { border-color: #00a884; }
    .reply-section .btn-edit { padding: 6px 12px; }
    .card-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.04); }
    .card-actions .btn-sm { padding: 5px 14px; font-size: 12px; }

    .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); backdrop-filter: blur(10px); display: none; justify-content: center; align-items: center; z-index: 999; }
    .modal-box { background: #1a2a33; border-radius: 24px; padding: 44px 36px; max-width: 420px; width: 90%; text-align: center; border: 1px solid rgba(255,255,255,0.06); }
    .modal-box .code { font-size: 44px; font-weight: 800; letter-spacing: 6px; color: #00a884; background: #0a141a; padding: 16px; border-radius: 14px; margin: 16px 0; font-family: monospace; }
    .modal-box .close-btn { background: #00a884; border: none; color: #0a0f14; padding: 12px 32px; border-radius: 30px; font-weight: 700; cursor: pointer; margin-top: 16px; }
    .modal-box .close-btn:hover { transform: scale(1.04); }

    .empty { text-align: center; color: #586b75; padding: 50px 0; }
    .toast { position: fixed; bottom: 30px; right: 30px; background: rgba(20,30,40,0.9); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.06); color: #e8edf0; padding: 16px 24px; border-radius: 14px; border-left: 4px solid #00a884; display: none; z-index: 1000; font-weight: 500; max-width: 400px; }
    .footer { margin-top: 40px; padding: 20px 0; text-align: center; color: #586b75; font-size: 14px; border-top: 1px solid rgba(255,255,255,0.04); }
    .footer i { color: #f5b342; }
    @media (max-width: 700px) { .header { flex-wrap: wrap; gap: 12px; } .add-section .row { flex-direction: column; } .add-section .field { width: 100%; } .btn-primary { width: 100%; justify-content: center; } }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><i class="fab fa-whatsapp"></i> Ultimate WhatsApp Bot</h1>
    <div class="owner"><i class="fas fa-crown"></i> Owner: @anynomuospapa</div>
    <button class="logout-btn" onclick="logout()"><i class="fas fa-sign-out-alt"></i> Logout</button>
  </div>

  <!-- Add Account -->
  <div class="add-section">
    <div class="row">
      <div class="field">
        <label><i class="fas fa-phone"></i> Phone (देश कोड सहित)</label>
        <input type="text" id="phoneInput" placeholder="जैसे: 919876543210">
      </div>
      <div class="field">
        <label><i class="fas fa-reply"></i> Reply Type</label>
        <select id="replyTypeInput">
          <option value="text">📝 Text</option>
          <option value="link">🔗 Link</option>
          <option value="document">📦 APK/File</option>
          <option value="audio">🎵 Voice Note</option>
        </select>
      </div>
      <div class="field" style="flex:2;">
        <label><i class="fas fa-file-alt"></i> Content (Text / File Path / Link)</label>
        <input type="text" id="replyContentInput" placeholder="Text message or path to APK/audio file">
      </div>
      <div class="field">
        <label><i class="fas fa-caption"></i> Caption (for files)</label>
        <input type="text" id="replyCaptionInput" placeholder="Optional caption">
      </div>
      <button class="btn-primary" onclick="addAccount()"><i class="fas fa-plus-circle"></i> Connect</button>
    </div>
  </div>

  <!-- Accounts -->
  <div id="accountsContainer" class="accounts-grid"><div class="empty"><i class="fas fa-wifi-slash"></i> Loading...</div></div>
  <div class="footer"><i class="fas fa-code"></i> Premium WhatsApp Bot &bull; Made with <i class="fas fa-heart" style="color:#b33b3b;"></i> by <strong>@anynomuospapa</strong></div>
</div>

<!-- Modal -->
<div class="modal" id="codeModal">
  <div class="modal-box">
    <h3><i class="fas fa-key"></i> Pairing Code</h3>
    <div class="code" id="displayCode">------</div>
    <p style="color:#8899aa;font-size:14px;line-height:1.6;">WhatsApp → Linked Devices → Link with phone number</p>
    <button class="close-btn" onclick="closeModal()"><i class="fas fa-check"></i> Done</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let currentAccountId = null;

async function fetchAccounts() {
  const res = await fetch('/api/accounts');
  if (res.status === 401) { window.location.href = '/login'; return; }
  const data = await res.json();
  renderAccounts(data);
}

function renderAccounts(accounts) {
  const c = document.getElementById('accountsContainer');
  if (!accounts || accounts.length === 0) {
    c.innerHTML = '<div class="empty"><i class="fas fa-inbox"></i> कोई अकाउंट नहीं</div>';
    return;
  }
  c.innerHTML = accounts.map(acc => \`
    <div class="account-card \${acc.status}" id="card-\${acc.id}">
      <div class="card-header">
        <span class="phone"><i class="fab fa-whatsapp"></i> \${acc.phone}</span>
        <span class="status-badge \${acc.status}"><i class="fas fa-circle" style="font-size:8px;"></i> \${acc.status.toUpperCase()}</span>
      </div>
      <div class="reply-section">
        <div class="row">
          <select id="replyType-\${acc.id}" onchange="updateReply(\${acc.id})">
            <option value="text" \${acc.reply_type==='text'?'selected':''}>📝 Text</option>
            <option value="link" \${acc.reply_type==='link'?'selected':''}>🔗 Link</option>
            <option value="document" \${acc.reply_type==='document'?'selected':''}>📦 APK/File</option>
            <option value="audio" \${acc.reply_type==='audio'?'selected':''}>🎵 Voice</option>
          </select>
          <input type="text" id="replyContent-\${acc.id}" value="\${acc.reply_content}" placeholder="Text / Path / Link">
          <input type="text" id="replyCaption-\${acc.id}" value="\${acc.reply_caption || ''}" placeholder="Caption" style="flex:0.7;">
          <button class="btn-edit" onclick="updateReply(\${acc.id})"><i class="fas fa-save"></i></button>
        </div>
      </div>
      <div class="card-actions">
        \${acc.status === 'disconnected' ? '<button class="btn-sm btn-reconnect" onclick="reconnect('+acc.id+')"><i class="fas fa-sync-alt"></i> Reconnect</button>' : ''}
        <button class="btn-sm btn-danger" onclick="removeAccount(\${acc.id})"><i class="fas fa-trash"></i> Remove</button>
      </div>
    </div>
  \`).join('');
}

async function addAccount() {
  const phone = document.getElementById('phoneInput').value.trim();
  const type = document.getElementById('replyTypeInput').value;
  const content = document.getElementById('replyContentInput').value.trim();
  const caption = document.getElementById('replyCaptionInput').value.trim();
  if (!phone) { showToast('❌ Phone number daalo!'); return; }
  const btn = event.target; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...'; btn.disabled = true;
  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, reply_type: type, reply_content: content, reply_caption: caption })
    });
    const data = await res.json();
    if (data.success) {
      currentAccountId = data.accountId;
      document.getElementById('displayCode').textContent = data.pairingCode || '------';
      document.getElementById('codeModal').style.display = 'flex';
      showToast('✅ Account added! Enter code in WhatsApp.');
      fetchAccounts();
    } else showToast('❌ ' + data.error);
  } catch(e) { showToast('❌ Error'); }
  btn.innerHTML = '<i class="fas fa-plus-circle"></i> Connect'; btn.disabled = false;
  document.getElementById('phoneInput').value = '';
  document.getElementById('replyContentInput').value = '';
  document.getElementById('replyCaptionInput').value = '';
}

async function updateReply(id) {
  const type = document.getElementById('replyType-'+id).value;
  const content = document.getElementById('replyContent-'+id).value.trim();
  const caption = document.getElementById('replyCaption-'+id).value.trim();
  const res = await fetch('/api/accounts/'+id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply_type: type, reply_content: content, reply_caption: caption })
  });
  if (res.ok) showToast('✅ Reply Updated!');
  else showToast('❌ Update failed');
}

async function removeAccount(id) {
  if (!confirm('Remove this account?')) return;
  await fetch('/api/accounts/'+id, { method: 'DELETE' });
  showToast('🗑️ Removed');
  fetchAccounts();
}

async function reconnect(id) {
  showToast('🔄 Reconnecting...');
  const res = await fetch('/api/accounts/'+id+'/reconnect', { method: 'POST' });
  const data = await res.json();
  if (data.success && data.pairingCode) {
    currentAccountId = id;
    document.getElementById('displayCode').textContent = data.pairingCode;
    document.getElementById('codeModal').style.display = 'flex';
  } else if (data.success) showToast('✅ Connected!');
  else showToast('❌ Failed');
  fetchAccounts();
}

function closeModal() {
  document.getElementById('codeModal').style.display = 'none';
  if (currentAccountId) setTimeout(fetchAccounts, 3000);
  currentAccountId = null;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.style.display = 'none', 4000);
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}

fetchAccounts();
setInterval(fetchAccounts, 5000);
</script>
</body>
</html>`;

// =====================================================
// 🚀 ROUTES
// =====================================================
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Login</title><style>body{background:#0a0f14;color:#e8edf0;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Segoe UI',sans-serif;margin:0}.card{background:rgba(20,30,40,0.8);padding:40px;border-radius:20px;width:360px;text-align:center;border:1px solid rgba(255,255,255,0.05)}input{width:100%;padding:14px;margin:10px 0;background:rgba(30,45,60,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;color:#e8edf0;font-size:16px}button{width:100%;padding:14px;background:linear-gradient(135deg,#00a884,#00d4aa);border:none;border-radius:12px;font-weight:700;font-size:16px;cursor:pointer;color:#0a0f14}a{color:#00a884}</style></head><body><div class="card"><h1 style="background:linear-gradient(135deg,#00d4aa,#00a884);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">🔐 Login</h1><form action="/api/login" method="POST"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button type="submit">Login</button></form><p style="margin-top:16px;color:#8899aa;">New? <a href="/signup">Sign up</a></p></div></body></html>`);
});

app.get('/signup', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Signup</title><style>body{background:#0a0f14;color:#e8edf0;display:flex;justify-content:center;align-items:center;height:100vh;font-family:'Segoe UI',sans-serif;margin:0}.card{background:rgba(20,30,40,0.8);padding:40px;border-radius:20px;width:360px;text-align:center;border:1px solid rgba(255,255,255,0.05)}input{width:100%;padding:14px;margin:10px 0;background:rgba(30,45,60,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;color:#e8edf0;font-size:16px}button{width:100%;padding:14px;background:linear-gradient(135deg,#00a884,#00d4aa);border:none;border-radius:12px;font-weight:700;font-size:16px;cursor:pointer;color:#0a0f14}a{color:#00a884}</style></head><body><div class="card"><h1 style="background:linear-gradient(135deg,#00d4aa,#00a884);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">📝 Signup</h1><form action="/api/signup" method="POST"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button type="submit">Create Account</button></form><p style="margin-top:16px;color:#8899aa;">Already have? <a href="/login">Login</a></p></div></body></html>`);
});

app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.send(DASHBOARD_HTML);
});

// =====================================================
// 🔌 API
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

app.get('/api/accounts', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json(getAccounts(req.session.userId));
});

app.post('/api/accounts', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { phone, reply_type, reply_content, reply_caption } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  const authFolder = `user_${req.session.userId}/acc_${Date.now()}`;
  const result = createAccount(req.session.userId, phone, authFolder, reply_type || 'text', reply_content || '', reply_caption || '');
  const accountId = result.lastInsertRowid;

  try {
    const { pairingCode } = await startAccountSocket(accountId);
    res.json({ success: true, accountId, pairingCode: pairingCode || null });
  } catch(err) {
    deleteAccount(accountId);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts/:id', (req, res) => {
  const account = getAccount(req.params.id);
  if (!account || account.user_id !== req.session.userId) return res.status(403).json({ error: 'Not yours' });
  const { reply_type, reply_content, reply_caption } = req.body;
  updateAccountReply(req.params.id, reply_type || 'text', reply_content || '', reply_caption || '');
  res.json({ success: true });
});

app.delete('/api/accounts/:id', async (req, res) => {
  const account = getAccount(req.params.id);
  if (!account || account.user_id !== req.session.userId) return res.status(403).json({ error: 'Not yours' });
  await stopAccountSocket(req.params.id);
  deleteAccount(req.params.id);
  const folder = path.join(__dirname, 'sessions', account.auth_folder);
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch(e) {}
  res.json({ success: true });
});

app.post('/api/accounts/:id/reconnect', async (req, res) => {
  const account = getAccount(req.params.id);
  if (!account || account.user_id !== req.session.userId) return res.status(403).json({ error: 'Not yours' });
  await stopAccountSocket(req.params.id);
  const result = await startAccountSocket(req.params.id);
  if (result && result.pairingCode) res.json({ success: true, pairingCode: result.pairingCode });
  else res.json({ success: true });
});

// =====================================================
// 🚀 START SERVER
// =====================================================
(async () => {
  await initDB();
  if (!fs.existsSync(path.join(__dirname, 'sessions'))) fs.mkdirSync(path.join(__dirname, 'sessions'));
  app.listen(PORT, () => {
    console.log(`\n🚀 Panel running at http://localhost:${PORT}`);
    console.log(`👑 Owner: @anynomuospapa`);
    console.log(`📱 Add your WhatsApp number from Dashboard!\n`);
  });
})();

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Error:', err.message);
});