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

// --- ANTI-DOUBLON CACHE ---
const reactedStatusCache = new Set();
const CACHE_MAX_SIZE = 1000;

let isActivelyLiking = true; // Global toggle for liking statuses
let fixedEmoji = null; // Forces a specific emoji instead of randomly picking

// Helper to check if a number is allowed based on whitelist and blacklist
function isAllowed(jid) {
    // If blacklist has elements and includes the JID, deny it
    if (config.blacklist && config.blacklist.length > 0) {
        if (config.blacklist.includes(jid)) return false;
    }
    // If whitelist has elements, ONLY allow if JID is in whitelist
    if (config.whitelist && config.whitelist.length > 0) {
        return config.whitelist.includes(jid);
    }
    // Otherwise allow all
    return true;
}

async function connectToWhatsApp() {
    // Initialise Supabase Client
    const supabase = createClient(config.supabaseUrl, config.supabaseKey);

    // Save auth state securely to Supabase database instead of local folder
    console.log('[INFO] Loading WhatsApp Session from Supabase Cloud...');
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_auth');
    
    // Fetch latest WhatsApp version for best compatibility
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[INFO] Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

    // Set logging level to silent to keep terminal clean
    const logger = pino({ level: 'silent' });

    // Initialize Bailey's socket
    const socket = makeWASocket({
        version,
        logger,
        // If not using pairing code, print QR in terminal
        printQRInTerminal: !config.usePairingCode,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 25_000, // Ping WhatsApp every 25s (plus agressif pour éviter les coupures)
        connectTimeoutMs: 120_000,    // 120s timeout before giving up on connection
        retryRequestDelayMs: 2000,    // 2s between retry requests
        maxMsgRetryCount: 5           // Retry jusqu'à 5 fois si un message échoue
    });

    // Handle pairing code login flow
    if (config.usePairingCode && !state.creds.me) {
        if (!config.phoneNumber || config.phoneNumber === "1234567890") {
            console.error('[ERROR] You chose to use pairing code but did not provide a valid phoneNumber in config.js');
            process.exit(1);
        }
        
        // Wait briefly for socket handshake before requesting code
        setTimeout(async () => {
            try {
                // Request the pairing code
                const code = await socket.requestPairingCode(config.phoneNumber);
                console.log(`\n========================================`);
                console.log(`[ACTION REQUIRED] Your Pairing Code: ${code}`);
                console.log(`Please open WhatsApp on your phone:`);
                console.log(`Settings -> Linked Devices -> Link a Device -> Log in with phone number instead`);
                console.log(`========================================\n`);
            } catch (err) {
                console.error('[ERROR] Failed to request pairing code:', err);
            }
        }, 3000);
    }

    // Save newly generated credentials automatically
    socket.ev.on('creds.update', saveCreds);

    let reconnectAttempts = 0;

    // Track connection state
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !config.usePairingCode) {
            console.log('[ACTION] Scan the QR code above to log in.');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const isConflict = statusCode === 440;

            console.log('[INFO] Connection closed, code:', statusCode, '| Reconnecting:', shouldReconnect);

            if (shouldReconnect) {
                reconnectAttempts++;
                // Backoff exponentiel : 10s, 20s, 40s... max 120s pour éviter le spam de reconnexions
                const baseDelay = isConflict ? 30_000 : 10_000;
                const backoff = Math.min(baseDelay * Math.pow(1.5, reconnectAttempts - 1), 120_000);
                console.log(`[INFO] Reconnexion dans ${Math.round(backoff / 1000)}s (tentative #${reconnectAttempts})${isConflict ? ' (conflit de session détecté)' : ''}...`);
                setTimeout(() => connectToWhatsApp(), backoff);
            } else {
                console.log('[INFO] Session déconnectée manuellement. Vide la table "whatsapp_auth" dans Supabase et redémarre.');
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0; // Reset le compteur à chaque connexion réussie
            console.log('[INFO] Successfully connected to WhatsApp!');
            const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            const welcomeMsg = `╭───〔 🤖 *JOSIHACK BOT* 〕───⬣\n` +
                               `│ ߷ *Etat*       ➜ Connecté ✅\n` +
                               `│ ߷ *Préfixe*    ➜ ?\n` +
                               `│ ߷ *Mode*       ➜ Auto-Like\n` +
                               `│ ߷ *Anti-Vue*   ➜ Activé 👁️\n` +
                               `│ ߷ *Version*    ➜ 1.0.0\n` +
                               `│ ߷ *Développeur*➜ Josi_Hack\n` +
                               `╰──────────────⬣`;
            console.log(welcomeMsg);
            try {
                await socket.sendMessage(botJid, { text: welcomeMsg });
                console.log('[INFO] Message de bienvenue envoyé sur WhatsApp.');
            } catch(e) {}
        }
    });

    // Main message handler
    socket.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];

            if (!msg) return;
            if (!msg.message) return; // Null check: Ignore if no message content
            
            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant; 

            // --- ANTI VUE UNIQUE (VIEW ONCE RECUPERATION) ---
            let isViewOnce = false;
            let messageTypeStr = "Media";

            const viewOnceKey = Object.keys(msg.message || {}).find(k => k.toLowerCase().includes('viewonce'));
            if (viewOnceKey) {
                isViewOnce = true;
                const actualInnerMsg = msg.message[viewOnceKey]?.message;
                if (actualInnerMsg) {
                    messageTypeStr = Object.keys(actualInnerMsg)[0];
                }
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
                    console.log(`[ANTI-VIEW-ONCE] Message à vue unique détecté de +${senderPhoneNumber} (Type: ${messageTypeStr})`);

                    const ownerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    
                    // Download the actual media
                    const buffer = await downloadMediaMessage(
                        msg,
                        'buffer',
                        { },
                        { 
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: socket.updateMediaMessage
                        }
                    );

                    const caption = `👁️ *VUE UNIQUE RÉCUPÉRÉE*\n👤 De : +${senderPhoneNumber}\n📎 Type : ${messageTypeStr.replace('Message', '')}`;
                    
                    if (messageTypeStr.includes('image')) {
                        await socket.sendMessage(ownerJid, { image: buffer, caption: caption });
                        console.log(`[ANTI-VIEW-ONCE] Image sauvegardée avec succès vers ${ownerJid}`);
                    } else if (messageTypeStr.includes('video')) {
                        await socket.sendMessage(ownerJid, { video: buffer, caption: caption });
                        console.log(`[ANTI-VIEW-ONCE] Vidéo sauvegardée avec succès vers ${ownerJid}`);
                    } else if (messageTypeStr.includes('audio')) {
                        await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                        await socket.sendMessage(ownerJid, { text: caption });
                        console.log(`[ANTI-VIEW-ONCE] Audio sauvegardé avec succès vers ${ownerJid}`);
                    }
                } catch (e) {
                    console.error("[ERROR] Échec de récupération de la vue unique (Anti-View-Once) :", e.message);
                }
            }

            // --- FILTRAGE DE L'HISTORIQUE ---
            // On ignore le reste de l'historique (messages de plus de 5 minutes)
            const now = Math.floor(Date.now() / 1000);
            if (msg.messageTimestamp && msg.messageTimestamp < (now - 300)) return;
            
            // On s'assure de ne traiter que les vrais messages de chat (notify) et nos propres envois (append)
            const isStatus = m.messages?.some(msg => msg.key?.remoteJid === 'status@broadcast');
            if (!isStatus && m.type !== 'notify' && m.type !== 'append') return;

            // Extract message text to check for commands
            const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const textLower = textContent.trim().toLowerCase();

            // Handle Owner commands
            if (msg.key.fromMe) {
                const targetChat = msg.key.remoteJid === 'status@broadcast' 
                    ? socket.user.id.split(':')[0] + '@s.whatsapp.net' 
                    : msg.key.remoteJid;

                // 1. Toggle ON/OFF
                if (textLower.startsWith('?josistatus ') && !textLower.startsWith('?josistatusuni')) {
                    const args = textLower.trim().split(/\s+/);
                    if (args[1] === 'on') {
                        isActivelyLiking = true;
                    } else if (args[1] === 'off') {
                        isActivelyLiking = false;
                    } else {
                        return; // Ignore if it's not strictly on or off
                    }

                    const statusStr = isActivelyLiking ? "ACTIVÉ ✅" : "DÉSACTIVÉ ❌";
                    const emojiStr = fixedEmoji ? fixedEmoji : "Aléatoire 🎲";
                    const messageText = `[COMMANDE] Liker les statuts est maintenant ${statusStr} By JosiHack\n📊 Mode actuel : *${emojiStr}*`;
                    
                    console.log(`[COMMANDE] ${statusStr} By JosiHack (${emojiStr})`);
                    try {
                        await socket.sendMessage(targetChat, { text: messageText }, { quoted: msg });
                        console.log(`[INFO] Reply successfully sent to WhatsApp.`);
                    } catch (e) {
                        console.error(`[ERROR] Could not send reply on WhatsApp:`, e.message);
                    }
                    return;
                }

                // 2. Set Specific Emoji
                if (textLower.startsWith('?josistatusuni')) {
                    const args = textContent.trim().split(/\s+/);
                    const isActivated = isActivelyLiking ? "Activé" : "Désactivé";
                    const currentEmojiDisplay = fixedEmoji ? fixedEmoji : "Aléatoire 🎲";

                    // Note: ?josistatusuni without an arg gives the Help Menu.
                    if (args.length < 2) {
                        const helpMsg = `🔧 *Paramètres des Likes Auto sur Statuts :*\n\n` +
                                        `• *?josistatusuni <emoji>* : Active le bot avec l'emoji fixé.\n` +
                                        `• *?josistatusuni random* : Change le bot pour liker aléatoirement.\n\n` +
                                        `📌 *Exemples :* ?josistatusuni 🤣 ou ?josistatusuni random\n` +
                                        `📊 Statut actuel : *${isActivated} (${currentEmojiDisplay})*`;
                        try {
                            await socket.sendMessage(targetChat, { text: helpMsg }, { quoted: msg });
                        } catch(e) {}
                        return;
                    }

                    // Process the argument
                    const argVal = args[1].toLowerCase();
                    try {
                        if (argVal === 'random') {
                            fixedEmoji = null;
                            await socket.sendMessage(targetChat, { text: `✅ Le mode de likes est revenu sur *Aléatoire 🎲*` }, { quoted: msg });
                        } else {
                            fixedEmoji = args[1]; // Store the literal emoji passed by the user
                            isActivelyLiking = true; // Auto-activate if setting an emoji
                            await socket.sendMessage(targetChat, { text: `✅ Les prochains statuts seront likés uniquement avec : *${fixedEmoji}*` }, { quoted: msg });
                        }
                    } catch(e) {}
                    return;
                }

                // 3. Help Menu 
                if (textLower === '?menu') {
                    const menuMsg = `🤖 *MENU DU BOT STATUS BY JOSIHACK* 🤖\n\n` +
                                    `*📝 Liste des commandes disponibles :*\n\n` +
                                    `⚡ *?josistatus on / off*\n` +
                                    `Allume (on) ou éteint (off) complètement le like automatique des statuts.\n\n` +
                                    `🎯 *?josistatusuni <emoji>*\n` +
                                    `Force le bot à liker avec un seul emoji précis. (ex: ?josistatusuni ❤️)\n\n` +
                                    `🎲 *?josistatusuni random*\n` +
                                    `Remet le bot en mode aléatoire (il piochera dans votre liste de base).\n\n` +
                                    `ℹ️ *?menu*\n` +
                                    `Affiche ce message d'aide de nouveau.\n\n` +
                                    `_Développé avec 💻 par Josi_Hack_`;
                    try {
                        await socket.sendMessage(targetChat, { text: menuMsg }, { quoted: msg });
                    } catch(e) {}
                    return;
                }
            }

            // Check if it is a status message sent to "status@broadcast"
            if (remoteJid === 'status@broadcast') {
                if (!isActivelyLiking) return; // Stop if disabled via command

                // --- ANTI-DOUBLON ---
                const statusId = msg.key.id;
                if (reactedStatusCache.has(statusId)) return; // Empêche le bot de réagir au même statut si Baileys l'émet en double
                
                reactedStatusCache.add(statusId);
                if (reactedStatusCache.size > CACHE_MAX_SIZE) {
                    const firstItem = reactedStatusCache.values().next().value;
                    reactedStatusCache.delete(firstItem);
                }
                // --------------------

                let senderJid = participantJid || msg.key.participant;

                // Handle the bot user's own statuses
                if (msg.key.fromMe) {
                    if (!config.likeMyOwnStatus) return; // Skip if disabled in config
                    // Ensure we have our own properly formatted JID
                    senderJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                }

                if (!senderJid) return;

                const senderPhoneNumber = senderJid.split('@')[0];
                console.log(`[STATUS] Detected new status from: +${senderPhoneNumber}${msg.key.fromMe ? ' (My Own Status)' : ''}`);

                // Check whitelist and blacklist logic (skip list check for our own statuses)
                if (!msg.key.fromMe && !isAllowed(senderJid)) {
                    console.log(`[IGNORE] Ignored status from +${senderPhoneNumber} (Blocked by whitelist/blacklist)`);
                    return;
                }

                // Pick a random emoji from the array, OR use the fixed one
                const emojis = config.reactionEmojis || ["❤️"];
                const reactionEmojiToUse = fixedEmoji ? fixedEmoji : emojis[Math.floor(Math.random() * emojis.length)];

                const reactionMessage = {
                    react: {
                        text: reactionEmojiToUse,
                        key: msg.key
                    }
                };

                // Add an asynchronous delay simulating human reading time (2 to 6 secondes)
                const delayMs = Math.floor(Math.random() * (6000 - 2000 + 1)) + 2000;
                setTimeout(async () => {
                    try {
                        // 1. Mark status as read (so the sender sees you viewed it)
                        await socket.readMessages([msg.key]);

                        // 2. Send the reaction to status@broadcast with statusJidList
                        // IMPORTANT: Ne PAS envoyer au senderJid directement → ça génère les
                        // messages "En attente de ce message". Il faut passer par status@broadcast
                        // avec statusJidList pour que WhatsApp retrouve bien le statut cible.
                        await socket.sendMessage(
                            'status@broadcast',
                            reactionMessage,
                            { statusJidList: [senderJid] }
                        );
                        console.log(`[REACTION] Successfully reacted with ${reactionEmojiToUse} to +${senderPhoneNumber} (Délai: ${(delayMs/1000).toFixed(1)}s)`);

                        // 3. Optional auto-reply directly to their personal chat using senderJid
                        if (config.autoReplyMessage && config.autoReplyMessage.trim() !== "") {
                            await socket.sendMessage(senderJid, { text: config.autoReplyMessage });
                            console.log(`[REPLY] Auto-reply sent to +${senderPhoneNumber}`);
                        }

                    } catch (err) {
                        console.error(`[ERROR] Failed to react or reply to +${senderPhoneNumber}:`, err.message);
                    }
                }, delayMs);
            }
        } catch (error) {
            console.error('[ERROR] Unexpected error in messages.upsert:', error.message);
        }
    });
}

