const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const initSqlJs = require('sql.js');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================
// 🔑 TELEGRAM BOT TOKEN
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN || '8765838668:AAFLZNRe4bzMBramyFLOZp0r9uog5tabm0M';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 Telegram bot is polling...');

// ============================================================
// 🗄️ DATABASE
// ============================================================
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
      username TEXT UNIQUE,
      password TEXT,
      telegram_id TEXT UNIQUE NOT NULL,
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
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, phone)
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

// ---------- Database Helpers ----------
function getUserByTelegramId(telegramId) {
  const stmt = db.prepare('SELECT * FROM users WHERE telegram_id = ?');
  const result = stmt.get(String(telegramId));
  stmt.free();
  return result;
}

function createUserForTelegram(telegramId, username) {
  const uname = username || `user_${telegramId}`;
  db.run('INSERT INTO users (telegram_id, username) VALUES (?, ?)', [String(telegramId), uname]);
  saveDB();
  return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
}

function getAccountsByTelegramId(telegramId) {
  const user = getUserByTelegramId(telegramId);
  if (!user) return [];
  const stmt = db.prepare('SELECT * FROM accounts WHERE user_id = ?');
  const rows = stmt.all(user.id);
  stmt.free();
  return rows;
}

function createAccountForTelegram(telegramId, phone, authFolder, replyType = 'text', replyContent = '', replyCaption = '') {
  const user = getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found');
  // Check for duplicate
  const check = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND phone = ?');
  const existing = check.get(user.id, phone);
  check.free();
  if (existing) throw new Error('This WhatsApp number is already added.');
  const content = replyContent || '🙏 नमस्ते! यह ऑटोमेटिक रिप्लाई है।';
  db.run(
    'INSERT INTO accounts (user_id, phone, auth_folder, reply_type, reply_content, reply_caption) VALUES (?, ?, ?, ?, ?, ?)',
    [user.id, phone, authFolder, replyType, content, replyCaption]
  );
  saveDB();
  return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
}

function updateAccountReplyByAccountId(accountId, type, content, caption) {
  db.run('UPDATE accounts SET reply_type = ?, reply_content = ?, reply_caption = ? WHERE id = ?', [type, content, caption, accountId]);
  saveDB();
}

function updateAccountStatusByAccountId(accountId, status) {
  db.run('UPDATE accounts SET status = ? WHERE id = ?', [status, accountId]);
  saveDB();
}

function deleteAccountByAccountId(accountId) {
  db.run('DELETE FROM accounts WHERE id = ?', [accountId]);
  saveDB();
}

function getAccountById(accountId) {
  const stmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const result = stmt.get(accountId);
  stmt.free();
  return result;
}

// ============================================================
// 📱 WHATSAPP MANAGER
// ============================================================
const activeSockets = {};

async function startAccountSocket(accountId) {
  try {
    const account = getAccountById(accountId);
    if (!account) throw new Error('Account not found');

    const authFolder = path.join(__dirname, 'sessions', `telegram_${account.user_id}`, `acc_${accountId}`);
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
        console.error(`❌ [${accountId}] Code Error:`, err.message);
        updateAccountStatusByAccountId(accountId, 'error');
        throw new Error(`Failed to get pairing code: ${err.message}`);
      }
    } else {
      console.log(`♻️ [${accountId}] Session restored.`);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        updateAccountStatusByAccountId(accountId, 'connected');
        console.log(`🟢 [${accountId}] Online.`);
      }
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        updateAccountStatusByAccountId(accountId, 'disconnected');
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

    // Auto-reply logic
    sock.ev.on('messages.upsert', async (m) => {
      const messages = m.messages;
      if (!messages || messages.length === 0) return;
      const freshAccount = getAccountById(accountId);
      if (!freshAccount) return;

      const processMessage = async (msg) => {
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
        const sender = msg.key.remoteJid;
        try {
          const type = freshAccount.reply_type || 'text';
          const content = freshAccount.reply_content || '🙏 नमस्ते!';
          const caption = freshAccount.reply_caption || '';
          if (type === 'text' || type === 'link') {
            await sock.sendMessage(sender, { text: type === 'link' ? `🔗 ${content}` : content });
          } else if (type === 'document' || type === 'apk') {
            if (fs.existsSync(content)) {
              await sock.sendMessage(sender, {
                document: fs.readFileSync(content),
                mimetype: 'application/vnd.android.package-archive',
                fileName: path.basename(content),
                caption: caption || '📦 Here is your file!'
              });
            } else {
              await sock.sendMessage(sender, { text: '❌ File not found on server!' });
            }
          } else if (type === 'audio' || type === 'voice') {
            if (fs.existsSync(content)) {
              await sock.sendMessage(sender, {
                audio: fs.readFileSync(content),
                mimetype: 'audio/ogg',
                ptt: true
              });
            } else {
              await sock.sendMessage(sender, { text: '❌ Audio file not found!' });
            }
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
  } catch (err) {
    console.error('❌ startAccountSocket error:', err.stack);
    throw err;
  }
}

async function stopAccountSocket(accountId) {
  if (activeSockets[accountId]) {
    try { await activeSockets[accountId].ws?.close(); } catch (e) {}
    delete activeSockets[accountId];
    updateAccountStatusByAccountId(accountId, 'disconnected');
    return true;
  }
  return false;
}

// ============================================================
// 🤖 TELEGRAM BOT – MAIN MENU & COMMANDS
// ============================================================
async function sendMainMenu(chatId) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Add WhatsApp Account', callback_data: 'add_account' }],
        [{ text: '⚙️ Set Reply Type', callback_data: 'set_reply' }],
        [{ text: '🔍 Test Reply Output', callback_data: 'test_reply' }],
        [{ text: '📋 List Accounts', callback_data: 'list_accounts' }],
        [{ text: '🗑️ Remove Account', callback_data: 'remove_account' }],
        [{ text: 'ℹ️ Status', callback_data: 'status' }]
      ]
    }
  };
  await bot.sendMessage(chatId, '🤖 *WhatsApp Bot Control Panel* – choose an action:', { ...opts, parse_mode: 'Markdown' });
}

