module.exports = {
    // Command prefix
    prefix: "?",

    // Owner number (for specialized commands)
    ownerNumber: "22947831885",

    // Array of emojis the bot will randomly choose from to react to statuses
    reactionEmojis: ["🩷", "❤️", "💙", "🖤", "❤️", "🔥", "🤍", "💞", "💕", "💓", "💝", "❤️", "🔥", "🫶", "🙌", "🌚", "🙂", "↔️", "🫶🏼", "👀", "🥺", "😎", "🤩"],

    // Optional auto-reply message sent to the user when a status is reacted to.
    // Set to empty string "" to disable auto-reply.
    autoReplyMessage: "",

    // Set to true to automatically like your own posted statuses
    likeMyOwnStatus: true,

    // If whitelist is not empty, the bot will ONLY react to statuses from these numbers.
    // Format must be: "COUNTRY_CODE_NUMBER@s.whatsapp.net"
    // e.g., ["1234567890@s.whatsapp.net"]
    whitelist: [],

    // If blacklist is not empty, the bot will IGNORE statuses from these numbers.
    // Format must be exactly like whitelist items.
    blacklist: [],

    // Set to true to use Pairing Code instead of QR code for login
    usePairingCode: true,

    // Provide your phone number if using pairing code (e.g., "1234567890")
    // Include the country code but no '+' sign or spaces.
    phoneNumber: "22947831885",
    
    // Supabase credentials for remote auth state storage
    supabaseUrl: "https://ltzaqirhbovuiipwfqmf.supabase.co",
    supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0emFxaXJoYm92dWlpcHdmcW1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTQ4MDksImV4cCI6MjA5MDI5MDgwOX0.XmBM-S_JJ3aQj7vXXB6fdYIhsCN3SYVwG5jVCDwtUvU"
};
