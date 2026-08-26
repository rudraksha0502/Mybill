/* MYBILL — Public configuration
 * -------------------------------------------------------------
 * GOOGLE_CLIENT_ID is an OAuth 2.0 "Web application" Client ID from
 * Google Cloud Console. This value is PUBLIC by design (it identifies
 * your app, it does not authenticate as anyone) and is safe to commit
 * to a public GitHub repo. Never put a Client SECRET or service-account
 * key here or anywhere in this frontend.
 *
 * Leave the placeholder below to run MYBILL in local-only mode
 * (all data stays in this browser's storage). Follow SETUP.md to
 * get your own Client ID and enable Google Drive sync.
 */
window.MYBILL_CONFIG = {
  GOOGLE_CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com'
};
