// pairWorker.js
const { parentPort, workerData } = require('worker_threads');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const SILENT_LOGGER = pino({ level: 'silent' });

async function run() {
    const { number, userId } = workerData;

    const authPath = `./Love/auth/${userId}/${number}`;
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    let sock = null;
    let resolved = false;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        sock = makeWASocket({
            logger: SILENT_LOGGER,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, SILENT_LOGGER)
            },
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);

            let code;
            let attempts = 0;
            while (attempts < 3 && !code) {
                try {
                    code = await sock.requestPairingCode(number);
                } catch (e) {
                    attempts++;
                    await delay(2000);
                }
            }

            if (!code) throw new Error('Failed to get pair code');

            const formatted = code.match(/.{1,4}/g).join('-');
            parentPort.postMessage({ type: 'code', code: formatted });

            sock.ev.on('connection.update', (update) => {
                if (update.connection === 'open') {
                    resolved = true;
                    saveCreds();
                    parentPort.postMessage({ type: 'success' });
                }
                if (update.connection === 'close') {
                    if (!resolved) {
                        parentPort.postMessage({ type: 'error', error: 'Connection closed' });
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            setTimeout(() => {
                if (!resolved) {
                    parentPort.postMessage({ type: 'error', error: 'Pairing timeout' });
                }
            }, 45000);
        } else {
            parentPort.postMessage({ type: 'success', alreadyPaired: true });
        }
    } catch (e) {
        parentPort.postMessage({ type: 'error', error: e.message });
    }
}

run();