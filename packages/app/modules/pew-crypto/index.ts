/**
 * The pairing's cipher, natively (see `ios/PewCryptoModule.swift`). Optional:
 * a build without it (Android, web, an older dev client) keeps the JS cipher.
 */
import { requireOptionalNativeModule } from "expo";
import type { e2e } from "@pew2/protocol";

const native = requireOptionalNativeModule<e2e.NativeAead>("PewCrypto");

export const nativeAead: e2e.NativeAead | undefined = native ?? undefined;
