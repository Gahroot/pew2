// Draws every widget, at every size, to PNGs: the real views from
// `targets/widget/PewWidgetViews.swift`, on the gallery's sample data.
//
// What it cannot show is WidgetKit's own treatment: the Lock Screen's
// monochrome tinting is approximated (white on a dark wallpaper), and the
// system's content margins are applied by hand (16pt, iOS's default).
//
//   scripts/widget-preview.sh [out-dir]

import AppKit
import SwiftUI

// iPhone 17 Pro (402pt wide) widget sizes, in points.
let small = CGSize(width: 170, height: 170)
let medium = CGSize(width: 364, height: 170)
let large = CGSize(width: 364, height: 382)
let circular = CGSize(width: 76, height: 76)
let rectangular = CGSize(width: 172, height: 76)

let now = Date()
let sample = PewSnapshot.sample(now: now)

struct HomeTile<Content: View>: View {
  let size: CGSize
  @ViewBuilder let content: Content

  var body: some View {
    content
      .padding(16)
      .frame(width: size.width, height: size.height)
      .background(Color.pewBg)
      .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.5))
  }
}

struct LockTile<Content: View>: View {
  let size: CGSize
  @ViewBuilder let content: Content

  var body: some View {
    content
      .frame(width: size.width, height: size.height)
      .foregroundStyle(.white)
      .environment(\.colorScheme, .dark)
  }
}

struct Labelled<Content: View>: View {
  let label: String
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      content
      Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.55))
    }
  }
}

struct Sheet<Content: View>: View {
  let title: String
  let subtitle: String
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.system(size: 22, weight: .bold)).foregroundStyle(.white)
        Text(subtitle).font(.system(size: 13)).foregroundStyle(.white.opacity(0.6))
      }
      content
      Text("Sample data, as in the widget gallery. Rendered from targets/widget/PewWidgetViews.swift.")
        .font(.system(size: 10)).foregroundStyle(.white.opacity(0.4))
    }
    .padding(28)
    .environment(\.pewLinks, false)
    .background(
      LinearGradient(colors: [Color(pewHex: "#2a1f3d"), Color(pewHex: "#1b2a3a"), Color(pewHex: "#3a2a20")], startPoint: .topLeading, endPoint: .bottomTrailing)
    )
    .environment(\.colorScheme, .dark)
  }
}

struct LockRow<Content: View>: View {
  @ViewBuilder let content: Content
  var body: some View {
    HStack(alignment: .top, spacing: 18) { content }
      .padding(16)
      .background(RoundedRectangle(cornerRadius: 18).fill(Color.black.opacity(0.25)))
  }
}

@MainActor
func save<V: View>(_ view: V, _ name: String, to dir: URL) {
  let renderer = ImageRenderer(content: view)
  renderer.scale = 2
  guard let image = renderer.cgImage else { fatalError("could not render \(name)") }
  let rep = NSBitmapImageRep(cgImage: image)
  let url = dir.appendingPathComponent(name)
  try! rep.representation(using: .png, properties: [:])!.write(to: url)
  print(url.path)
}

@main
struct Preview {
  @MainActor static func main() {
    let dir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    save(
      Sheet(title: "Recent", subtitle: "Jump back into your latest conversations. Tap a row to open it.") {
        HStack(alignment: .top, spacing: 20) {
          Labelled(label: "Small") { HomeTile(size: small) { PewRecentSmall(snapshot: sample, now: now) } }
          Labelled(label: "Medium") { HomeTile(size: medium) { PewRecentList(snapshot: sample, limit: 3, now: now) } }
        }
        Labelled(label: "Large") { HomeTile(size: large) { PewRecentList(snapshot: sample, limit: PewStore.rows, now: now) } }
        Labelled(label: "Lock Screen, rectangular") {
          LockRow { LockTile(size: rectangular) { PewRecentRectangular(snapshot: sample, now: now) } }
        }
      },
      "widget-recent.png", to: dir
    )

    save(
      Sheet(title: "Agents", subtitle: "What is waiting on you, working, or new. Most urgent first.") {
        HStack(alignment: .top, spacing: 20) {
          Labelled(label: "Small") { HomeTile(size: small) { PewAgentsSmall(snapshot: sample) } }
          Labelled(label: "Medium") { HomeTile(size: medium) { PewAgentsList(snapshot: sample, limit: 3) } }
        }
        Labelled(label: "Large") { HomeTile(size: large) { PewAgentsList(snapshot: sample, limit: PewStore.rows) } }
        Labelled(label: "Lock Screen: circular, rectangular, inline") {
          LockRow {
            LockTile(size: circular) { PewAgentsCircular(snapshot: sample) }.background(Circle().fill(.white.opacity(0.14))).clipShape(Circle())
            LockTile(size: rectangular) { PewAgentsRectangular(snapshot: sample) }
            LockTile(size: CGSize(width: 220, height: 20)) { PewAgentsInline(snapshot: sample).font(.system(size: 15, weight: .medium)) }
          }
        }
      },
      "widget-agents.png", to: dir
    )

    save(
      Sheet(title: "New chat", subtitle: "One tap to an empty composer. Also, before pairing, every widget says so.") {
        HStack(alignment: .top, spacing: 20) {
          Labelled(label: "Small") { HomeTile(size: small) { PewNewChatSmall(snapshot: sample) } }
          Labelled(label: "Lock Screen, circular") {
            LockRow { LockTile(size: circular) { PewNewChatCircular() }.background(Circle().fill(.white.opacity(0.14))).clipShape(Circle()) }
          }
          Labelled(label: "Any widget, not paired yet") { HomeTile(size: small) { PewUnpaired() } }
        }
      },
      "widget-new-chat.png", to: dir
    )
  }
}
