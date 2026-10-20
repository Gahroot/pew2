# XChaCha20-Poly1305 for the pairing's end-to-end frames, on CryptoKit.
# The JS cipher decrypted a long conversation's history at ~2 ms per KB and
# froze the app for seconds; this is the same construction, natively.
Pod::Spec.new do |s|
  s.name           = 'PewCrypto'
  s.version        = '1.0.0'
  s.summary        = 'Native XChaCha20-Poly1305 for pew2 frames.'
  s.author         = 'pew2'
  s.homepage       = 'https://github.com/kenkaiii/pew2'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CryptoKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files   = '**/*.swift'
end
