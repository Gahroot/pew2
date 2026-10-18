/**
 * The app's half of the home-screen widget (see `ios/PewWidgetModule.swift`).
 *
 * Optional, so a build without the native module (Android, web, an old dev
 * client) gets a no-op instead of a crash at import.
 */
import { requireOptionalNativeModule } from "expo";

interface PewWidgetNative {
  write(group: string, key: string, json: string): boolean;
}

const native = requireOptionalNativeModule<PewWidgetNative>("PewWidget");

/** Write the widget's snapshot and redraw it. False when nothing was written. */
export function writeWidgetSnapshot(group: string, key: string, json: string): boolean {
  return native?.write(group, key, json) ?? false;
}
