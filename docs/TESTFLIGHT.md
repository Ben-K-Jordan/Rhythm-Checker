# iPhone distribution

## The free path (recommended): installed PWA, no Apple fee

`.github/workflows/deploy-pages.yml` publishes `webapp/` to GitHub Pages on
every push to `main`. One-time: repo **Settings → Pages → Source: GitHub
Actions**. Then on any iPhone: open the Pages URL in Safari → Share → **Add
to Home Screen**. Full-screen, offline after first visit, updates picked up
automatically on the next online launch. Cost: **$0, forever.** Bandmates
install it from the same URL in thirty seconds.

Trade-offs vs TestFlight, honestly: no TestFlight-style install invitations
(you share a URL instead), and Safari is the runtime (which this app is built
and tested for). For this product there is no capability you give up.

# Shipping to TestFlight (optional, $99/yr)

The native iOS app is the same `webapp/` wrapped in a Capacitor shell — one
codebase, and everything still runs on-device with zero cloud calls. The
`ios/` Xcode project in this repo is generated and committed; what remains
needs Apple's tools, which only run on a Mac.

## One-time setup

1. **Apple Developer Program** — enroll at developer.apple.com ($99/yr).
   This is the only recurring cost in the entire product.
2. **A Mac with Xcode 15+** (any Mac; borrowing one for an afternoon works —
   builds are occasional, not daily). Install CocoaPods: `sudo gem install cocoapods`.
3. Clone the repo on the Mac and run:

   ```bash
   npm install          # Capacitor CLI + iOS platform (already in package.json)
   npx cap sync ios     # copies webapp/ into the iOS shell + pod install
   npx cap open ios     # opens the Xcode workspace
   ```

4. In Xcode: select the `App` target → *Signing & Capabilities* → set your
   Team (your developer account) — the bundle id `com.benjordan.rhythmchecker`
   is already configured. Xcode handles certificates automatically.

## Every release

```bash
npx cap sync ios       # pick up the latest webapp/ changes
```

Then in Xcode: *Product → Archive* → *Distribute App → TestFlight & App
Store → Upload*. Processing takes ~10 minutes on Apple's side.

In **App Store Connect → TestFlight**:
- Add your bandmates as **internal testers** (up to 100, instant, no review).
- They install the TestFlight app, accept the invite, and get every build
  you upload plus update notifications automatically.
- External testers (up to 10,000) need a one-time lightweight Beta review.

## What's already handled in this repo

- `NSMicrophoneUsageDescription` is set in `Info.plist` (mic permission
  prompt text; missing it is an instant crash on first tap).
- The webview is full-bleed with the app's ink background — no white flash.
- Mic-loss recovery, wake lock, and calibration all behave the same inside
  the native shell as in Safari; the service worker simply doesn't register
  there (Capacitor serves assets locally, so offline is inherent).
- Audio-session note: WKWebView's `getUserMedia` works from iOS 14.3+;
  TestFlight builds inherit it with no extra entitlements.

## Sanity checklist on the first TestFlight build

1. Mic prompt shows the honest description above.
2. Calibrate on the actual phone (native shell latency differs from Safari —
   it's per-device AND per-shell, which is why calibration never travels).
3. Lock the screen mid-timing-check → the app must show the reconnect
   overlay and invalidate the run, not silently mis-score it.
4. Run the pre-show ritual end to end once at rehearsal volume.

## While waiting on Apple

The PWA path still works today: host `webapp/` on GitHub Pages, open in
Safari, *Add to Home Screen*. Same app, same data model — good for testing
tonight while the developer account enrollment processes.
