// Notification service extension: runs for each push the daemon sends (they
// carry `mutable-content`), while the app itself is suspended. It changes
// nothing about the banner; it folds the push into the widget's snapshot and
// asks WidgetKit to redraw, so the widget says "needs you" as the approval
// lands rather than the next time the app is opened.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "notification-service",
  name: "PewNotifications",
  bundleIdentifier: ".notifications",
  // The app's own floor (Expo SDK 54): a push must reach every phone the app
  // installs on, and this runs before iOS shows any of them.
  deploymentTarget: "15.1",
  frameworks: ["UserNotifications", "WidgetKit"],
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
