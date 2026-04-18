const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const config = require('./config.js');

let messageCache = new Map();
const CACHE_LIMIT = 2000;
let focusAntiDeleteJids = new Set();
let onRecoveredCallback = null;

/**
 * Définit le callback pour les statistiques.
 */
const setOnRecovered = (cb) => {
    onRecoveredCallback = cb;
};

/**
 * Ajoute une cible au focus anti-suppression.
 */
const addFocus = (jid) => {
    focusAntiDeleteJids.add(jid);
};

/**
 * Supprime une cible du focus.
 */
const removeFocus = (jid) => {
    focusAntiDeleteJids.delete(jid);
};

/**
 * Vide la liste du focus.
 */
const clearFocus = () => {
    focusAntiDeleteJids.clear();
};

/**
 * Récupère la liste actuelle du focus.
 */
const getFocusList = () => Array.from(focusAntiDeleteJids);

/**
 * Fonction interne pour signaler une suppression.
 */
const reportRevocation = async (sock, deletedId) => {
    if (!config.antiDeleteEnabled) {
        console.log(`[ANTIDELETE] Suppression ignorée (ID: ${deletedId}) car l'option est sur OFF.`);
        return;
    }

    const cached = messageCache.get(deletedId);
    if (cached) {
        // Si focusAntiDeleteJids n'est pas vide, on ne rapporte QUE si le message vient d'une cible (contact ou chat/groupe)
        if (focusAntiDeleteJids.size > 0) {
            const senderNum = cached.from.split('@')[0];
            const chatNum = cached.chat.split('@')[0];
            
            const isTargeted = Array.from(focusAntiDeleteJids).some(jid => 
                cached.from.includes(jid) || cached.chat.includes(jid) || senderNum === jid || chatNum === jid
            );

            if (!isTargeted) {
                console.log(`[ANTIDELETE] Suppression ignorée (ID: ${deletedId}) car focus actif et cible non correspondante.`);
                return;
            }
        }

        try {
            // Par défaut, on renvoie dans la discussion d'origine (groupe ou privé)
            // Si antiDeleteChat est configuré dans config.js, on envoie là-bas à la place.
            const destination = config.antiDeleteChat || cached.chat;
            
            const sender = cached.from.split('@')[0];
            const chatName = cached.chat.endsWith('@g.us') ? "Groupe" : "Privé";
            const time = new Date(cached.timestamp * 1000).toLocaleString('fr-FR');

            const report = `╭───〔 ❌ *MESSAGE SUPPRIMÉ* 〕───⬣\n` +
                           `│ 👤 *De:* +${sender}\n` +
                           `│ 📍 *Type:* ${chatName}\n` +
                           `│ ⏰ *Heure:* ${time}\n` +
                           `│ 💬 *Contenu:* ${cached.content}\n` +
                           `╰──────────────⬣`;

            if (cached.media) {
                if (cached.type === 'imageMessage') {
                    await sock.sendMessage(destination, { image: cached.media, caption: report });
                } else if (cached.type === 'videoMessage') {
                    await sock.sendMessage(destination, { video: cached.media, caption: report });
                } else if (cached.type === 'audioMessage') {
                    await sock.sendMessage(destination, { audio: cached.media, mimetype: 'audio/mp4', ptt: true });
                    await sock.sendMessage(destination, { text: report });
                } else if (cached.type === 'stickerMessage') {
                    await sock.sendMessage(destination, { sticker: cached.media });
                    await sock.sendMessage(destination, { text: report });
                } else {
                    await sock.sendMessage(destination, { text: report });
                }
            } else {
                await sock.sendMessage(destination, { text: report });
            }
            
            console.log(`[ANTIDELETE] Rapport envoyé pour ${deletedId}`);
            if (onRecoveredCallback) onRecoveredCallback(sender);
            messageCache.delete(deletedId);
        } catch (e) {
            console.error("[ANTIDELETE] Send error:", e);
        }
    } else {
        console.log(`[ANTIDELETE] Message ${deletedId} supprimé mais absent du cache.`);
    }
};

