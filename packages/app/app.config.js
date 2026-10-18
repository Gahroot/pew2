/**
 * Keeps one person's Expo account out of everyone's repo.
 *
 * `eas init` writes `owner` and `extra.eas.projectId` straight into `app.json`,
 * which pins the project to whoever ran it. In a project whose whole pitch is
 * "fork it and rebuild", that is the wrong default twice over: a fork inherits
 * an account it cannot push to, and the first `eas build` in that fork either
 * fails or silently retargets someone else's project.
 *
 * So `app.json` stays account-neutral and the identity is supplied per machine:
 *
 * 1. `EAS_OWNER` / `EAS_PROJECT_ID` in the environment — for CI.
 * 2. `eas-project.json` beside this file — for a laptop. Gitignored.
 *
 * With neither, the config is exactly what is committed, which is what a fresh
 * clone should see. `npx eas init` then fills it in for that person.
 */
const fs = require("node:fs");
const path = require("node:path");

const { expo } = require("./app.json");

/** Whose account this working copy builds under. Absent on a fresh clone. */
function localIdentity() {
  const file = path.join(__dirname, "eas-project.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // Never fail a build over this: an unreadable file means "not configured",
    // and the message has to say which file, or it reads as an Expo bug.
    console.warn(`Ignoring ${file}: ${error.message}`);
    return {};
  }
}

/**
 * The App Group the app and its extensions share: always `group.` + the app's
 * bundle id. A group belongs to one Apple team, so a fork signing under its
 * own id cannot use the upstream one: its provisioning profiles would never
 * include it, and the archive fails on every target. Deriving it means a fork
 * changes one value, and the widget code reads it the same way (see
 * `widgetAppGroup` and `targets/_shared/PewSnapshot.swift`).
 */
function appGroupFor(bundleId) {
  return `group.${bundleId}`;
}

/**
 * Which Apple identity builds this: the bundle id and the team, from
 * `IOS_BUNDLE_ID` / `APPLE_TEAM_ID` when a build profile sets them, otherwise
 * what `app.json` says. The App Group follows the bundle id. With neither
 * variable the result is exactly `app.json`.
 */
function iosIdentity(ios, env) {
  const bundleIdentifier = env.IOS_BUNDLE_ID ?? ios.bundleIdentifier;
  return {
    ...ios,
    bundleIdentifier,
    appleTeamId: env.APPLE_TEAM_ID ?? ios.appleTeamId,
    entitlements: {
      ...ios.entitlements,
      "com.apple.security.application-groups": [appGroupFor(bundleIdentifier)],
    },
  };
}

module.exports = () => {
  const local = localIdentity();
  const owner = process.env.EAS_OWNER ?? local.owner;
  const projectId = process.env.EAS_PROJECT_ID ?? local.projectId;

  return {
    ...expo,
    ios: iosIdentity(expo.ios, process.env),
    ...(owner ? { owner } : {}),
    ...(projectId
      ? { extra: { ...expo.extra, eas: { ...expo.extra?.eas, projectId } } }
      : {}),
  };
};
