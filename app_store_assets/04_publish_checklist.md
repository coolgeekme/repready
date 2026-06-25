# SalesReady Publish Checklist

What you should do, in order, BEFORE tapping Publish in Emergent:

## A. Already done ✅ (in this session)
- [x] App renamed to **SalesReady** (app.json + UI strings)
- [x] Bundle identifier set: `com.coolgeek.salesready` (iOS + Android)
- [x] Build number initialized to **1**
- [x] Version string at **1.0.0**
- [x] `ITSAppUsesNonExemptEncryption: false` (avoids extra encryption export questionnaire)
- [x] Version footer in Settings (verify build/runtime per release)
- [x] Admin / comp infrastructure ready (won't ship visibly until you flag users)

## B. Manual items YOU need to do

### Apple Developer Portal
- [ ] Register `com.coolgeek.salesready` as App ID under your Team
- [ ] Generate App Store Connect API Key (Admin role)
- [ ] Save the `.p8` + Key ID + Issuer ID securely

### App Store Connect
- [ ] Create app with name **SalesReady**
- [ ] Paste copy from `02_app_store_listing.md`
- [ ] Upload **app icon** (1024×1024 PNG, no transparency)
- [ ] Upload **5 iPhone 6.7" screenshots** (use Option B from screenshot guide — screenshot.rocks with headlines from `01_marketing_headlines.md`)
- [ ] Fill in **App Privacy** questionnaire (see table at bottom of `02_app_store_listing.md`)
- [ ] Add **Privacy Policy URL** (host `03_privacy_policy.md` on your domain or Notion public page first)
- [ ] Add **Support URL** (your email or a Notion FAQ page)
- [ ] Select **Business** primary category, **Productivity** secondary
- [ ] Set age rating to **4+** via the questionnaire

### Final code review
- [ ] Confirm `/app/frontend/app.json` shows `com.coolgeek.salesready` and version 1.0.0 (already done)
- [ ] Replace `/app/frontend/assets/images/icon.png` with your real 1024×1024 SalesReady icon (currently a placeholder)
- [ ] Replace `/app/frontend/assets/images/splash-icon.png` with a SalesReady splash variant (transparent PNG over the black background already configured)
- [ ] Test the app one more time in Expo Go on a real iPhone — sign up, generate a post, schedule it
- [ ] Read `/app/memory/test_credentials.md` if you need a test account

### Tap Publish
- [ ] In Emergent, tap **Publish** → iOS production
- [ ] Enter Team ID + Bundle ID + Apple Connect API key
- [ ] Wait ~15-30 min for EAS Build
- [ ] In App Store Connect, push the build to TestFlight
- [ ] Test on YOUR iPhone via the TestFlight app for 24h
- [ ] If happy → click **Submit for Review** in App Store Connect
- [ ] Apple review typically 24-48h
- [ ] Once approved, release! 🚀

---

## Files in this folder

- `01_marketing_headlines.md` — text overlay copy for the 5 screenshots
- `02_app_store_listing.md` — name, subtitle, description, keywords, privacy disclosure
- `03_privacy_policy.md` — starter privacy policy (fill in your details)
- `04_publish_checklist.md` — this file