/**
 * Stocke les messages entrants dans le cache.
 */
const handleUpsert = async (sock, m) => {
    try {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        // Détection de suppression directe via ProtocolMessage dans UPSERT
        const protocolMsg = msg.message.protocolMessage;
        if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.type === 3)) {
            const deletedId = protocolMsg.key?.id;
            if (deletedId) {
                console.log(`[ANTIDELETE] Suppression détectée dans UPSERT (ID: ${deletedId})`);
                await reportRevocation(sock, deletedId);
                return;
            }
        }

        // On ignore les messages du bot lui-même pour ne pas saturer le cache
        if (msg.key.fromMe) return;

        const id = msg.key.id;
        const from = msg.key.remoteJid;
        const participant = msg.key.participant || from;
        
        let content = "";
        let type = Object.keys(msg.message)[0];
        
        // Gérer les messages extended text ou conversations
        if (type === 'conversation') {
            content = msg.message.conversation;
        } else if (type === 'extendedTextMessage') {
            content = msg.message.extendedTextMessage.text;
        } else if (type === 'imageMessage') {
            content = msg.message.imageMessage.caption ? `[Image] ${msg.message.imageMessage.caption}` : "[Image]";
        } else if (type === 'videoMessage') {
            content = msg.message.videoMessage.caption ? `[Vidéo] ${msg.message.videoMessage.caption}` : "[Vidéo]";
        } else if (type === 'audioMessage') {
            content = "[Audio/Vocal]";
        } else if (type === 'stickerMessage') {
            content = "[Sticker]";
        } else if (type === 'documentMessage') {
            content = `[Document] ${msg.message.documentMessage.fileName || ""}`;
        } else if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2') {
            const innerMsg = msg.message[type].message;
            type = Object.keys(innerMsg)[0];
            content = `[Vue Unique - ${type}]`;
        } else {
            content = `[${type}]`;
        }

        // Téléchargement média si c'est un média (Image, Vidéo, Audio, Sticker)
        let mediaBuffer = null;
        if (['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'].includes(type)) {
            try {
                // On ne télécharge que les fichiers pas trop gros (< 15 Mo)
                const mediaSize = msg.message[type]?.fileLength || 0;
                if (mediaSize < 15 * 1024 * 1024) {
                    mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                }
            } catch (e) { console.error("[ANTIDELETE] Media download failed:", e.message); }
        }

        if (content || mediaBuffer) {
            messageCache.set(id, {
                from: participant,
                chat: from,
                content: content,
                media: mediaBuffer,
                type: type,
                timestamp: msg.messageTimestamp,
                id: id
            });
            console.log(`[ANTIDELETE] Message mis en cache: ${id} (${type})`);
        }

        if (messageCache.size > CACHE_LIMIT) {
            const oldestKey = messageCache.keys().next().value;
            messageCache.delete(oldestKey);
        }
    } catch (e) {
        console.error("[ANTIDELETE] Cache error:", e);
    }
};

/**
 * Détecte les messages supprimés dans l'event update.
 */
const handleUpdate = async (sock, updates) => {
    for (const u of updates) {
        const key = u.key;
        const update = u.update;
        
        if (update.pollUpdates || update.reaction) continue;
        
        // Détection Baileys classique pour les révocations
        // On vérifie stubType 68 (revoke) ou le champ revocation
        // On vérifie aussi si l'update contient un protocolMessage de type revoke (0)
        const isRevoke = update.messageStubType === 68 || 
                         update.revocation || 
                         update.message?.protocolMessage?.type === 0 ||
                         update.message?.protocolMessage?.type === 3;

        if (isRevoke) {
            const deletedId = key.id || update.message?.protocolMessage?.key?.id;
            if (deletedId) {
                console.log(`[ANTIDELETE] Suppression détectée dans UPDATE (ID: ${deletedId})`);
                await reportRevocation(sock, deletedId);
            }
        }
    }
};

module.exports = {
    handleUpsert,
    handleUpdate,
    addFocus,
    removeFocus,
    clearFocus,
    getFocusList,
    setOnRecovered
};
