require 'json'

Pod::Spec.new do |s|
  s.name           = 'Pew2Voice'
  s.version        = '1.0.0'
  s.summary        = 'Audio session control for PEW2 voice conversations'
  s.description    = 'AVAudioSession activation/deactivation with notifyOthersOnDeactivation, interruption and route events.'
  s.author         = 'pew2'
  s.homepage       = 'https://github.com/KenKaiii/pew2'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end
