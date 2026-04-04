const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('./config.js');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const useSupabaseAuthState = require('./supabaseAuth');
const express = require('express');

// --- HIDE LIBSIGNAL NOISE ---
const originalLog = console.log;
const originalError = console.error;
const noiseWords = [
    'Session error', 'Bad MAC', 'Closing session', 'prekey bundle', 'Failed to decrypt',
    'Decrypted message with closed session', 'Closing open session', 'Removing old closed session',
    '_chains', 'registrationId', 'currentRatchet', 'indexInfo', 'ephemeralKeyPair',
    'lastRemoteEphemeralKey', 'previousCounter', 'rootKey', 'baseKey', 'remoteIdentityKey'
];
function isNoise(args) {
    try {
        const str = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        return noiseWords.some(w => str.includes(w));
    } catch(e) { return false; }
}
console.log = function (...args) { if(isNoise(args)) return; originalLog.apply(console, args); };
console.error = function (...args) { if(isNoise(args)) return; originalError.apply(console, args); };

// Setup memory cache to avoid performance/duplicate issues internally for Baileys
const msgRetryCounterCache = new NodeCache();

// --- STATE & CACHE ---
const reactedStatusCache = new Set();
const CACHE_MAX_SIZE = 1000;
const botStartTime = Math.floor(Date.now() / 1000);

let isActivelyLiking = true; 
let fixedEmoji = null; 
let isViewOnly = false; 
let activeSocket = null;

// Helper to check if a number is allowed based on whitelist and blacklist
function isAllowed(jid) {
    if (config.blacklist && config.blacklist.length > 0) {
        if (config.blacklist.includes(jid)) return false;
    }
    if (config.whitelist && config.whitelist.length > 0) {
        return config.whitelist.includes(jid);
    }
    return true;
}

