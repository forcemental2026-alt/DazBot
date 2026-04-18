# 🤖 DazBot - WhatsApp Status Bot

Ce bot WhatsApp, développé avec *Node.js* et *Baileys*, est conçu spécifiquement pour détecter et interagir automatiquement avec les statuts WhatsApp de vos contacts (et les vôtres !). 

---

## 🚀 1. Installation et Démarrage

### Prérequis
Assurez-vous d'avoir installé **Node.js** sur votre ordinateur avant de l'exécuter.

### Installation
Ouvrez votre terminal dans ce dossier et lancez :
```bash
npm install
```

### Connexion
Pour démarrer le bot :
```bash
npm start
```
*Le bot va afficher un Code à 8 caractères (Pairing Code). Ouvrez WhatsApp sur votre téléphone, allez dans "Appareils liés" -> "Lier un appareil" -> "Se connecter avec un numéro de téléphone" et entrez ce code.*

---

## 🛠 2. Configuration (`config.js`)

Vous pouvez paramétrer le comportement de base en éditant le fichier `config.js` :
- `phoneNumber`: **(Obligatoire)** Mettez votre numéro complet avec indicatif pays sans +.
- `likeMyOwnStatus` : Réglez sur `true` pour que le bot "like" vos envois ou `false`.
- `reactionEmojis`: Liste d'émojis que le bot tirera au hasard par défaut.
- `autoReplyMessage`: (Optionnel) Un texte automatique envoyé en privé à la personne après avoir "liké" son statut.
- `whitelist` / `blacklist` : Limitez le bot pour qu'il ne réagisse qu'aux statuts des contacts dans la whitelist, ou ignore ceux qui sont dans la blacklist. *(Format : "33612345678@s.whatsapp.net")*

---

## 📱 3. Commandes sur WhatsApp

Vous pouvez contrôler le bot en temps réel directement en vous envoyant un message à **vous-même** (Message à vous-même) ou sur un groupe. Le bot n'écoute que **vous**.

| Commande | Explication |
|----------|-------------|
| `?dazstatus on` | **Bouton ON central.** Active la fonction de réactions de l'ensemble du bot instantanément. |
| `?dazstatus off` | **Bouton OFF central.** Désactive la fonction de réactions de l'ensemble du bot instantanément. |
| `?dazstatusuni` | **Aide.** Affiche le menu d'aide avec l'état actuel des statuts (activés/désactivés + mode emoji). |
| `?dazstatusuni <emoji>` | Force le bot à utiliser **cet emoji 100% du temps** (exemple : `?dazstatusuni ❤️` ou `?dazstatusuni 🍉`). Réactive aussi automatiquement les likes globaux. |
| `?dazstatusuni random` | Annule l'emoji spécifique. Le bot recommence à piocher **aléatoirement** dans la grande liste de votre fichier `config.js`. |
| `?dazonly <numéro> [emoji]` | **Focus Like.** Le bot ne likera que les statuts de ce numéro. Optionnel : précise un emoji spécifique. |
| `?dazonlyview <numéro>` | **Focus Vision.** Le bot ne regardera que les statuts de ce numéro. |
| `?dazantionly <add/remove/list/off> [num/here]` | **Focus Anti-Delete.** Gère la liste des cibles à surveiller. **Récupère désormais les photos/vidéos supprimées !** |
| `?dazvvonly <add/remove/list/off> [num/here]` | **Focus Vue Unique.** Gère la liste des cibles à surveiller pour les médias éphémères. |
| `?dazreset` | **Réinitialisation.** Désactive tous les modes Focus d'un coup. |
| `?dazstats` | **Statistiques Globales.** Affiche les stats et le TOP 5. |
| `?dazonly off` | Désactive le mode Focus Status. |
| `?planstatus HH:mm` | **Programmer un statut.** Répondez à un texte, photo, vidéo ou audio avec cette commande pour le poster plus tard. |
| `?planmsg HH:mm <numéro>` | **Programmer un message.** Répondez à un texte ou média pour l'envoyer à quelqu'un à une heure précise. |
| `?menu` (ou `?help`) | **Menu.** Affiche toutes les fonctionnalités du bot. |

---

## 🔒 4. Sécurité & Fiabilité

- Les anciens statuts et commandes postés alors que le bot était éteint seront ignorés par sécurité au démarrage.
- Toutes les identités de session WhatsApp sont chiffrées de bout-en-bout et stockées silencieusement.

**Développez et personnalisez autant que vous voulez. By DazBot ! 💻🔧**
