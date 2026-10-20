import CryptoKit
import ExpoModulesCore
import Foundation

/// XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha): HChaCha20 derives a subkey
/// from the key and the nonce's first 16 bytes, then IETF ChaCha20-Poly1305
/// (CryptoKit) runs with that subkey and the nonce `0x00000000 || nonce[16..<24]`.
///
/// JavaScript installs this only after checking, on the device, that it
/// produces the same bytes as the JS cipher and refuses tampered frames
/// (`useNativeAead` in @pew2/protocol). Every failure here returns nil: the
/// caller treats that as a rejected frame.
public class PewCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PewCrypto")

    Function("openText") { (key: Data, nonce: Data, aad: Data, ciphertext: String) -> String? in
      guard key.count == 32, nonce.count == 24, let sealed = fromBase64Url(ciphertext), sealed.count >= 16 else {
        return nil
      }
      let n = [UInt8](nonce)
      let subkey = hchacha20(key: [UInt8](key), nonce: Array(n[0..<16]))
      let body = sealed.prefix(sealed.count - 16)
      let tag = sealed.suffix(16)
      do {
        let box = try ChaChaPoly.SealedBox(
          nonce: ChaChaPoly.Nonce(data: [0, 0, 0, 0] + Array(n[16..<24])),
          ciphertext: Data(body),
          tag: Data(tag)
        )
        let plain = try ChaChaPoly.open(box, using: SymmetricKey(data: subkey), authenticating: aad)
        return String(data: plain, encoding: .utf8)
      } catch {
        return nil
      }
    }

    Function("sealText") { (key: Data, nonce: Data, aad: Data, plaintext: String) throws -> String in
      guard key.count == 32, nonce.count == 24 else { throw Exception(name: "PewCrypto", description: "bad key or nonce") }
      let n = [UInt8](nonce)
      let subkey = hchacha20(key: [UInt8](key), nonce: Array(n[0..<16]))
      let box = try ChaChaPoly.seal(
        Data(plaintext.utf8),
        using: SymmetricKey(data: subkey),
        nonce: ChaChaPoly.Nonce(data: [0, 0, 0, 0] + Array(n[16..<24])),
        authenticating: aad
      )
      return toBase64Url(box.ciphertext + box.tag)
    }
  }
}

/// HChaCha20: 20 ChaCha rounds over (constants, key, 16-byte nonce), without
/// the final addition; the subkey is words 0-3 and 12-15, little-endian.
func hchacha20(key: [UInt8], nonce: [UInt8]) -> [UInt8] {
  func word(_ bytes: [UInt8], _ i: Int) -> UInt32 {
    UInt32(bytes[i]) | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2]) << 16 | UInt32(bytes[i + 3]) << 24
  }
  var s: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]
  for i in 0..<8 { s.append(word(key, i * 4)) }
  for i in 0..<4 { s.append(word(nonce, i * 4)) }
  func rotl(_ v: UInt32, _ c: UInt32) -> UInt32 { (v << c) | (v >> (32 - c)) }
  func quarter(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
    s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 16)
    s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 12)
    s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 8)
    s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 7)
  }
  for _ in 0..<10 {
    quarter(0, 4, 8, 12); quarter(1, 5, 9, 13); quarter(2, 6, 10, 14); quarter(3, 7, 11, 15)
    quarter(0, 5, 10, 15); quarter(1, 6, 11, 12); quarter(2, 7, 8, 13); quarter(3, 4, 9, 14)
  }
  var out: [UInt8] = []
  out.reserveCapacity(32)
  for i in [0, 1, 2, 3, 12, 13, 14, 15] {
    let v = s[i]
    out += [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]
  }
  return out
}

func fromBase64Url(_ text: String) -> Data? {
  var b = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  let remainder = b.utf8.count % 4
  if remainder == 1 { return nil }
  if remainder > 0 { b += String(repeating: "=", count: 4 - remainder) }
  return Data(base64Encoded: b)
}

func toBase64Url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}
