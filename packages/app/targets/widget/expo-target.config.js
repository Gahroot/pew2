// Home and Lock Screen widget: which conversations are waiting on you, which
// are working, which have something new. Reads the snapshot the app (and the
// notification service extension) write to the App Group; ships no JS.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "PewWidget",
  displayName: "pew2",
  bundleIdentifier: ".widget",
  // `containerBackground` and the Lock Screen families. An older phone simply
  // does not offer the widget; the app itself is unaffected.
  deploymentTarget: "17.0",
  colors: {
    // theme.color.bg: the gallery preview and the widget's own background.
    $widgetBackground: "#0a0a0c",
    // Pew's coral (`src/pew/palette.ts` PEW2_PEW base).
    $accent: "#e07a5a",
  },
  images: {
    pew: "../../assets/widget-pew.png",
  },
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