async function connectToWhatsApp() {
    const supabase = createClient(config.supabaseUrl, config.supabaseKey);

    console.log('[INFO] Loading WhatsApp Session from Supabase Cloud...');
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_auth');
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[INFO] Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

    const logger = pino({ level: 'silent' });

    const socket = makeWASocket({
        version,
        logger,
        printQRInTerminal: !config.usePairingCode,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 120_000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5
    });

    activeSocket = socket;

    // Handle pairing code
    if (config.usePairingCode && !state.creds.me) {
        if (!config.phoneNumber || config.phoneNumber === "1234567890") {
            console.error('[ERROR] phone number issues in config.js');
            process.exit(1);
        }
        
        setTimeout(async () => {
            try {
                const code = await socket.requestPairingCode(config.phoneNumber);
                console.log(`\n========================================`);
                console.log(`[ACTION REQUIRED] Your Pairing Code: ${code}`);
                console.log(`========================================\n`);
            } catch (err) {
                console.error('[ERROR] Failed to request pairing code:', err);
            }
        }, 3000);
    }

    socket.ev.on('creds.update', saveCreds);

    let reconnectAttempts = 0;

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isConflict = statusCode === 440;
            const is401 = statusCode === 401;
            const shouldReconnect = !isLoggedOut;

            console.log('[INFO] Connection closed, code:', statusCode, '| Reconnecting:', shouldReconnect);

            if (shouldReconnect) {
                reconnectAttempts++;
                let baseDelay = 10_000;
                if (isConflict) baseDelay = 30_000;
                if (is401) baseDelay = 5_000;
                const backoff = Math.min(baseDelay * Math.pow(1.5, reconnectAttempts - 1), 120_000);
                const reason = isConflict ? ' (conflit)' : is401 ? ' (invalide, retry)' : '';
                console.log(`[INFO] Reconnexion dans ${Math.round(backoff / 1000)}s (tentative #${reconnectAttempts})${reason}...`);
                setTimeout(() => connectToWhatsApp(), backoff);
            } else {
                console.log('[INFO] Session déconnectée (loggedOut). Nettoyez Supabase.');
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0;
            console.log('[INFO] Successfully connected to WhatsApp!');
            const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            const welcomeMsg = `╭───〔 🤖 *JOSIHACK BOT* 〕───⬣\n` +
                               `│ ߷ *Etat*       ➜ Connecté ✅\n` +
                               `│ ߷ *Mode*       ➜ Auto-Like\n` +
                               `╰──────────────⬣`;
            console.log(welcomeMsg);
            try {
                await socket.sendMessage(botJid, { text: welcomeMsg });
                console.log('[INFO] Système synchronisé.');
            } catch(e) {}
        }
    });

    socket.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;
            
            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant; 

            // --- ANTI VUE UNIQUE ---
            let isViewOnce = false;
            let messageTypeStr = "Media";
            const viewOnceKey = Object.keys(msg.message || {}).find(k => k.toLowerCase().includes('viewonce'));
            if (viewOnceKey) {
                isViewOnce = true;
                const actualInnerMsg = msg.message[viewOnceKey]?.message;
                if (actualInnerMsg) messageTypeStr = Object.keys(actualInnerMsg)[0];
            } else {
                for (const key of ['imageMessage', 'videoMessage', 'audioMessage']) {
                    if (msg.message?.[key]?.viewOnce) {
                        isViewOnce = true;
                        messageTypeStr = key;
                        break;
                    }
                }
            }

            if (isViewOnce) {
                try {
                    const senderPhoneNumber = (participantJid || remoteJid).split('@')[0];
                    const ownerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                    const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhoneNumber}`;
                    if (messageTypeStr.includes('image')) await socket.sendMessage(ownerJid, { image: buffer, caption });
                    else if (messageTypeStr.includes('video')) await socket.sendMessage(ownerJid, { video: buffer, caption });
                    else if (messageTypeStr.includes('audio')) await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                } catch (e) { console.error("[ERROR] Anti-View-Once failed"); }
            }

            // --- FILTERS ---
            if (msg.messageTimestamp && msg.messageTimestamp < botStartTime) return;
            const isStatus = remoteJid === 'status@broadcast';
            if (!isStatus && m.type !== 'notify' && m.type !== 'append') return;

            const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const textLower = textContent.trim().toLowerCase();

            // --- COMMANDS ---
            if (msg.key.fromMe) {
                const targetChat = isStatus ? socket.user.id.split(':')[0] + '@s.whatsapp.net' : remoteJid;

                if (textLower.startsWith('?josistatus ')) {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') { isActivelyLiking = true; isViewOnly = false; }
                    else if (arg === 'off') isActivelyLiking = false;
                    await socket.sendMessage(targetChat, { text: `[SYSTEM] Likes Auto : ${isActivelyLiking ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                } else if (textLower.startsWith('?josiview')) {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') { isViewOnly = true; isActivelyLiking = false; }
                    else if (arg === 'off') isViewOnly = false;
                    else isViewOnly = !isViewOnly;
                    if (isViewOnly) isActivelyLiking = false;
                    await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ${isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                } else if (textLower.startsWith('?josistatusuni')) {
                    const arg = textLower.split(/\s+/)[1];
                    if (!arg) {
                        await socket.sendMessage(targetChat, { text: `?josistatusuni <emoji> ou random` }, { quoted: msg });
                    } else if (arg === 'random') {
                        fixedEmoji = null;
                        await socket.sendMessage(targetChat, { text: `✅ Mode Aléatoire 🎲` }, { quoted: msg });
                    } else {
                        fixedEmoji = textContent.split(/\s+/)[1];
                        isActivelyLiking = true; isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `✅ Emoji fixé : ${fixedEmoji}` }, { quoted: msg });
                    }
                } else if (textLower === '?menu') {
                    const menuText = `🤖 *MENU JOSIHACK*\n\n` +
                                     `*STATUS*\n` +
                                     `- ?josistatus on/off\n` +
                                     `- ?josiview on/off\n` +
                                     `- ?josistatusuni <emoji>/random\n\n` +
                                     `*VIEW ONCE*\n` +
                                     `- ?vv (reply) -> vers chat actuel\n` +
                                     `- ?vv2 (reply) -> vers mon inbox\n` +
                                     `- ?ok (reply) -> vers admin inbox`;
                    await socket.sendMessage(targetChat, { text: menuText }, { quoted: msg });
                }

                // --- DOWNLOADER COMMANDS ---
                const vCommands = ['?vv', '?vv2', '?ok'];
                if (vCommands.includes(textLower)) {
                    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) return await socket.sendMessage(remoteJid, { text: "❌ Répondez à une Vue Unique." }, { quoted: msg });

                    let mediaMsg = quoted;
                    let type = Object.keys(quoted)[0];
                    if (['viewOnceMessageV2', 'viewOnceMessage', 'viewOnceMessageV2Extension'].includes(type)) {
                        mediaMsg = quoted[type].message;
                        type = Object.keys(mediaMsg)[0];
                    }

                    try {
                        const buffer = await downloadMediaMessage({ message: mediaMsg }, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                        const ownerJid = config.ownerNumber + '@s.whatsapp.net';
                        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';

                        let targetJid = remoteJid;
                        if (textLower === '?vv2') targetJid = botJid;
                        if (textLower === '?ok') targetJid = ownerJid;

                        if (type === 'imageMessage') await socket.sendMessage(targetJid, { image: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'videoMessage') await socket.sendMessage(targetJid, { video: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'audioMessage') await socket.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                    } catch (e) { await socket.sendMessage(remoteJid, { text: "❌ Erreur de téléchargement." }, { quoted: msg }); }
                }
            }

            // --- STATUS HANDLING ---
            if (isStatus) {
                if (!isActivelyLiking && !isViewOnly) return;
                const statusId = msg.key.id;
                if (reactedStatusCache.has(statusId)) return;
                
                reactedStatusCache.add(statusId);
                if (reactedStatusCache.size > CACHE_MAX_SIZE) reactedStatusCache.delete(reactedStatusCache.values().next().value);

                let senderJid = participantJid || msg.key.participant;
                if (msg.key.fromMe) {
                    if (!config.likeMyOwnStatus) return;
                    senderJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                }
                
                // On vérifie les listes blanche/noire uniquement pour les autres contacts
                if (!senderJid || (!msg.key.fromMe && !isAllowed(senderJid))) return;

                const senderPhoneNumber = senderJid.split('@')[0];
                const emojis = config.reactionEmojis || ["❤️"];
                const reactionEmojiToUse = fixedEmoji ? fixedEmoji : emojis[Math.floor(Math.random() * emojis.length)];

                const delayMs = Math.floor(Math.random() * 4000) + 2000;
                setTimeout(async () => {
                    try {
                        try { await socket.readMessages([msg.key]); } catch(e) {}
                        if (isViewOnly) {
                            console.log(`[VIEW] Statut de +${senderPhoneNumber} vu silencieusement`);
                            return;
                        }
                        
                        // MÉTHODE DIRECTE (QUI MARCHAIT DANS LE PREMIER ZIP)
                        await socket.sendMessage(senderJid, { react: { text: reactionEmojiToUse, key: msg.key } });
                        console.log(`[LIKE] +${senderPhoneNumber} avec ${reactionEmojiToUse}`);

                        if (config.autoReplyMessage?.trim()) {
                            await socket.sendMessage(senderJid, { text: config.autoReplyMessage });
                        }
                    } catch (err) { console.error(`[ERROR] Likant +${senderPhoneNumber}:`, err.message); }
                }, delayMs);
            }
        } catch (error) { console.error('[ERROR] Upsert loop:', error.message); }
    });
}

// --- EXPRESS SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Port ${PORT}`));

connectToWhatsApp().catch(err => console.log("[FATAL]", err));

// --- SHUTDOWN HANDLING ---
process.on('SIGTERM', async () => {
    console.log('[SIGTERM] Closing WebSocket...');
    try { if (activeSocket) activeSocket.ws.close(); } catch(e) {}
    process.exit(0);
});

process.on('SIGINT', async () => {
    try { if (activeSocket) activeSocket.ws.close(); } catch(e) {}
    process.exit(0);
});

// --- KEEP ALIVE ---
const RENDER_URL = "https://josihackbot.onrender.com";
setInterval(async () => {
    try { await fetch(RENDER_URL); } catch (e) {}
}, 5 * 60 * 1000);
