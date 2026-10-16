// cmdBuilder.js
const fs = require('fs');
const path = require('path');

const WORKER_FILE = path.join(__dirname, 'attackWorker.js');
const DYNAMIC_FILE = path.join(__dirname, 'dynamicCommands.json');

// ==================== DYNAMIC STORAGE ====================
function loadDynamic() {
    try {
        if (!fs.existsSync(DYNAMIC_FILE)) {
            fs.writeFileSync(DYNAMIC_FILE, JSON.stringify({ commands: [], loops: {} }, null, 2));
            return { commands: [], loops: {} };
        }
        const content = fs.readFileSync(DYNAMIC_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return { commands: parsed.commands || [], loops: parsed.loops || {} };
    } catch (e) {
        return { commands: [], loops: {} };
    }
}

function saveDynamic(data) {
    try {
        fs.writeFileSync(DYNAMIC_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (e) { return false; }
}

// ==================== VALIDATION ====================
function validateCode(code) {
    try {
        new Function(code);
        return { valid: true };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

function extractFunctionName(code) {
    const match = code.match(/async\s+function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    if (match) return match[1];
    const arrowMatch = code.match(/(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*async/);
    if (arrowMatch) return arrowMatch[1];
    return null;
}

// ==================== LOOP ====================
function getLoopCount(cmdName, defaultCount) {
    const dynamic = loadDynamic();
    if (dynamic.loops[cmdName] !== undefined) return dynamic.loops[cmdName];
    return defaultCount;
}

// ==================== INSERT FUNCTION INTO WORKER ====================
function insertFunctionIntoWorker(code, fnName) {
    try {
        let workerContent = fs.readFileSync(WORKER_FILE, 'utf8');
        const marker = 'run();';
        const markerIndex = workerContent.lastIndexOf(marker);
        if (markerIndex === -1) return { success: false, error: 'Cannot find run(); marker' };
        const insertion = `\n// ==================== CUSTOM BUG: ${fnName} ====================\n${code}\n\n`;
        workerContent = workerContent.slice(0, markerIndex) + insertion + workerContent.slice(markerIndex);
        fs.writeFileSync(WORKER_FILE, workerContent);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ==================== INSERT ATTACK TYPE INTO RUN ====================
function insertAttackTypeIntoRun(attackType, fnName) {
    try {
        let workerContent = fs.readFileSync(WORKER_FILE, 'utf8');
        const searchPattern = /(\} else if \(attackType === '[^']+'\) \{\s*await [^;]+;\s*\})/g;
        const matches = [...workerContent.matchAll(searchPattern)];
        if (matches.length === 0) return { success: false, error: 'Cannot find attackType chain' };
        const lastMatch = matches[matches.length - 1];
        const insertPos = lastMatch.index + lastMatch[0].length;
        const newBranch = `\n                else if (attackType === '${attackType}') {\n                    await ${fnName}(sock, targetJid);\n                }`;
        workerContent = workerContent.slice(0, insertPos) + newBranch + workerContent.slice(insertPos);
        fs.writeFileSync(WORKER_FILE, workerContent);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ==================== ADD NEW COMMAND ====================
function addNewCommand(jsCode, cmdName, platform, count) {
    const validation = validateCode(jsCode);
    if (!validation.valid) return { success: false, step: 'validation', error: `Syntax error: ${validation.error}` };
    const fnName = extractFunctionName(jsCode);
    if (!fnName) return { success: false, step: 'extract', error: 'Cannot find function name' };
    const dynamic = loadDynamic();
    if (dynamic.commands.find(c => c.cmdName === cmdName)) return { success: false, step: 'duplicate', error: `Command /${cmdName} already exists` };
    if (dynamic.commands.find(c => c.fnName === fnName)) return { success: false, step: 'duplicate', error: `Function "${fnName}" already exists` };
    const step1 = insertFunctionIntoWorker(jsCode, fnName);
    if (!step1.success) return { success: false, step: 'insert_function', error: step1.error };
    const attackType = cmdName.toLowerCase();
    const step2 = insertAttackTypeIntoRun(attackType, fnName);
    if (!step2.success) return { success: false, step: 'insert_attacktype', error: step2.error };
    dynamic.commands.push({ cmdName, attackType, fnName, platform, defaultCount: count, addedAt: Date.now() });
    dynamic.loops[cmdName] = count;
    saveDynamic(dynamic);
    return { success: true, fnName, attackType, cmdName, count, platform };
}

// ==================== REMOVE COMMAND ====================
function removeCommand(cmdName) {
    try {
        const dynamic = loadDynamic();
        const cmdInfo = dynamic.commands.find(c => c.cmdName === cmdName);
        if (!cmdInfo) return { success: false, error: `Command /${cmdName} not found` };
        const { attackType, fnName } = cmdInfo;
        let workerContent = fs.readFileSync(WORKER_FILE, 'utf8');
        const branchRegex = new RegExp(`\\s*else if \\(attackType === '${attackType}'\\) \\{\\s*await [a-zA-Z_][a-zA-Z0-9_]*\\(sock, targetJid\\);\\s*\\}`, 'g');
        workerContent = workerContent.replace(branchRegex, '');
        const fnRegex = new RegExp(`\\n// ==================== CUSTOM BUG: ${fnName} ====================[\\s\\S]*?\\n\\}\\n`, 'g');
        workerContent = workerContent.replace(fnRegex, '\n');
        fs.writeFileSync(WORKER_FILE, workerContent);
        dynamic.commands = dynamic.commands.filter(c => c.cmdName !== cmdName);
        delete dynamic.loops[cmdName];
        saveDynamic(dynamic);
        return { success: true, cmdName, attackType, count: cmdInfo.defaultCount, platform: cmdInfo.platform };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ==================== CHANGE LOOP ====================
function changeLoop(cmdName, newCount) {
    try {
        const dynamic = loadDynamic();
        const builtIn = ['ioshard', 'delayhard', 'freeze', 'fcnoclick', 'blankios'];
        const isDynamic = dynamic.commands.find(c => c.cmdName === cmdName);
        const isBuiltIn = builtIn.includes(cmdName);
        if (!isDynamic && !isBuiltIn) return { success: false, error: `Command /${cmdName} not found` };
        const oldCount = dynamic.loops[cmdName] !== undefined ? dynamic.loops[cmdName] : (isDynamic ? isDynamic.defaultCount : null);
        dynamic.loops[cmdName] = newCount;
        saveDynamic(dynamic);
        return { success: true, cmdName, oldCount, newCount };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ==================== GET ALL ====================
function getAllCommandsWithBuiltIn() {
    const dynamic = loadDynamic();
    const builtIn = [
        { cmdName: 'ioshard', attackType: 'ios', platform: 'ios', defaultCount: 20, isBuiltIn: true },
        { cmdName: 'delayhard', attackType: 'forcevideo', platform: 'android', defaultCount: 50, isBuiltIn: true },
        { cmdName: 'freeze', attackType: 'fcnoclick', platform: 'android', defaultCount: 50, isBuiltIn: true },
        { cmdName: 'fcnoclick', attackType: 'forceinvis', platform: 'android', defaultCount: 50, isBuiltIn: true },
		{ cmdName: 'blankios', attackType: 'blankios', platform: 'ios', defaultCount: 30, isBuiltIn: true }
    ];
    const all = [];
    for (const b of builtIn) {
        const loop = dynamic.loops[b.cmdName] !== undefined ? dynamic.loops[b.cmdName] : b.defaultCount;
        all.push({ ...b, count: loop });
    }
    for (const d of dynamic.commands) {
        const loop = dynamic.loops[d.cmdName] !== undefined ? dynamic.loops[d.cmdName] : d.defaultCount;
        all.push({ ...d, count: loop, isBuiltIn: false });
    }
    return all;
}

function getAllCommands() {
    const dynamic = loadDynamic();
    return dynamic.commands;
}

module.exports = {
    addNewCommand,
    removeCommand,
    changeLoop,
    getAllCommands,
    getAllCommandsWithBuiltIn,
    getLoopCount,
    loadDynamic,
    saveDynamic,
    validateCode,
    extractFunctionName
};