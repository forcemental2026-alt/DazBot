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
const antiDelete = require('./antidelete.js');
const tagAll = require('./tagall.js');
const screenshot = require('./screenshot.js');
const facebook = require('./facebook.js');
const hostCmd = require('./host.js');
const scheduler = require('./scheduler.js');

// --- HIDE LIBSIGNAL NOISE ---
const originalLog = console.log;
const originalError = console.error;
const noiseWords = [
    'Session error', 'Bad MAC', 'Closing session', 'prekey bundle', 'Failed to decrypt',
    'Decrypted message with closed session', 'Closing open session', 'Removing old closed session',
    '_chains', 'registrationId', 'currentRatchet', 'indexInfo', 'ephemeralKeyPair',
    'lastRemoteEphemeralKey', 'previousCounter', 'rootKey', 'baseKey', 'remoteIdentityKey',
    'SessionEntry', 'pendingPreKey', 'preKeyId', 'signedKeyId'
];
function isNoise(args) {
    try {
        const str = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        return noiseWords.some(w => str.includes(w));
    } catch (e) { return false; }
}
console.log = function (...args) { if (isNoise(args)) return; originalLog.apply(console, args); };
console.error = function (...args) { if (isNoise(args)) return; originalError.apply(console, args); };

// Setup memory cache to avoid performance/duplicate issues internally for Baileys
const msgRetryCounterCache = new NodeCache();

// --- STATE & CACHE ---
const reactedStatusCache = new Set();
const CACHE_MAX_SIZE = 1000;
const botStartTime = Math.floor(Date.now() / 1000);

let isActivelyLiking = true;
let fixedEmoji = null;
let focusJid = null;
let isViewOnly = false;
let activeSocket = null;