// --- RENDER KEEP-ALIVE SERVER ---
// Render 'Web Services' require an open HTTP port to stay alive
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.status(200).send('WhatsApp Bot JosiHack est EN LIGNE'));
app.listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Serveur Web de maintien en vie démarré sur le port ${PORT}`));

// Start the bot with a catch for fatal errors
connectToWhatsApp().catch(err => console.log("[FATAL ERROR]", err));

// --- GLOBAL ERROR HANDLERS ---
// Empêche le bot de crasher complètement si WhatsApp ferme la connexion brutalement (Erreur EPIPE)
process.on('uncaughtException', function (err) {
    console.error('[UNCAUGHT EXCEPTION]', err.message || err);
});

process.on('unhandledRejection', function (err) {
    console.error('[UNHANDLED REJECTION]', err.message || err);
});

// --- AUTO-PING (KEEP-ALIVE INTERNE) ---
// Ping sa propre URL Render toutes les 5 minutes pour éviter la mise en veille
const RENDER_URL = "https://josihackbot.onrender.com";
setInterval(async () => {
    try {
        await fetch(RENDER_URL);
    } catch (err) {
        console.log(`[AUTO-PING] Échec du ping interne: ${err.message}`);
    }
}, 4 * 60 * 1000); // 4 minutes
