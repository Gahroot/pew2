import AppKit
import SwiftUI

/// The preview renderer's Pew: the same PNG the widget's asset catalog holds,
/// read from disk because there is no app bundle here.
func pewMark() -> Image {
  let path = ProcessInfo.processInfo.environment["PEW_MARK"] ?? ""
  if let image = NSImage(contentsOfFile: path) { return Image(nsImage: image) }
  return Image(systemName: "circle.fill")
}
