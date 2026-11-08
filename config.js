/* Bracket settings for the hosted site.

   firebase holds the public web config from the Firebase console
   (Project settings > General > Your apps). These identifiers are meant to
   be published. They are not an Admin SDK credential and they cannot grant
   billing access.

   Sign-in uses apiKey and projectId. authDomain, storageBucket,
   messagingSenderId, and appId are kept so the web config stays intact.
   measurementId is intentionally not copied: Bracket does not load
   Analytics and does not send measurement events.

   The Bracket server (see README.md) owns usernames, Stripe, and paid
   access. Put this same apiKey in the server's FIREBASE_WEB_API_KEY.
   Do not put Stripe secrets or the Firebase Admin credential in this file.

   apiBase: URL of the Bracket server with no trailing slash. Empty means
   this site's own origin.

   The prices below are display copy. The server charges from its own price
   allowlist and will refuse a mismatched price. */
window.BRACKET_CONFIG = {
  firebase: {
    apiKey: "AIzaSyD5JE62xVaHn5uDvWPr7SaysaD6byzzyvg",
    authDomain: "bracket-2b961.firebaseapp.com",
    projectId: "bracket-2b961",
    storageBucket: "bracket-2b961.firebasestorage.app",
    messagingSenderId: "738923787461",
    appId: "1:738923787461:web:e4678adbed978a28af6cac"
  },
  apiBase: "",
  feedback: "https://x.com/jonzormann",
  subscription: {
    US: { currency: "USD", amount: "9.99", interval: "month" },
    CA: { currency: "CAD", amount: "9.99", interval: "month" }
  }
};
