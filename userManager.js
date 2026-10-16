// userManager.js
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
const DB_FILE = path.join(__dirname, 'Love', 'data.json');

// ==================== LOAD / SAVE ====================
function loadUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) {
            fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
            return { users: [] };
        }
        const content = fs.readFileSync(USERS_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return { users: parsed.users || [] };
    } catch (e) {
        return { users: [] };
    }
}

function saveUsers(data) {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (e) { return false; }
}

function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initial = { state: 0, tokens: [], premium: [], resellers: [] };
            fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
            return initial;
        }
        const content = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return { state: 0, tokens: parsed, premium: [], resellers: [] };
        return {
            state: typeof parsed.state === 'number' ? parsed.state : 0,
            tokens: parsed.tokens || [],
            premium: parsed.premium || [],
            resellers: parsed.resellers || []
        };
    } catch (e) {
        return { state: 0, tokens: [], premium: [], resellers: [] };
    }
}

function saveDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (e) { return false; }
}

// ==================== USER STATUS ====================
function getUserStatus(userId) {
    const db = loadDB();
    const idStr = userId.toString();
    const config = require('./config');
    if (idStr === config.adminId.toString()) return 'owner';
    if (db.resellers.includes(idStr)) return 'reseller';
    if (db.premium.includes(idStr)) return 'premium';
    return 'free';
}

// ==================== ADD / UPDATE ====================
function addOrUpdateUser(userInfo) {
    const data = loadUsers();
    const { chatId, userId, name, username, date } = userInfo;
    const existing = data.users.find(u => u.userId === userId.toString());
    const status = getUserStatus(userId);
    if (existing) {
        existing.name = name || existing.name;
        existing.username = username || existing.username;
        existing.lastSeen = date || new Date().toLocaleString();
        existing.status = status;
    } else {
        data.users.push({
            userId: userId.toString(),
            chatId: chatId.toString(),
            name: name || 'Unknown',
            username: username || '',
            firstSeen: date || new Date().toLocaleString(),
            lastSeen: date || new Date().toLocaleString(),
            status: status
        });
    }
    saveUsers(data);
    return data.users.find(u => u.userId === userId.toString());
}

// ==================== GET ====================
function getAllUsers() {
    const data = loadUsers();
    const refreshed = data.users.map(u => ({ ...u, status: getUserStatus(u.userId) }));
    if (JSON.stringify(data.users) !== JSON.stringify(refreshed)) {
        data.users = refreshed;
        saveUsers(data);
    }
    return refreshed;
}

function getUserCount() {
    return loadUsers().users.length;
}

function findUser(userId) {
    const data = loadUsers();
    const user = data.users.find(u => u.userId === userId.toString());
    if (user) user.status = getUserStatus(userId);
    return user;
}

// ==================== BULK IMPORT ====================
function bulkImportUsers(importedUsers) {
    const data = loadUsers();
    const db = loadDB();
    let added = 0, updated = 0, premiumAdded = 0, resellerAdded = 0;
    const config = require('./config');
    for (const imp of importedUsers) {
        if (!imp.userId) continue;
        const idStr = imp.userId.toString();
        const existing = data.users.find(u => u.userId === idStr);
        let status = imp.status || 'free';
        if (idStr === config.adminId.toString()) status = 'owner';
        else if (status === 'premium' || status === 'reseller') {
            if (status === 'premium' && !db.premium.includes(idStr)) { db.premium.push(idStr); premiumAdded++; }
            if (status === 'reseller' && !db.resellers.includes(idStr)) { db.resellers.push(idStr); resellerAdded++; }
        }
        if (existing) {
            existing.name = imp.name || existing.name;
            existing.username = imp.username || existing.username;
            existing.chatId = imp.chatId || existing.chatId;
            existing.lastSeen = imp.lastSeen || existing.lastSeen;
            existing.status = status;
            updated++;
        } else {
            data.users.push({
                userId: idStr,
                chatId: (imp.chatId || imp.userId).toString(),
                name: imp.name || 'Unknown',
                username: imp.username || '',
                firstSeen: imp.firstSeen || new Date().toLocaleString(),
                lastSeen: imp.lastSeen || new Date().toLocaleString(),
                status: status
            });
            added++;
        }
    }
    saveUsers(data);
    saveDB(db);
    return { added, updated, total: data.users.length, premiumAdded, resellerAdded };
}

