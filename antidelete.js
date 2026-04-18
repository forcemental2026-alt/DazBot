const config = require('./config.js');

let messageCache = new Map();
const CACHE_LIMIT = 2000;
let focusAntiDeleteJid = null;
let onRecoveredCallback = null;

/**
 * Définit le callback pour les statistiques.
 */
const setOnRecovered = (cb) => {
    onRecoveredCallback = cb;
};

/**
 * Définit ou supprime le focus anti-suppression.
 */
const setFocus = (jid) => {
    focusAntiDeleteJid = jid;
};

/**
 * Récupère le focus actuel.
 */
const getFocus = () => focusAntiDeleteJid;

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
        // Si focusAntiDeleteJid est défini, on ne rapporte QUE si le message vient de ce numéro OU de ce chat (groupe)
        if (focusAntiDeleteJid && !cached.from.includes(focusAntiDeleteJid) && !cached.chat.includes(focusAntiDeleteJid)) {
            console.log(`[ANTIDELETE] Suppression ignorée (ID: ${deletedId}) car focus sur ${focusAntiDeleteJid} (Message de ${cached.from} dans ${cached.chat}).`);
            return;
        }

        try {
            const destination = config.antiDeleteChat || (sock.user.id.split(':')[0] + '@s.whatsapp.net');
            const sender = cached.from.split('@')[0];
            const chatName = cached.chat.endsWith('@g.us') ? "Groupe" : "Privé";
            const time = new Date(cached.timestamp * 1000).toLocaleString('fr-FR');

            const report = `╭───〔 ❌ *MESSAGE SUPPRIMÉ* 〕───⬣\n` +
                           `│ 👤 *De:* +${sender}\n` +
                           `│ 📍 *Type:* ${chatName}\n` +
                           `│ ⏰ *Heure:* ${time}\n` +
                           `│ 💬 *Contenu:* ${cached.content}\n` +
                           `╰──────────────⬣`;

            await sock.sendMessage(destination, { text: report });
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

        // Détection de suppression directe (ProtocolMessage)
        const protocolMsg = msg.message.protocolMessage;
        if (protocolMsg) {
            console.log(`[ANTIDELETE-PROTOCOL] Type: ${protocolMsg.type}, KeyID: ${protocolMsg.key?.id}`);
            if (protocolMsg.type === 3 || protocolMsg.type === 0) {
                const deletedId = protocolMsg.key.id;
                console.log(`[ANTIDELETE] Suppression détectée dans UPSERT (Type ${protocolMsg.type}): ${deletedId}`);
                await reportRevocation(sock, deletedId);
                return;
            }
        }

        // On autorise TEMPORAIREMENT le "fromMe" pour que l'utilisateur puisse tester
        // if (msg.key.fromMe) return;

        const id = msg.key.id;
        const from = msg.key.remoteJid;
        const participant = msg.key.participant || from;
        
        let content = "";
        const type = Object.keys(msg.message)[0];
        
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
            const innerType = Object.keys(msg.message[type].message)[0];
            content = `[Vue Unique - ${innerType}]`;
        } else {
            content = `[${type}]`;
        }

        if (content) {
            messageCache.set(id, {
                from: participant,
                chat: from,
                content: content,
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
    for (const update of updates) {
        // Log de TOUS les stubs pour identifier le signal de suppression
        if (update.update?.messageStubType) {
            console.log(`[DEBUG-STUB] ID: ${update.key.id}, StubType: ${update.update.messageStubType}`);
        }

        const protocolMsg = update.update?.message?.protocolMessage || update.message?.protocolMessage;
        
        if (protocolMsg) {
            console.log(`[DEBUG-PROTO-UPDATE] Type: ${protocolMsg.type}, Target: ${protocolMsg.key?.id}`);
        }

        const isRevoke = (protocolMsg && (protocolMsg.type === 3 || protocolMsg.type === 0)) || 
                         update.update?.messageStubType === 68 || 
                         update.update?.messageStubType === 69; // Parfois 69 est lié à des erreurs de revokes

        if (isRevoke) {
            const deletedId = protocolMsg ? protocolMsg.key.id : update.key.id;
            
            // On vérifie si c'est vraiment une suppression (Type 0 peut être autre chose parfois)
            // Mais si on l'a dans le cache, on le traite comme une suppression
            if (protocolMsg && protocolMsg.type === 0) {
                console.log(`[ANTIDELETE] Signal Type 0 détecté pour: ${deletedId}`);
            }

            console.log(`[ANTIDELETE] Signal de suppression confirmé pour: ${deletedId}`);
            await reportRevocation(sock, deletedId);
        }
    }
};

module.exports = {
    handleUpsert,
    handleUpdate,
    setFocus,
    getFocus,
    setOnRecovered
};