// Helper to check if a number is allowed based on whitelist and blacklist
function isAllowed(jid) {
    if (focusJid) {
        return jid.includes(focusJid);
    }
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

    socket.ev.on('messages.upsert', (m) => antiDelete.handleUpsert(socket, m));
    socket.ev.on('messages.update', (update) => {
        // Log de debug pour voir tous les updates qui arrivent
        update.forEach(u => {
            if (u.update.messageStubType || u.update.message?.protocolMessage) {
                console.log(`[DEBUG-UPDATE] ID: ${u.key.id}, Stub: ${u.update.messageStubType}, Protocol: ${!!u.update.message?.protocolMessage}`);
            }
        });
        antiDelete.handleUpdate(socket, update);
    });

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
            scheduler.startScheduler(socket);
            const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            const welcomeMsg = `╭───〔 🤖 *DAZBOT* 〕───⬣\n` +
                `│ ߷ *Etat*       ➜ Connecté ✅\n` +
                `│ ߷ *Mode*       ➜ Auto-Like\n` +
                `╰──────────────⬣`;
            console.log(welcomeMsg);
            try {
                if (config.sendWelcomeMessage) {
                    await socket.sendMessage(botJid, { text: welcomeMsg });
                    console.log('[INFO] Système synchronisé.');
                }
            } catch (e) { }
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
            const isStatus = remoteJid === 'status@broadcast';

            // --- GRACE PERIOD FOR STATUSES (OFFLINE CATCH-UP) ---
            if (msg.messageTimestamp) {
                const msgTime = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.toNumber ? msg.messageTimestamp.toNumber() : Number(msg.messageTimestamp);

                if (isStatus) {
                    // Pour les statuts, on accepte jusqu'à 30 minutes de retard
                    const thirtyMinutes = 30 * 60;
                    if (msgTime < (botStartTime - thirtyMinutes)) {
                        return;
                    }
                    // Log silencieux pour le catch-up des statuts si nécessaire
                } else {
                    // Pour les commandes normales, on ignore STRICTEMENT tout ce qui s'est passé quand le bot était éteint
                    if (msgTime < botStartTime) {
                        console.log(`[FILTER] Ignoré commande ancienne (${msg.key.id}) - Ecart: ${botStartTime - msgTime}s`);
                        return;
                    }
                }
            }

            if (!isStatus && m.type !== 'notify' && m.type !== 'append') return;

            const textContent = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                msg.message.documentMessage?.caption ||
                "";
            const textLower = textContent.trim().toLowerCase();
            const currentPrefix = config.prefix || "?";
            const isCmd = textLower.startsWith(currentPrefix);
            const cmd = isCmd ? textLower.slice(currentPrefix.length).split(/\s+/)[0] : '';
            const textArgs = isCmd ? textContent.slice(textContent.toLowerCase().indexOf(cmd) + cmd.length).trim() : '';

            // --- COMMANDS ---
            const senderJid = participantJid || remoteJid;
            const isOwner = msg.key.fromMe || (config.owners && config.owners.some(o => senderJid.includes(o)));

            if (isCmd) {
                console.log(`[DEBUG] Command detected: "${textContent}" from ${senderJid} (isOwner: ${isOwner})`);
                if (!isOwner) console.log(`[SECURITY] Command denied for ${senderJid}`);
            }

            if (isOwner && isCmd) {
                const targetChat = (isStatus || msg.key.fromMe) ? (socket.user.id.split(':')[0] + '@s.whatsapp.net') : remoteJid;

                if (cmd === 'dazstatus') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') { isActivelyLiking = true; isViewOnly = false; }
                    else if (arg === 'off') isActivelyLiking = false;
                    await socket.sendMessage(targetChat, { text: `[SYSTEM] Likes Auto : ${isActivelyLiking ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                } else if (cmd === 'dazview') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        isViewOnly = true;
                        isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ON ✅` }, { quoted: msg });
                    } else if (arg === 'off') {
                        isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : OFF ❌` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status View-Only: ${isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    } else {
                        isViewOnly = !isViewOnly;
                        if (isViewOnly) isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ${isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'dazstatusuni') {
                    const arg = textLower.split(/\s+/)[1];
                    if (!arg) {
                        await socket.sendMessage(targetChat, { text: `${currentPrefix}dazstatusuni <emoji> ou random` }, { quoted: msg });
                    } else if (arg === 'random') {
                        fixedEmoji = null;
                        await socket.sendMessage(targetChat, { text: `✅ Mode Aléatoire 🎲` }, { quoted: msg });
                    } else {
                        fixedEmoji = textContent.split(/\s+/)[1];
                        isActivelyLiking = true; isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `✅ Emoji fixé : ${fixedEmoji}` }, { quoted: msg });
                    }
                } else if (cmd === 'dazonly') {
                    const arg = textLower.split(/\s+/)[1];
                    if (!arg) {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro ou 'off'.\nExemple: ${currentPrefix}dazonly 2250102030405` }, { quoted: msg });
                    } else if (arg === 'off') {
                        focusJid = null;
                        await socket.sendMessage(targetChat, { text: `✅ Mode focus désactivé. Le bot réagit à nouveau à tout le monde.` }, { quoted: msg });
                    } else {
                        // Nettoyer le numéro (enlever +, espaces, etc.)
                        const cleanNumber = arg.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            focusJid = cleanNumber;
                            isActivelyLiking = true;
                            isViewOnly = false;
                            await socket.sendMessage(targetChat, { text: `🎯 Mode Focus activé !\nLe bot ne likera désormais QUE les statuts de : +${cleanNumber}` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazantionly') {
                    const arg = textLower.split(/\s+/)[1];
                    if (!arg) {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro, 'here' ou 'off'.\nExemple: ${currentPrefix}dazantionly 2250102030405\nOu: ${currentPrefix}dazantionly here` }, { quoted: msg });
                    } else if (arg === 'off') {
                        antiDelete.setFocus(null);
                        await socket.sendMessage(targetChat, { text: `✅ Anti-Delete Focus désactivé. Tous les messages supprimés seront récupérés.` }, { quoted: msg });
                    } else if (arg === 'here') {
                        antiDelete.setFocus(remoteJid);
                        config.antiDeleteEnabled = true;
                        const isGroup = remoteJid.endsWith('@g.us');
                        const targetType = isGroup ? "ce groupe" : "cette discussion";
                        await socket.sendMessage(targetChat, { text: `🛡️ Anti-Delete Focus activé !\nLe bot ne récupérera désormais QUE les messages supprimés de : ${targetType}` }, { quoted: msg });
                    } else {
                        const cleanNumber = arg.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            antiDelete.setFocus(cleanNumber);
                            config.antiDeleteEnabled = true;
                            await socket.sendMessage(targetChat, { text: `🛡️ Anti-Delete Focus activé !\nLe bot ne récupérera désormais QUE les messages supprimés de : +${cleanNumber}` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'planstatus' || cmd === 'ps' || cmd === 'planmsg' || cmd === 'pm') {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    const time = textLower.split(/\s+/)[1];

                    if (!time || !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
                        return await socket.sendMessage(targetChat, { text: `❌ Format d'heure invalide. Utilisez HH:mm (ex: 14:30).` }, { quoted: msg });
                    }

                    if (!quoted) {
                        return await socket.sendMessage(targetChat, { text: `❌ Répondez au message (texte, photo, vidéo, audio) que vous souhaitez programmer.` }, { quoted: msg });
                    }

                    // Déterminer le type de message
                    let mediaType = Object.keys(quoted)[0];
                    if (['viewOnceMessageV2', 'viewOnceMessage', 'viewOnceMessageV2Extension'].includes(mediaType)) {
                        mediaType = Object.keys(quoted[mediaType].message)[0];
                    }

                    let messageToPlan = {};
                    if (mediaType === 'conversation') {
                        messageToPlan = { text: quoted.conversation };
                    } else if (mediaType === 'extendedTextMessage') {
                        messageToPlan = { text: quoted.extendedTextMessage.text };
                    } else if (mediaType === 'imageMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        messageToPlan = { image: buffer, caption: quoted.imageMessage.caption || "" };
                    } else if (mediaType === 'videoMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        messageToPlan = { video: buffer, caption: quoted.videoMessage.caption || "" };
                    } else if (mediaType === 'audioMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        messageToPlan = { audio: buffer, mimetype: quoted.audioMessage.mimetype, ptt: quoted.audioMessage.ptt };
                    }

                    if (cmd === 'planstatus' || cmd === 'ps') {
                        scheduler.addTask({
                            type: 'status',
                            time: time,
                            message: messageToPlan
                        });
                        await socket.sendMessage(targetChat, { text: `✅ Statut programmé pour ${time} !` }, { quoted: msg });
                    } else {
                        const target = textLower.split(/\s+/)[2] || (socket.user.id.split(':')[0] + '@s.whatsapp.net');
                        const cleanTarget = target.includes('@') ? target : (target.replace(/\D/g, '') + '@s.whatsapp.net');
                        
                        scheduler.addTask({
                            type: 'message',
                            time: time,
                            target: cleanTarget,
                            message: messageToPlan
                        });
                        await socket.sendMessage(targetChat, { text: `✅ Message programmé pour ${time} vers ${cleanTarget} !` }, { quoted: msg });
                    }
                } else if (cmd === 'dazconnect') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.sendWelcomeMessage = true;
                        await socket.sendMessage(targetChat, { text: `✅ Message de connexion activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.sendWelcomeMessage = false;
                        await socket.sendMessage(targetChat, { text: `❌ Message de connexion désactivé.` }, { quoted: msg });
                    }
                } else if (cmd === 'setprefix') {
                    const newPrefix = textArgs.split(/\s+/)[0];
                    if (newPrefix) {
                        config.prefix = newPrefix;
                        const fs = require('fs');
                        let configStr = fs.readFileSync('./config.js', 'utf8');
                        configStr = configStr.replace(/prefix:\s*['"][^'"]*['"]/, `prefix: "${newPrefix}"`);
                        fs.writeFileSync('./config.js', configStr);
                        await socket.sendMessage(targetChat, { text: `✅ Préfixe changé pour '${newPrefix}'.` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un préfixe, ex: ${currentPrefix}setprefix !` }, { quoted: msg });
                    }
                } else if (cmd === 'tagall') {
                    await tagAll.executeTagAll(socket, msg);
                } else if (cmd === 'ss') {
                    await screenshot.executeScreenshot(socket, msg);
                } else if (cmd === 'fb' || cmd === 'facebook' || cmd === 'fbdl') {
                    await facebook.executeFacebook(socket, msg);
                } else if (cmd === 'host') {
                    await hostCmd.executeHost(socket, msg, config);
                } else if (cmd === 'antidelete') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.antiDeleteEnabled = true;
                        await socket.sendMessage(targetChat, { text: `✅ Anti-Delete activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.antiDeleteEnabled = false;
                        await socket.sendMessage(targetChat, { text: `❌ Anti-Delete désactivé.` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status Anti-Delete: ${config.antiDeleteEnabled ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'menu' || cmd === 'help' || cmd === 'h') {
                    const menuText = `╭───〔 🤖 *DAZBOT V1.0* 〕───⬣
│
│ ⚙️ *CONFIG*
│ ߷ ${currentPrefix}setprefix : Changer préfixe
│ ߷ ${currentPrefix}host : Infos serveur
│
│ 🟢 *STATUS AUTO*
│ ߷ ${currentPrefix}dazstatus [on/off] : Likes Auto
│ ߷ ${currentPrefix}dazview [on/off] : Mode Discret
│ ߷ ${currentPrefix}dazstatusuni [emoji/random]
│ ߷ ${currentPrefix}dazonly [numéro/off] : Focus
│
│ 🛡️ *ANTI-DELETE*
│ ߷ ${currentPrefix}antidelete [on/off]
│ ߷ ${currentPrefix}dazantionly [numéro/here/off]
│
│ 📅 *PLANIFICATEUR*
│ ߷ ${currentPrefix}planstatus [HH:mm] : (rép. média)
│ ߷ ${currentPrefix}planmsg [HH:mm] [num] : (rép. msg)
│
│ ⬇️ *OUTILS & DL*
│ ߷ ${currentPrefix}tagall : Tag le groupe
│ ߷ ${currentPrefix}ss [url] : Screenshot Web
│ ߷ ${currentPrefix}fb [url] : Vidéo Facebook
│
│ 👁️ *VIEW ONCE* (répondre au msg)
│ ߷ ${currentPrefix}vv : Débloquer ici
│ ߷ ${currentPrefix}vv2 : Dans mon inbox
│ ߷ ${currentPrefix}nice : Inbox admin
│
╰──────────────⬣
 *© 2025 DAZBOT BY DAZ*`;
                    await socket.sendMessage(targetChat, { text: menuText }, { quoted: msg });
                }

                // --- DOWNLOADER COMMANDS ---
                const vCommands = ['vv', 'vv2', 'nice'];
                if (vCommands.includes(cmd)) {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    if (!quoted) return await socket.sendMessage(remoteJid, { text: "❌ Répondez à une Vue Unique." }, { quoted: msg });

                    let mediaMsg = quoted;
                    let type = Object.keys(quoted)[0];
                    if (['viewOnceMessageV2', 'viewOnceMessage', 'viewOnceMessageV2Extension'].includes(type)) {
                        mediaMsg = quoted[type].message;
                        type = Object.keys(mediaMsg)[0];
                    }

                    // Reconstruire un faux message compatible Baileys
                    const fakeMsg = {
                        key: {
                            remoteJid: remoteJid,
                            id: contextInfo.stanzaId,
                            participant: contextInfo.participant || null
                        },
                        message: mediaMsg
                    };

                    try {
                        const buffer = await downloadMediaMessage(
                            fakeMsg,
                            'buffer', {},
                            { logger: pino({ level: 'silent' }) }
                        );
                        const ownerJid = (config.owners ? config.owners[0] : "") + '@s.whatsapp.net';
                        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';

                        let targetJid = remoteJid;
                        if (cmd === 'vv2') targetJid = botJid;
                        if (cmd === 'nice') targetJid = ownerJid;

                        if (type === 'imageMessage') await socket.sendMessage(targetJid, { image: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'videoMessage') await socket.sendMessage(targetJid, { video: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'audioMessage') await socket.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                    } catch (e) {
                        console.error("[ERROR] Download failed:", e.message);
                        await socket.sendMessage(remoteJid, { text: "❌ Erreur de téléchargement." }, { quoted: msg });
                    }
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
                        try {
                            // Simulation de présence pour forcer l'enregistrement par WhatsApp
                            await socket.sendPresenceUpdate('available', senderJid);

                            console.log(`[DEBUG-STATUS-READ] Sending FULL view for ID: ${msg.key.id} from ${senderJid}`);

                            // Méthode 1: Lire avec l'objet complet (Recommandé)
                            await socket.readMessages([msg]);

                            // Méthode 2: Signal direct de secours
                            const statusKey = {
                                remoteJid: 'status@broadcast',
                                id: msg.key.id,
                                participant: senderJid
                            };
                            if (typeof socket.sendReceipt === 'function') {
                                await socket.sendReceipt(statusKey.remoteJid, statusKey.participant, [statusKey.id], 'read');
                            }

                            // Petite pause et retour à l'état normal
                            await new Promise(r => setTimeout(r, 500));
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                        } catch (e) {
                            console.error(`[ERROR] Erreur marquage statut:`, e.message);
                        }

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
    try { if (activeSocket) activeSocket.ws.close(); } catch (e) { }
    process.exit(0);
});

process.on('SIGINT', async () => {
    try { if (activeSocket) activeSocket.ws.close(); } catch (e) { }
    process.exit(0);
});

// --- KEEP ALIVE ---
const RENDER_URL = "https://dazbot.onrender.com";
setInterval(async () => {
    try { await fetch(RENDER_URL); } catch (e) { }
}, 5 * 60 * 1000);