// ==================== EXPORT ====================
function getExportData() {
    const users = getAllUsers();
    const db = loadDB();
    const config = require('./config');
    const allUserIds = new Set(users.map(u => u.userId));
    const missingUsers = [];
    for (const premiumId of db.premium) {
        if (!allUserIds.has(premiumId)) {
            missingUsers.push({ userId: premiumId, chatId: premiumId, name: 'Unknown (Premium)', username: '', firstSeen: 'Imported from DB', lastSeen: 'Unknown', status: 'premium' });
        }
    }
    for (const resellerId of db.resellers) {
        if (!allUserIds.has(resellerId)) {
            missingUsers.push({ userId: resellerId, chatId: resellerId, name: 'Unknown (Reseller)', username: '', firstSeen: 'Imported from DB', lastSeen: 'Unknown', status: 'reseller' });
        }
    }
    if (!allUserIds.has(config.adminId.toString())) {
        missingUsers.push({ userId: config.adminId.toString(), chatId: config.adminId.toString(), name: 'Owner', username: '', firstSeen: 'Admin', lastSeen: 'Admin', status: 'owner' });
    }
    const finalUsers = [...users, ...missingUsers];
    if (missingUsers.length > 0) {
        const userData = loadUsers();
        for (const mu of missingUsers) {
            if (!userData.users.find(u => u.userId === mu.userId)) userData.users.push(mu);
        }
        saveUsers(userData);
    }
    const stats = {
        total: finalUsers.length,
        owner: finalUsers.filter(u => u.status === 'owner').length,
        premium: finalUsers.filter(u => u.status === 'premium').length,
        reseller: finalUsers.filter(u => u.status === 'reseller').length,
        free: finalUsers.filter(u => u.status === 'free').length
    };
    return { exportDate: new Date().toISOString(), stats, users: finalUsers };
}

// ==================== PARSE TXT ====================
function parseTxtUserList(text) {
    const users = [];
    const seenIds = new Set();
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        const lower = line.toLowerCase();
        if (lower.includes('user list') || lower === 'users' || lower === 'users:' || lower.startsWith('total:') || lower === 'userlist') continue;
        let match = line.match(/(?:@)?([a-zA-Z0-9_]+)\s*\((\d{6,})\)/);
        if (match) {
            const id = match[2];
            if (!seenIds.has(id)) {
                seenIds.add(id);
                users.push({ username: match[1], userId: id });
            }
            continue;
        }
        match = line.match(/^\d+\.?\s*(\d{6,})$/) || line.match(/^(\d{6,})$/);
        if (match) {
            const id = match[1];
            if (!seenIds.has(id)) {
                seenIds.add(id);
                users.push({ username: '', userId: id });
            }
            continue;
        }
        match = line.match(/(\d{6,})/);
        if (match) {
            const id = match[1];
            if (!seenIds.has(id)) {
                seenIds.add(id);
                let name = line.replace(match[0], '').replace(/^\d+\./, '').replace(/[-:]/g, '').trim();
                users.push({ username: name || '', userId: id });
            }
        }
    }
    return users;
}

// ==================== ADD IF NOT EXISTS ====================
function addUserIfNotExists(userInfo) {
    const data = loadUsers();
    const idStr = userInfo.userId.toString();
    const existing = data.users.find(u => u.userId === idStr);
    if (existing) return { added: false, user: existing };
    const newUser = {
        userId: idStr,
        chatId: (userInfo.chatId || userInfo.userId).toString(),
        name: userInfo.name || 'Unknown',
        username: userInfo.username || '',
        firstSeen: new Date().toLocaleString(),
        lastSeen: new Date().toLocaleString(),
        status: 'free'
    };
    data.users.push(newUser);
    saveUsers(data);
    return { added: true, user: newUser };
}

module.exports = {
    loadUsers,
    saveUsers,
    loadDB,
    saveDB,
    addOrUpdateUser,
    addUserIfNotExists,
    getAllUsers,
    getUserCount,
    findUser,
    bulkImportUsers,
    getUserStatus,
    getExportData,
    parseTxtUserList,
    USERS_FILE
};