const userTemp = {};

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  let user = getUserByTelegramId(chatId);
  if (!user) {
    const username = from.username || from.first_name || `user_${chatId}`;
    createUserForTelegram(chatId, username);
    user = getUserByTelegramId(chatId);
    await bot.sendMessage(chatId, `👋 Welcome! You are now registered.`);
  }
  await sendMainMenu(chatId);
});

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data === 'add_account') {
    await bot.sendMessage(chatId, '📱 Please enter your WhatsApp number with country code (e.g., `919876543210`):', { parse_mode: 'Markdown' });
    userTemp[chatId] = { action: 'awaiting_phone' };
  }
  else if (data === 'set_reply') {
    const opts = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Text', callback_data: 'reply_text' }],
          [{ text: '🔗 Link', callback_data: 'reply_link' }],
          [{ text: '📦 APK/File', callback_data: 'reply_apk' }],
          [{ text: '🎵 Voice Note', callback_data: 'reply_voice' }],
          [{ text: '🔙 Back', callback_data: 'back_main' }]
        ]
      }
    };
    await bot.sendMessage(chatId, 'Choose reply type:', opts);
  }
  else if (data.startsWith('reply_')) {
    const type = data.replace('reply_', '');
    userTemp[chatId] = { action: 'awaiting_reply_content', reply_type: type };
    await bot.sendMessage(chatId, `✏️ Enter the ${type} content:\n- For text/link: just send the message\n- For APK/Voice: send the file path on server (e.g., /app/my.apk)`);
  }
  else if (data === 'test_reply') {
    const accounts = getAccountsByTelegramId(chatId);
    if (accounts.length === 0) {
      await bot.sendMessage(chatId, '❌ No WhatsApp account found. Add one first.');
      return;
    }
    for (const acc of accounts) {
      const type = acc.reply_type;
      const content = acc.reply_content;
      const caption = acc.reply_caption || '';
      let message = `📤 *Test Reply (Account: ${acc.phone})*\nType: ${type}\n`;
      if (type === 'text' || type === 'link') {
        message += `Content: ${content}`;
      } else if (type === 'document' || type === 'apk') {
        message += `File: ${path.basename(content)}\nCaption: ${caption}`;
      } else if (type === 'audio' || type === 'voice') {
        message += `Audio file: ${path.basename(content)}`;
      }
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      if ((type === 'document' || type === 'apk') && fs.existsSync(content)) {
        await bot.sendDocument(chatId, content, { caption: caption || '📦 Preview' });
      } else if ((type === 'audio' || type === 'voice') && fs.existsSync(content)) {
        await bot.sendAudio(chatId, content, { caption: '🎵 Preview' });
      }
    }
    await sendMainMenu(chatId);
  }
  else if (data === 'list_accounts') {
    const accounts = getAccountsByTelegramId(chatId);
    if (accounts.length === 0) {
      await bot.sendMessage(chatId, '📭 No accounts added yet.');
    } else {
      let list = '📋 *Your WhatsApp Accounts:*\n';
      accounts.forEach((acc, idx) => {
        list += `${idx+1}. ${acc.phone} – ${acc.status}\n`;
      });
      await bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    }
    await sendMainMenu(chatId);
  }
  else if (data === 'remove_account') {
    const accounts = getAccountsByTelegramId(chatId);
    if (accounts.length === 0) {
      await bot.sendMessage(chatId, '❌ No accounts to remove.');
      return;
    }
    const keyboard = accounts.map(acc => ([{ text: `${acc.phone} (${acc.status})`, callback_data: `remove_${acc.id}` }]));
    keyboard.push([{ text: '🔙 Back', callback_data: 'back_main' }]);
    await bot.sendMessage(chatId, 'Select account to remove:', { reply_markup: { inline_keyboard: keyboard } });
  }
  else if (data.startsWith('remove_')) {
    const accId = parseInt(data.split('_')[1]);
    const acc = getAccountById(accId);
    if (!acc) {
      await bot.sendMessage(chatId, '❌ Account not found.');
      return;
    }
    await stopAccountSocket(accId);
    deleteAccountByAccountId(accId);
    const folder = path.join(__dirname, 'sessions', `telegram_${acc.user_id}`, `acc_${accId}`);
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch(e) {}
    await bot.sendMessage(chatId, `🗑️ Account ${acc.phone} removed successfully.`);
    await sendMainMenu(chatId);
  }
  else if (data === 'status') {
    const accounts = getAccountsByTelegramId(chatId);
    if (accounts.length === 0) {
      await bot.sendMessage(chatId, 'No accounts.');
    } else {
      let statusText = '📊 *Status*\n';
      accounts.forEach(acc => {
        statusText += `${acc.phone}: ${acc.status}\n`;
      });
      await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    }
    await sendMainMenu(chatId);
  }
  else if (data === 'back_main') {
    await sendMainMenu(chatId);
  }
});

