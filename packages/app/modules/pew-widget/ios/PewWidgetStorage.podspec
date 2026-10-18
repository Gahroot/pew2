# The app's half of the home-screen widget: writes its snapshot into the App
# Group and asks WidgetKit to redraw. Local rather than @bacons/apple-targets'
# ExtensionStorage, whose podspec floors at iOS 16.4: below the app's 15.1, so
# autolinking dropped it without a word and the widget was never written to.
Pod::Spec.new do |s|
  # Not `PewWidget`: that is the widget extension's target, and two Swift
  # modules of one name in one build overwrite each other's .swiftmodule.
  s.name           = 'PewWidgetStorage'
  s.version        = '1.0.0'
  s.summary        = 'Writes the pew2 widget snapshot to the App Group.'
  s.author         = 'pew2'
  s.homepage       = 'https://github.com/kenkaiii/pew2'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'WidgetKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files   = '**/*.swift'
end
