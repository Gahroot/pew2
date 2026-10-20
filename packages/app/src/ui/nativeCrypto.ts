/**
 * Hand the pairing's frames to the native cipher when this build has one and
 * it passes the on-device agreement check (`e2e.useNativeAead`). Run once,
 * before the first frame. Otherwise nothing changes: the JS cipher stays.
 */
import { e2e } from "@pew2/protocol";
import { nativeAead } from "../../modules/pew-crypto";

export const nativeCipher = e2e.useNativeAead(nativeAead);
if (__DEV__) console.log(`[pew2] frame cipher: ${nativeCipher ? "native" : "js"}`);
