# Switches a live call between the receiver (or AirPods) and the loudspeaker.
# Local and tiny on purpose: expo-audio can set a category but not override the
# output port, and react-native-webrtc 124 exposes no route switch.
Pod::Spec.new do |s|
  s.name           = 'PewAudioRoute'
  s.version        = '1.0.0'
  s.summary        = 'Speaker on/off for pew2 voice calls.'
  s.author         = 'pew2'
  s.homepage       = 'https://github.com/kenkaiii/pew2'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'AVFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files   = '**/*.swift'
end
