import ExpoModulesCore
import WidgetKit

public class PewWidgetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PewWidget")

    /// Store the snapshot JSON under `key` in the App Group `group`, then ask
    /// every widget to redraw. False when the group is not available (an
    /// unsigned build, or an entitlement missing), so the caller can retry.
    Function("write") { (group: String, key: String, json: String) -> Bool in
      guard let defaults = UserDefaults(suiteName: group) else { return false }
      defaults.set(json, forKey: key)
      WidgetCenter.shared.reloadAllTimelines()
      return true
    }
  }
}