// ---------- Text input handlers ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  // Adding account
  if (userTemp[chatId] && userTemp[chatId].action === 'awaiting_phone') {
    let phone = text.replace(/[^0-9]/g, '');
    if (!phone || phone.length < 10) {
      await bot.sendMessage(chatId, '❌ Invalid phone number. Please enter digits only (e.g., 919876543210).');
      return;
    }
    const processingMsg = await bot.sendMessage(chatId, '⏳ Adding account, please wait...');
    const authFolder = `telegram_${chatId}/acc_${Date.now()}`;
    try {
      const result = createAccountForTelegram(chatId, phone, authFolder, 'text', '🙏 नमस्ते! यह ऑटोमेटिक रिप्लाई है।', '');
      const accountId = result.lastInsertRowid;
      const { pairingCode } = await startAccountSocket(accountId);
      await bot.editMessageText(
        `✅ Account added!\n📱 Phone: ${phone}\n🔑 Pairing Code: \`${pairingCode || '---'}\`\n\nEnter this code in WhatsApp → Linked Devices → Link with phone number.`,
        { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Error adding account:', err.stack);
      await bot.editMessageText(`❌ Failed to add account: ${err.message || err}`, { chat_id: chatId, message_id: processingMsg.message_id });
    }
    delete userTemp[chatId];
    await sendMainMenu(chatId);
    return;
  }

  // Setting reply content
  if (userTemp[chatId] && userTemp[chatId].action === 'awaiting_reply_content') {
    const type = userTemp[chatId].reply_type;
    const content = text.trim();
    if (type === 'apk' || type === 'voice' || type === 'document' || type === 'audio') {
      userTemp[chatId] = { action: 'awaiting_caption', reply_type: type, content: content };
      await bot.sendMessage(chatId, '📝 Enter a caption (optional) or type "skip" to skip:');
    } else {
      const accounts = getAccountsByTelegramId(chatId);
      if (accounts.length === 0) {
        await bot.sendMessage(chatId, '❌ No account to update. Add one first.');
        delete userTemp[chatId];
        await sendMainMenu(chatId);
        return;
      }
      const targetAccount = accounts.find(a => a.status === 'connected') || accounts[0];
      updateAccountReplyByAccountId(targetAccount.id, type, content, '');
      await bot.sendMessage(chatId, `✅ Reply updated for ${targetAccount.phone}.`);
      delete userTemp[chatId];
      await sendMainMenu(chatId);
    }
    return;
  }

  if (userTemp[chatId] && userTemp[chatId].action === 'awaiting_caption') {
    const caption = text.trim() === 'skip' ? '' : text.trim();
    const type = userTemp[chatId].reply_type;
    const content = userTemp[chatId].content;
    const accounts = getAccountsByTelegramId(chatId);
    if (accounts.length === 0) {
      await bot.sendMessage(chatId, '❌ No account to update.');
      delete userTemp[chatId];
      await sendMainMenu(chatId);
      return;
    }
    const targetAccount = accounts.find(a => a.status === 'connected') || accounts[0];
    updateAccountReplyByAccountId(targetAccount.id, type, content, caption);
    await bot.sendMessage(chatId, `✅ Reply updated for ${targetAccount.phone} with caption.`);
    delete userTemp[chatId];
    await sendMainMenu(chatId);
    return;
  }
});

// ============================================================
// 🌐 Optional Web Dashboard
// ============================================================
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
app.get('/', (req, res) => res.send('<h1>🤖 WhatsApp Bot is running</h1><p>Manage everything via Telegram.</p>'));
app.get('/health', (req, res) => res.send('OK'));

(async () => {
  await initDB();
  if (!fs.existsSync(path.join(__dirname, 'sessions'))) fs.mkdirSync(path.join(__dirname, 'sessions'));
  app.listen(PORT, () => {
    console.log(`🚀 Web dashboard (optional) at http://localhost:${PORT}`);
    console.log('🤖 Telegram bot is running. Send /start to begin.');
  });
})();

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Error:', err.stack);
});