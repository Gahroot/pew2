# Pew rings like a phone call: PushKit (VoIP pushes) + CallKit (the system's
# incoming-call screen). Native on purpose: iOS requires a VoIP push to be
# reported to CallKit inside the PushKit callback, before any JavaScript can
# run, or it kills the app and stops delivering them.
Pod::Spec.new do |s|
  s.name           = 'PewCall'
  s.version        = '1.0.0'
  s.summary        = 'CallKit + PushKit ringing for pew2 voice calls.'
  s.author         = 'pew2'
  s.homepage       = 'https://github.com/kenkaiii/pew2'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'JitsiWebRTC'
  s.frameworks     = 'AVFoundation', 'CallKit', 'PushKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files   = '**/*.swift'
end
