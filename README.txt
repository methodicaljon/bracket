BRACKET - installable app

What's in this folder
  index.html             the app (everything is inside this one file)
  config.js              turns on sign-in and sync (see step 4)
  firestore.rules        database rules to paste into Firebase (step 4)
  manifest.webmanifest   app name, colours and icons
  sw.js                  lets it open with no signal after the first visit
  icon-*.png             home-screen icons

1. Put it online
   Upload the whole folder to your site, for example plazardrs.com/bracket/
   It has to be served over https for installing to work.

2. Install it on your phone
   Open the link in Chrome on Android, tap the three-dot menu, then
   "Install app" (or "Add to Home screen"). It opens full-screen like any app.

3. Make an APK (optional)
   Go to pwabuilder.com, paste your link, pick Android and download the
   package. It includes an APK you can install directly and an AAB file
   for the Google Play Store.

4. Turn on accounts and sync (optional, free)
   Each person signs in with an email and password and gets their own plan on
   every device. The plan is encrypted on the phone with that person's
   password before it is uploaded, so you (the site owner) can't read it.

   a. Go to console.firebase.google.com (easiest on a computer) and create
      a project. Google Analytics can stay off. No credit card needed.
   b. Add a web app (the </> icon). Copy apiKey and projectId from the
      config it shows you into config.js.
   c. Security > Authentication > Get started > Sign-in method:
      turn on Email/Password and save.
   d. Databases & Storage > Firestore > Create database. If it asks for an
      edition, pick Standard. Keep the database ID "(default)", pick the
      Toronto location (northamerica-northeast2, it can't be changed later)
      and start in production mode.
   e. On the Firestore Rules tab, replace everything with firestore.rules
      and press Publish.
   f. Optional: Project settings > Public-facing name = Bracket, so reset
      emails say Bracket.
   g. Upload config.js with the rest of the folder, open the site, and go to
      Settings > Sync > Sign in > Create account.

   If something is missing, the sign-in screen names the Firebase step to
   fix. Free plan limits are far more than a few dozen people need. Password
   reset emails come from noreply@<your project>.firebaseapp.com, so tell
   people to check spam. A reset can't unlock the encrypted plan by itself:
   the app asks for the old password, or lets them replace the synced copy
   with the plan on their device.

Privacy: pay stubs, bank files and your resume are read on the phone and
never uploaded. Without sync, the plan is saved only in that phone's browser,
so use Settings > "Save a backup" now and then (clearing Chrome's data for
the site erases it). With sync, an encrypted copy also lives in Firebase.
The "Read with Claude", "Polish with Claude" and "Ask Claude" buttons only
show up when the app is opened inside Claude.
