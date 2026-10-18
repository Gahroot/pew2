import SwiftUI

/// Pew, from this target's asset catalog (`assets/widget-pew.png`).
///
/// A function of its own so the preview renderer
/// (`scripts/widget-preview`) can supply the same picture from disk: it draws
/// these views outside any app bundle, where `Image("pew")` finds nothing.
func pewMark() -> Image {
  Image("pew")
}
