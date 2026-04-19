console.log('---------------------------------------');
console.log('[SYSTEM] DAZBOT INITIALISATION...');
console.log('---------------------------------------');

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
const express = require('express');
const antiDelete = require('./antidelete.js');
const tagAll = require('./tagall.js');
const screenshot = require('./screenshot.js');
const facebook = require('./facebook.js');
const hostCmd = require('./host.js');
const scheduler = require('./scheduler.js');

console.log('[DEBUG] Bot starting script execution...');

// --- STATE & CACHE ---
const reactedStatusCache = new Set();
const CACHE_MAX_SIZE = 1000;
const botStartTime = Math.floor(Date.now() / 1000);

let isActivelyLiking = true;
let fixedEmoji = null;
let focusTargets = new Map(); // Store JID -> { emoji: string }
let discreteTargets = new Set(); // Store JIDs for view-only
let focusViewOnly = false; // Legacy, will be removed or repurposed
let focusVVJids = new Set();
let reactionSticker = null;
let isViewOnly = false;
let activeSocket = null;

// Statistiques du bot
const botStats = {
    statusRead: 0,
    statusReacted: 0,
    deletedRecovered: 0,
    vvRecovered: 0,
    byUser: {}
};

// Setup memory cache
const msgRetryCounterCache = new NodeCache();

console.log('[DEBUG] Constants and variables initialized.');

// Helper to check if a number is allowed based on whitelist and blacklist
function isAllowed(jid, msg) {
    if (!jid) return false;
    
    // Si c'est notre propre statut et que l'auto-like est activé, on autorise toujours
    if (msg?.key?.fromMe && config.likeMyOwnStatus) return true;

    const senderNum = jid.split('@')[0];
    const participantPn = msg?.key?.participantPn || "";
    const pnNum = participantPn.split('@')[0];

    // On vérifie d'abord si la personne est dans le Focus (Priorité haute)
    // On compare de manière floue pour supporter LID et PN
    const isFocus = Array.from(focusTargets.keys()).some(target => 
        jid.includes(target) || 
        senderNum.includes(target) || 
        participantPn.includes(target) || 
        pnNum.includes(target) ||
        target.includes(senderNum) ||
        (pnNum && target.includes(pnNum))
    );
                         
    if (isFocus) {
        console.log(`[FILTER-FOCUS] Match trouvé pour un membre de la liste !`);
        return true;
    }

    // Si on a un focus actif mais que la personne n'est pas dedans, on n'autorise pas le Like (Sauf si Global Liking est ON)
    if (focusTargets.size > 0 && !isActivelyLiking) {
        return false;
    }
    
    // Filtrage classique (Whitelist / Blacklist)
    if (config.blacklist && config.blacklist.length > 0) {
        if (config.blacklist.some(b => jid.includes(b) || participantPn.includes(b) || senderNum === b.split('@')[0])) return false;
    }
    
    if (config.whitelist && config.whitelist.length > 0) {
        return config.whitelist.some(w => jid.includes(w) || participantPn.includes(w) || senderNum === w.split('@')[0]);
    }
    
    return true;
}

