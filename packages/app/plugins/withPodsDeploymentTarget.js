/**
 * Raises every pod's iOS deployment target to the floor the installed Xcode
 * accepts.
 *
 * Some pods still declare an iOS 9/12 target (SDWebImage, ReachabilitySwift).
 * Newer Xcode releases refuse anything below 15.0 outright, which fails the
 * archive in those pod targets rather than anywhere that names this app. Only
 * targets below the floor are touched, so a pod that asks for more keeps it.
 */
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const MARKER = "# pew2: pod deployment target floor";
const FLOOR = "15.1";

const SNIPPET = `    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |bc|
        current = bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || Gem::Version.new(current.to_s) < Gem::Version.new('${FLOOR}')
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${FLOOR}'
        end
      end
    end
`;

module.exports = function withPodsDeploymentTarget(config) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(file, "utf8");
      if (podfile.includes(MARKER)) return cfg;
      const hook = /^( *)post_install do \|installer\|\n/m;
      if (!hook.test(podfile)) {
        throw new Error("withPodsDeploymentTarget: no post_install block in the Podfile to extend");
      }
      fs.writeFileSync(file, podfile.replace(hook, (line) => line + SNIPPET));
      return cfg;
    },
  ]);
};