async function connectToWhatsApp() {
    console.log('[INFO] Chargement de la session WhatsApp locale...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[INFO] Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

        const logger = pino({ level: 'info' });

        const socket = makeWASocket({
            version,
            logger,
            printQRInTerminal: true, // Force QR Code display even if pairing code is used
            browser: ["Mac OS", "Chrome", "121.0.6167.85"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30_000,
            connectTimeoutMs: 120_000,
            retryRequestDelayMs: 5000,
            maxMsgRetryCount: 5,
            syncFullHistory: false, // Alléger pour éviter les Timeouts
            defaultQueryTimeoutMs: 60000
        });

        activeSocket = socket;
        console.log('[DEBUG] Socket created.');
    
    // Configurer le callback pour les stats d'anti-delete
    antiDelete.setOnRecovered((phoneNumber) => {
        botStats.deletedRecovered++;
        botStats.byUser[phoneNumber] = (botStats.byUser[phoneNumber] || 0) + 1;
    });

    // Handle pairing code
    if (config.usePairingCode && !state.creds.me) {
        if (!config.phoneNumber || config.phoneNumber === "1234567890") {
            console.error('[ERROR] phone number issues in config.js');
            process.exit(1);
        }

        setTimeout(async () => {
            try {
                if (!socket.authState.creds.me) {
                    const code = await socket.requestPairingCode(config.phoneNumber);
                    console.log(`\n========================================`);
                    console.log(`[ACTION REQUIRED] Your Pairing Code: ${code}`);
                    console.log(`========================================\n`);
                }
            } catch (err) {
                console.error('[ERROR] Failed to request pairing code:', err);
            }
        }, 5000);
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
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`\n[QR-CODE] Un nouveau QR Code est disponible. Scannez-le si vous ne voulez pas utiliser le Pairing Code.`);
            // Note: Baileys printQRInTerminal handles the actual rendering if enabled
        }

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

            // Force presence for status to trigger key exchange
            try {
                await socket.sendPresenceUpdate('available');
                await socket.sendPresenceUpdate('available', 'status@broadcast');
            } catch (e) { }

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
            console.log(`[DEBUG-UPSERT] Nouveau pack de messages reçu (Type: ${m.type}, Count: ${m.messages?.length})`);
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant;
            const isStatus = remoteJid === 'status@broadcast';

            if (isStatus) {
                const sender = participantJid || msg.key.participant;
                console.log(`[DEBUG-STATUS] Nouveau statut détecté de : ${sender} (ID: ${msg.key.id})`);
            } else {
                console.log(`[DEBUG-MSG] Message de ${remoteJid} (Type: ${m.type})`);
            }

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
                    const senderJid = participantJid || remoteJid;
                    // --- FOCUS VV ---
                    if (focusVVJids.size > 0) {
                        const senderNum = senderJid.split('@')[0];
                        const chatNum = remoteJid.split('@')[0];
                        const isTargeted = Array.from(focusVVJids).some(jid => 
                            senderJid.includes(jid) || remoteJid.includes(jid) || senderNum === jid || chatNum === jid
                        );
                        if (!isTargeted) {
                            console.log(`[VV-FILTER] Vue Unique de ${senderJid} ignorée (Focus actif)`);
                            return;
                        }
                    }

                    const senderPhoneNumber = senderJid.split('@')[0];
                    const ownerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                    const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhoneNumber}`;
                    if (messageTypeStr.includes('image')) await socket.sendMessage(ownerJid, { image: buffer, caption });
                    else if (messageTypeStr.includes('video')) await socket.sendMessage(ownerJid, { video: buffer, caption });
                    else if (messageTypeStr.includes('audio')) await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                    
                    botStats.vvRecovered++;
                    botStats.byUser[senderPhoneNumber] = (botStats.byUser[senderPhoneNumber] || 0) + 1;
                } catch (e) { console.error("[ERROR] Anti-View-Once failed"); }
            }

            // --- GRACE PERIOD FOR STATUSES (OFFLINE CATCH-UP) ---
            if (msg.messageTimestamp) {
                const msgTime = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.toNumber ? msg.messageTimestamp.toNumber() : Number(msg.messageTimestamp);

                if (isStatus) {
                    // Pour les statuts, on accepte jusqu'à 2 heures de retard au lieu de 30 min
                    const gracePeriod = 2 * 60 * 60;
                    if (msgTime < (botStartTime - gracePeriod)) {
                        console.log(`[DEBUG-STATUS] Statut trop vieux ignoré : ${msg.key.id}`);
                        return;
                    }
                } else {
                    // Pour les commandes normales, on ignore STRICTEMENT tout ce qui s'est passé quand le bot était éteint
                    if (msgTime < botStartTime) {
                        console.log(`[FILTER] Ignoré commande ancienne (${msg.key.id}) - Ecart: ${botStartTime - msgTime}s`);
                        return;
                    }
                }
            }

            if (!isStatus && m.type !== 'notify' && m.type !== 'append') return;

            const senderJid = participantJid || remoteJid;
            const isOwner = msg.key.fromMe || (config.owners && config.owners.some(o => o.length > 0 && senderJid.includes(o))) || (config.phoneNumber && senderJid.includes(config.phoneNumber));

            if (!msg.message) {
                console.log(`[DEBUG-MSG] Message reçu sans contenu décryptable de ${senderJid} (ID: ${msg.key.id})`);
                return;
            }

            const textContent = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                msg.message.documentMessage?.caption ||
                "";
            const textLower = textContent.trim().toLowerCase();
            const currentPrefix = config.prefix || "?";
            const isCmd = textLower.startsWith(currentPrefix);
            const cmd = isCmd ? textLower.slice(currentPrefix.length).trim().split(/\s+/)[0] : '';
            const textArgs = isCmd ? textContent.slice(textContent.toLowerCase().indexOf(cmd) + cmd.length).trim() : '';

            // --- COMMANDS ---
            if (isCmd) {
                console.log(`[DEBUG-CMD] Commande détectée: "${textContent}" de ${senderJid} (isOwner: ${isOwner})`);
                if (!isOwner) {
                    console.log(`[SECURITY] Commande refusée pour ${senderJid}`);
                    return;
                }
            }

            if (isOwner && isCmd) {
                const targetChat = (isStatus || msg.key.fromMe) ? (socket.user.id.split(':')[0] + '@s.whatsapp.net') : remoteJid;

                if (cmd === 'dazstatus') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') { isActivelyLiking = true; isViewOnly = false; }
                    else if (arg === 'off') isActivelyLiking = false;
                    await socket.sendMessage(targetChat, { text: `[SYSTEM] Likes Auto : ${isActivelyLiking ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                } else if (cmd === 'ping') {
                    await socket.sendMessage(targetChat, { text: 'Pong! 🏓 Bot is active.' }, { quoted: msg });
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
                } else if (cmd === 'dazreset') {
                    focusTargets.clear();
                    discreteTargets.clear();
                    isActivelyLiking = true;
                    isViewOnly = false;
                    fixedEmoji = null;
                    focusViewOnly = false;
                    focusVVJids.clear();
                    antiDelete.clearFocus();
                    await socket.sendMessage(targetChat, { text: `🧹 *RÉINITIALISATION COMPLÈTE*\n\n- Focus Status : Vidé\n- Liste Discrète : Vidée\n- Auto-Like : ON ✅\n- Vision Seule : OFF ❌\n- Anti-Delete : Reset\n\nLe bot est revenu à sa configuration d'origine.` }, { quoted: msg });
                } else if (cmd === 'dazdiscrete') {
                    const action = textLower.split(/\s+/)[1];
                    const target = textLower.split(/\s+/)[2];

                    if (!action || action === 'list') {
                        const list = Array.from(discreteTargets).map(jid => `• ${jid}`).join('\n') || "Aucun";
                        return await socket.sendMessage(targetChat, { text: `🕵️ *LISTE DISCRÈTE (VISION SEULE)*\n\nUsage:\n- ${currentPrefix}dazdiscrete add [num]\n- ${currentPrefix}dazdiscrete remove [num]\n- ${currentPrefix}dazdiscrete off\n\nCibles actuelles:\n${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        discreteTargets.clear();
                        await socket.sendMessage(targetChat, { text: `✅ Liste discrète vidée.` }, { quoted: msg });
                    } else if (action === 'add') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            discreteTargets.add(cleanNumber);
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} ajouté à la liste discrète (Vision seule uniquement).` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    } else if (action === 'remove') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (discreteTargets.has(cleanNumber)) {
                            discreteTargets.delete(cleanNumber);
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} retiré de la liste discrète.` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Ce numéro n'est pas dans la liste.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazstatusuni') {
                    const arg = textContent.trim().split(/\s+/)[1];
                    if (!arg) {
                        const status = fixedEmoji ? `Fixé sur ${fixedEmoji}` : "Aléatoire 🎲";
                        await socket.sendMessage(targetChat, { text: `📊 *MODE UNI-EMOJI*\n\nEtat actuel : ${status}\n\nUsage:\n- ${currentPrefix}dazstatusuni ❤️ (Fixe l'emoji global)\n- ${currentPrefix}dazstatusuni random (Mode aléatoire)` }, { quoted: msg });
                    } else if (arg.toLowerCase() === 'random') {
                        fixedEmoji = null;
                        await socket.sendMessage(targetChat, { text: `✅ Mode Aléatoire 🎲` }, { quoted: msg });
                    } else {
                        fixedEmoji = arg;
                        isActivelyLiking = true; 
                        isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `✅ Emoji global fixé : ${fixedEmoji}` }, { quoted: msg });
                    }
                } else if (cmd === 'dazonly') {
                    const action = textLower.split(/\s+/)[1];
                    const target = textLower.split(/\s+/)[2];
                    const emoji = textContent.trim().split(/\s+/)[3];

                    if (!action || action === 'list') {
                        const list = Array.from(focusTargets.entries()).map(([jid, data]) => `• ${jid} (${data.emoji || "Auto"})`).join('\n') || "Aucun";
                        return await socket.sendMessage(targetChat, { text: `🎯 *LISTE FOCUS STATUS*\n\nUsage:\n- ${currentPrefix}dazonly add [num] [emoji]\n- ${currentPrefix}dazonly remove [num]\n- ${currentPrefix}dazonly off\n\nCibles actuelles:\n${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        focusTargets.clear();
                        await socket.sendMessage(targetChat, { text: `✅ Tous les focus ont été retirés.` }, { quoted: msg });
                    } else if (action === 'add') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            focusTargets.set(cleanNumber, { emoji: emoji || null });
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} ajouté au focus (Emoji: ${emoji || "Auto"}).` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    } else if (action === 'remove') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (focusTargets.has(cleanNumber)) {
                            focusTargets.delete(cleanNumber);
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} retiré du focus.` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Ce numéro n'est pas dans la liste.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazonlyview') {
                    const arg = textLower.split(/\s+/)[1];
                    if (!arg) {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro ou 'off'.\nExemple: ${currentPrefix}dazonlyview 2250102030405` }, { quoted: msg });
                    } else if (arg === 'off') {
                        focusJid = null;
                        focusViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `✅ Mode focus vision seule désactivé.` }, { quoted: msg });
                    } else {
                        const cleanNumber = arg.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            focusJid = cleanNumber;
                            focusViewOnly = true;
                            isActivelyLiking = false;
                            await socket.sendMessage(targetChat, { text: `👁️ Mode Focus Vision Seule activé !\nLe bot ne regardera désormais QUE les statuts de : +${cleanNumber}` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazvvonly') {
                    const action = textLower.split(/\s+/)[1];
                    const target = textLower.split(/\s+/)[2];

                    if (!action) {
                        const list = Array.from(focusVVJids).join(', ') || "Aucun";
                        return await socket.sendMessage(targetChat, { text: `👁️ *Focus Vue Unique*\n\nUsage:\n- ${currentPrefix}dazvvonly add [num/here]\n- ${currentPrefix}dazvvonly remove [num/here]\n- ${currentPrefix}dazvvonly list\n- ${currentPrefix}dazvvonly off\n\nCibles actuelles: ${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        focusVVJids.clear();
                        await socket.sendMessage(targetChat, { text: `✅ Focus Vue Unique désactivé.` }, { quoted: msg });
                    } else if (action === 'list') {
                        const list = Array.from(focusVVJids).map(j => `• ${j}`).join('\n') || "Aucune cible.";
                        await socket.sendMessage(targetChat, { text: `📋 *Cibles Vue Unique :*\n${list}` }, { quoted: msg });
                    } else if (action === 'add' || action === 'remove') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro ou 'here'.` }, { quoted: msg });
                        
                        let jidToProcess = target === 'here' ? remoteJid : target.replace(/\D/g, '');
                        if (jidToProcess.length < 5) return await socket.sendMessage(targetChat, { text: `❌ Cible invalide.` }, { quoted: msg });

                        if (action === 'add') {
                            focusVVJids.add(jidToProcess);
                            await socket.sendMessage(targetChat, { text: `✅ Cible ajoutée au focus Vue Unique.` }, { quoted: msg });
                        } else {
                            focusVVJids.delete(jidToProcess);
                            await socket.sendMessage(targetChat, { text: `✅ Cible retirée du focus Vue Unique.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazsticker') {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    const arg = textLower.split(/\s+/)[1];

                    if (arg === 'off') {
                        reactionSticker = null;
                        return await socket.sendMessage(targetChat, { text: `✅ Réaction par sticker désactivée.` }, { quoted: msg });
                    }

                    if (!quoted || !quoted.stickerMessage) {
                        return await socket.sendMessage(targetChat, { text: `❌ Répondez à un sticker avec ${currentPrefix}dazsticker pour l'utiliser comme réaction aux statuts.` }, { quoted: msg });
                    }

                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    reactionSticker = buffer;
                    await socket.sendMessage(targetChat, { text: `✅ Sticker enregistré ! Le bot l'utilisera désormais pour réagir aux statuts.` }, { quoted: msg });
                } else if (cmd === 'dazstats') {
                    const topUsers = Object.entries(botStats.byUser)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([num, count], i) => `│ ${i + 1}. +${num} (${count})`)
                        .join('\n');

                    const statsMsg = `╭───〔 📊 *STATISTIQUES DAZBOT* 〕───⬣\n` +
                        `│\n` +
                        `│ 👀 *Statuts Vus*    : ${botStats.statusRead}\n` +
                        `│ ❤️ *Statuts Likés*   : ${botStats.statusReacted}\n` +
                        `│ 🛡️ *Msg Récupérés*   : ${botStats.deletedRecovered}\n` +
                        `│ 👁️ *Vues Uniques*    : ${botStats.vvRecovered}\n` +
                        `│\n` +
                        `│ 🔥 *TOP ACTIFS* :\n` +
                        `${topUsers || "│ (Aucune donnée)"}\n` +
                        `│\n` +
                        `╰──────────────⬣`;
                    await socket.sendMessage(targetChat, { text: statsMsg }, { quoted: msg });
                } else if (cmd === 'dazantionly') {
                    const action = textLower.split(/\s+/)[1];
                    const target = textLower.split(/\s+/)[2];
                    
                    if (!action) {
                        const list = antiDelete.getFocusList().join(', ') || "Aucun";
                        return await socket.sendMessage(targetChat, { text: `🛡️ *Focus Anti-Delete*\n\nUsage:\n- ${currentPrefix}dazantionly add [num/here]\n- ${currentPrefix}dazantionly remove [num/here]\n- ${currentPrefix}dazantionly list\n- ${currentPrefix}dazantionly off\n\nCibles actuelles: ${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        antiDelete.clearFocus();
                        await socket.sendMessage(targetChat, { text: `✅ Focus Anti-Delete désactivé.` }, { quoted: msg });
                    } else if (action === 'list') {
                        const list = antiDelete.getFocusList().map(j => `• ${j}`).join('\n') || "Aucune cible.";
                        await socket.sendMessage(targetChat, { text: `📋 *Cibles Anti-Delete :*\n${list}` }, { quoted: msg });
                    } else if (action === 'add' || action === 'remove') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro ou 'here'.` }, { quoted: msg });
                        
                        let jidToProcess = target === 'here' ? remoteJid : target.replace(/\D/g, '');
                        if (jidToProcess.length < 5) return await socket.sendMessage(targetChat, { text: `❌ Cible invalide.` }, { quoted: msg });

                        if (action === 'add') {
                            antiDelete.addFocus(jidToProcess);
                            config.antiDeleteEnabled = true;
                            await socket.sendMessage(targetChat, { text: `✅ Cible ajoutée au focus Anti-Delete.` }, { quoted: msg });
                        } else {
                            antiDelete.removeFocus(jidToProcess);
                            await socket.sendMessage(targetChat, { text: `✅ Cible retirée du focus Anti-Delete.` }, { quoted: msg });
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
                } else if (cmd === 'menu' || cmd === 'help' || cmd === 'h' || cmd === 'guide') {
                    const menuText = `╭───〔 🤖 *DAZBOT V1.0 - GUIDE COMPLET* 〕───⬣
│
│ ⚙️ *CONFIGURATION*
│ ߷ *${currentPrefix}setprefix [symbole]*
│   └ Ex: ${currentPrefix}setprefix !
│ ߷ *${currentPrefix}dazreset* : Reset TOUS les focus
│ ߷ *${currentPrefix}host* : Infos serveur
│
│ 🎯 *FOCUS STATUS (LIKE CIBLÉ)*
│ ߷ *${currentPrefix}dazonly add [num] [emoji]*
│   └ Ex: ${currentPrefix}dazonly add 225... 🔥
│ ߷ *${currentPrefix}dazonly remove [num]*
│ ߷ *${currentPrefix}dazonly list* (Voir ta liste)
│ ߷ *${currentPrefix}dazonly off* (Vider la liste)
│
│ 🟢 *GLOBAL STATUS (TOUT LE MONDE)*
│ ߷ *${currentPrefix}dazstatus [on/off]*
│   └ ON : Like tout le monde
│   └ OFF : Like UNIQUEMENT ton Focus
│ ߷ *${currentPrefix}dazview [on/off]*
│   └ ON : Vision seule (Pas de like même focus)
│ ߷ *${currentPrefix}dazdiscrete add [num]*
│   └ Vision seule pour CETTE personne
│ ߷ *${currentPrefix}dazdiscrete list*
│ ߷ *${currentPrefix}dazstatusuni [emoji/random]*
│ ߷ *${currentPrefix}dazsticker* (Rép. sticker)
│ ߷ *${currentPrefix}dazstats* : Statistiques
│
│ 🛡️ *PROTECTION (AUTO)*
│ ߷ *${currentPrefix}antidelete [on/off]*
│ ߷ *${currentPrefix}dazantionly [add/remove/list/off]*
│ ߷ *${currentPrefix}dazvvonly [add/remove/list/off]*
│
│ 📅 *PLANIFICATEUR (HH:mm)*
│ ߷ *${currentPrefix}ps [heure]* (Rép. média/texte)
│ ߷ *${currentPrefix}pm [heure] [num]* (Rép. média)
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
                const statusId = msg.key.id;
                if (reactedStatusCache.has(statusId)) return;

                reactedStatusCache.add(statusId);
                if (reactedStatusCache.size > CACHE_MAX_SIZE) reactedStatusCache.delete(reactedStatusCache.values().next().value);

                const senderJid = participantJid || msg.key.participant;
                if (!senderJid) {
                    console.log(`[DEBUG-STATUS] Impossible de déterminer l'expéditeur pour ${msg.key.id}`);
                    return;
                }

                // Récupération du vrai numéro si disponible
                const senderPhoneNumber = (msg.key.participantPn || senderJid).split('@')[0];
                const emojis = config.reactionEmojis || ["❤️"];
                const reactionEmojiToUse = fixedEmoji ? fixedEmoji : emojis[Math.floor(Math.random() * emojis.length)];

                const delayMs = Math.floor(Math.random() * 4000) + 2000;
                setTimeout(async () => {
                    try {
                        try {
                            // 1. Déclarer "disponible"
                            await socket.sendPresenceUpdate('available', senderJid);

                            console.log(`[STATUS-READ] +${senderPhoneNumber} (${msg.key.id})`);

                            // 2. Envoyer le signal de lecture sur les deux canaux (Broadcast + Privé)
                            await socket.sendReceipt('status@broadcast', senderJid, [msg.key.id], 'read');
                            await socket.readMessages([msg.key]);

                            botStats.statusRead++;
                            botStats.byUser[senderPhoneNumber] = (botStats.byUser[senderPhoneNumber] || 0) + 1;

                            // 3. Pause
                            await new Promise(r => setTimeout(r, 2000));
                        } catch (e) {
                            console.error(`[ERROR] Erreur marquage statut:`, e.message);
                        }

                        // --- HIÉRARCHIE DE DÉCISION ---
                        
                        // 1. DISCRETE (Vision Seule prioritaire)
                        const isDiscrete = discreteTargets.has(senderJid) || 
                                           discreteTargets.has(senderPhoneNumber) || 
                                           (msg.key.participantPn ? discreteTargets.has(msg.key.participantPn.split('@')[0]) : false);
                        
                        if (isDiscrete) {
                            console.log(`[VIEW-DISCRETE] +${senderPhoneNumber} vu silencieusement`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        // On détermine l'emoji
                        let emojiToUse = reactionEmojiToUse;
                        const focusData = focusTargets.get(senderJid) || 
                                          focusTargets.get(senderPhoneNumber) || 
                                          (msg.key.participantPn ? focusTargets.get(msg.key.participantPn.split('@')[0]) : null);
                        
                        if (focusData) {
                            if (focusData.emoji) emojiToUse = focusData.emoji;
                            else if (fixedEmoji) emojiToUse = fixedEmoji;

                            console.log(`[DEBUG-LIKE] Envoi réaction focus directe pour ${senderPhoneNumber}`);
                            
                            // 4. LIKE DIRECT (Plus visible sur mobile)
                            await socket.sendMessage(senderJid, { 
                                react: { text: emojiToUse, key: msg.key } 
                            });
                            
                            botStats.statusReacted++;
                            console.log(`[FOCUS-LIKE] +${senderPhoneNumber} avec ${emojiToUse}`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        if (isViewOnly) {
                            console.log(`[VIEW] Statut de +${senderPhoneNumber} vu silencieusement`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        if (!isActivelyLiking) {
                            console.log(`[STATUS-INFO] +${senderPhoneNumber} : Lu uniquement`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        if (fixedEmoji) emojiToUse = fixedEmoji;

                        console.log(`[DEBUG-LIKE] Envoi réaction globale directe pour ${senderPhoneNumber}`);
                        
                        // 4. LIKE DIRECT (Plus visible sur mobile)
                        await socket.sendMessage(senderJid, { 
                            react: { text: emojiToUse, key: msg.key } 
                        });
                        
                        botStats.statusReacted++;
                        console.log(`[LIKE] +${senderPhoneNumber} avec ${emojiToUse}`);
                        await socket.sendPresenceUpdate('unavailable', senderJid);

                        if (config.autoReplyMessage?.trim()) {
                            await socket.sendMessage(senderJid, { text: config.autoReplyMessage });
                        }
                    } catch (err) { console.error(`[ERROR] Likant +${senderPhoneNumber}:`, err.message); }
                }, delayMs);
            }
        } catch (error) { console.error('[ERROR] Upsert loop:', error.message); }
    });
    } catch (err) {
        console.error('[FATAL] Connection error:', err);
    }
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
