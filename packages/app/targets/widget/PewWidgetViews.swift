// Every widget's views, apart from WidgetKit's plumbing (`PewWidget.swift`).
//
// Split so `scripts/widget-preview` can draw these exact views to PNGs on a
// Mac: a widget cannot be placed on a simulator's home screen from a script,
// and a screenshot of something other than this code would prove nothing.

import SwiftUI
import WidgetKit

// MARK: - Palette (src/theme.ts; kept in step by hand, Swift cannot import it)

extension Color {
  init(pewHex hex: String) {
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    let value = UInt64(digits, radix: 16) ?? 0
    self.init(
      red: Double((value >> 16) & 0xff) / 255,
      green: Double((value >> 8) & 0xff) / 255,
      blue: Double(value & 0xff) / 255
    )
  }

  static let pewBg = Color(pewHex: "#0a0a0c")
  static let pewText = Color(pewHex: "#f2f3f7")
  static let pewDim = Color(pewHex: "#9a9ba5")
  static let pewRule = Color(pewHex: "#3a3c44")
  /// theme.color.attention: the app's own "Waiting on you".
  static let pewWaiting = Color(pewHex: "#f2b45a")
  static let pewCoral = Color(pewHex: "#e07a5a")
}

private let capsFont = Font.system(size: 10, weight: .semibold, design: .monospaced)

/// Whether rows are tappable links. Always on in a widget; the preview
/// renderer turns it off, because a `Link` cannot be drawn to an image.
private struct PewLinksKey: EnvironmentKey {
  static let defaultValue = true
}

extension EnvironmentValues {
  var pewLinks: Bool {
    get { self[PewLinksKey.self] }
    set { self[PewLinksKey.self] = newValue }
  }
}

// MARK: - Sample (widget gallery only)

extension PewSnapshot {
  /// What the widget gallery previews before this phone is paired. Never on a
  /// home screen: an unpaired widget says so (`PewUnpaired`).
  static func sample(now: Date) -> PewSnapshot {
    let ms = now.timeIntervalSince1970 * 1000
    func ago(_ minutes: Double) -> Double { ms - minutes * 60_000 }
    let migration = PewRow(id: "a", title: "Run the events table migration", project: "api", agent: "Claude Code", color: nil, state: "waiting", at: ago(4))
    let flaky = PewRow(id: "b", title: "Why is the checkout test flaky?", project: "web", agent: "Codex", color: "#10a37f", state: "working", at: ago(1))
    let readme = PewRow(id: "c", title: "Tidy the README", project: "docs", agent: "GG Coder", color: nil, state: "unread", at: ago(38))
    let auth = PewRow(id: "d", title: "Refactor auth to the new token store", project: "api", agent: "Claude Code", color: nil, state: "idle", at: ago(180))
    let deps = PewRow(id: "e", title: "Upgrade every dependency", project: "web", agent: "Codex", color: nil, state: "idle", at: ago(1500))
    let icons = PewRow(id: "f", title: "Redo the app icon", project: "pew2", agent: "GG Coder", color: nil, state: "idle", at: ago(2900))
    let docs = PewRow(id: "g", title: "Write the release notes", project: "pew2", agent: "Claude Code", color: nil, state: "idle", at: ago(5000))
    return PewSnapshot(
      machine: "Your Mac",
      waiting: 1,
      working: 1,
      rows: [migration, flaky, readme, auth, deps, icons, docs],
      recent: [flaky, migration, readme, auth, deps, icons, docs],
      at: ms
    )
  }
}

// MARK: - Shared wording

struct PewHeadline {
  let count: Int?
  let label: String
  let color: Color
}

func pewHeadline(_ snapshot: PewSnapshot) -> PewHeadline {
  if snapshot.waiting > 0 { return PewHeadline(count: snapshot.waiting, label: "WAITING ON YOU", color: .pewWaiting) }
  if snapshot.working > 0 { return PewHeadline(count: snapshot.working, label: "WORKING", color: .pewCoral) }
  let unread = snapshot.rows.filter { $0.state == "unread" }.count
  if unread > 0 { return PewHeadline(count: unread, label: unread == 1 ? "NEW REPLY" : "NEW REPLIES", color: .pewText) }
  return PewHeadline(count: nil, label: "ALL QUIET", color: .pewDim)
}

/// The conversation a tap on the whole Agents widget should open: the most urgent.
func pewFocusRow(_ snapshot: PewSnapshot) -> PewRow? {
  snapshot.rows.first { $0.state == "waiting" } ?? snapshot.rows.first { $0.state == "unread" }
}

func pewLink(_ row: PewRow) -> URL? {
  var parts = URLComponents()
  parts.scheme = "pew2"
  parts.host = "open"
  parts.queryItems = [URLQueryItem(name: "session", value: row.id)]
  return parts.url
}

let pewNewChatLink = URL(string: "pew2://new")

/// "now", "4m", "2h", "3d": the drawer's own short times (`Sidebar.tsx` shortWhen).
func pewShortWhen(_ date: Date?, now: Date) -> String? {
  guard let date = date else { return nil }
  let minutes = Int(max(0, now.timeIntervalSince(date)) / 60)
  if minutes < 1 { return "now" }
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60
  if hours < 24 { return "\(hours)h" }
  return "\(hours / 24)d"
}

private func caption(_ row: PewRow, now: Date? = nil) -> String {
  var parts = [row.project, row.agent].compactMap { $0 }
  if let now = now, let when = pewShortWhen(row.lastActive, now: now) { parts.append(when) }
  return parts.joined(separator: " · ")
}

private func stateWord(_ row: PewRow) -> (String, Color)? {
  switch row.state {
  case "waiting": return ("NEEDS YOU", .pewWaiting)
  case "working": return ("WORKING", .pewDim)
  case "unread": return ("NEW", .pewText)
  default: return nil
  }
}

private func markColor(_ row: PewRow) -> Color {
  switch row.state {
  case "waiting": return .pewWaiting
  case "working": return row.color.map { Color(pewHex: $0) } ?? .pewCoral
  case "unread": return .pewText
  default: return .pewRule
  }
}

// MARK: - Pieces

struct PewUnpaired: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      pewMark().resizable().frame(width: 40, height: 40).accessibilityHidden(true)
      Spacer(minLength: 0)
      Text("Open pew2 to pair with your computer.")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Color.pewText)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

private struct RowView: View {
  let row: PewRow
  /// Present on the Recent widget, which says when as well as where.
  var now: Date?

  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(markColor(row))
        .frame(width: 7, height: 7)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.title)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Color.pewText)
          .lineLimit(1)
        let detail = caption(row, now: now)
        if !detail.isEmpty {
          Text(detail).font(.system(size: 11)).foregroundStyle(Color.pewDim).lineLimit(1)
        }
      }
      Spacer(minLength: 4)
      // Words beside the colour, so the state never rests on colour alone.
      if let state = stateWord(row) {
        Text(state.0).font(capsFont).tracking(0.8).foregroundStyle(state.1).fixedSize()
      }
    }
    .accessibilityElement(children: .combine)
  }
}

private struct RowList: View {
  @Environment(\.pewLinks) private var links
  let rows: [PewRow]
  let limit: Int
  var now: Date?
  let empty: String

  var body: some View {
    if rows.isEmpty {
      Text(empty).font(.system(size: 13)).foregroundStyle(Color.pewDim)
    }
    ForEach(rows.prefix(limit)) { row in
      if links, let url = pewLink(row) {
        Link(destination: url) { RowView(row: row, now: now) }
      } else {
        RowView(row: row, now: now)
      }
    }
  }
}

private struct Header: View {
  let label: String
  let color: Color
  let trailing: String?

  var body: some View {
    HStack(spacing: 6) {
      pewMark().resizable().frame(width: 24, height: 24).padding(.leading, -3).accessibilityHidden(true)
      Text(label).font(capsFont).tracking(1).foregroundStyle(color)
      Spacer(minLength: 4)
      if let trailing = trailing {
        Text(trailing).font(.system(size: 11)).foregroundStyle(Color.pewDim)
      }
    }
  }
}

// MARK: - Recent

struct PewRecentSmall: View {
  let snapshot: PewSnapshot
  let now: Date

  var body: some View {
    let row = snapshot.recent.first
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        pewMark().resizable().frame(width: 24, height: 24).padding(.leading, -3).accessibilityHidden(true)
        Text("JUMP BACK IN").font(capsFont).tracking(1).foregroundStyle(Color.pewDim)
      }
      Spacer(minLength: 0)
      if let row = row {
        Text(row.title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Color.pewText)
          .lineLimit(3)
        Text(caption(row)).font(.system(size: 11)).foregroundStyle(Color.pewDim).lineLimit(1)
        HStack(spacing: 5) {
          Circle().fill(markColor(row)).frame(width: 6, height: 6).accessibilityHidden(true)
          if let state = stateWord(row) {
            Text(state.0).font(capsFont).tracking(0.8).foregroundStyle(state.1)
          } else if let when = pewShortWhen(row.lastActive, now: now) {
            Text(when == "now" ? "JUST NOW" : "\(when.uppercased()) AGO").font(capsFont).tracking(0.8).foregroundStyle(Color.pewDim)
          }
        }
      } else {
        Text("No conversations yet.").font(.system(size: 13)).foregroundStyle(Color.pewDim)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(row.flatMap(pewLink) ?? pewNewChatLink)
  }
}

struct PewRecentList: View {
  let snapshot: PewSnapshot
  let limit: Int
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Header(label: "RECENT", color: .pewDim, trailing: snapshot.machine)
      RowList(rows: snapshot.recent, limit: limit, now: now, empty: "No conversations yet. Start one in pew2.")
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

struct PewRecentRectangular: View {
  let snapshot: PewSnapshot
  let now: Date

  var body: some View {
    let row = snapshot.recent.first
    VStack(alignment: .leading, spacing: 1) {
      Text(["pew2", pewShortWhen(row?.lastActive, now: now)].compactMap { $0 }.joined(separator: " · "))
        .font(.system(size: 12, weight: .semibold))
        .widgetAccentable()
      if let row = row {
        Text(row.title).font(.system(size: 14, weight: .medium)).lineLimit(2)
        let detail = caption(row)
        if !detail.isEmpty {
          Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
        }
      } else {
        Text("No conversations yet").font(.system(size: 13)).foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(row.flatMap(pewLink) ?? pewNewChatLink)
  }
}

// MARK: - Agents

struct PewAgentsSmall: View {
  let snapshot: PewSnapshot

  var body: some View {
    let head = pewHeadline(snapshot)
    VStack(alignment: .leading, spacing: 0) {
      pewMark().resizable().frame(width: 44, height: 44).padding(.leading, -6).padding(.top, -6)
        .accessibilityHidden(true)
      Spacer(minLength: 0)
      if let count = head.count {
        Text("\(count)")
          .font(.system(size: 34, weight: .bold, design: .rounded))
          .foregroundStyle(head.color)
          .contentTransition(.numericText())
      }
      Text(head.label).font(capsFont).tracking(1).foregroundStyle(head.color)
      Text("\(snapshot.machine ?? "pew2") · \(snapshot.updated, style: .time)")
        .font(.system(size: 11))
        .foregroundStyle(Color.pewDim)
        .lineLimit(1)
        .padding(.top, 4)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(pewFocusRow(snapshot).flatMap(pewLink))
  }
}

struct PewAgentsList: View {
  let snapshot: PewSnapshot
  let limit: Int

  var body: some View {
    let head = pewHeadline(snapshot)
    VStack(alignment: .leading, spacing: 8) {
      Header(
        label: head.count.map { "\($0) \(head.label)" } ?? head.label,
        color: head.color,
        trailing: snapshot.updated.formatted(date: .omitted, time: .shortened)
      )
      RowList(rows: snapshot.rows, limit: limit, empty: "No conversations yet. Start one in pew2.")
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

struct PewAgentsCircular: View {
  let snapshot: PewSnapshot

  var body: some View {
    let head = pewHeadline(snapshot)
    ZStack {
      AccessoryWidgetBackground()
      if let count = head.count {
        VStack(spacing: -1) {
          Text("\(count)").font(.system(size: 20, weight: .bold, design: .rounded))
          Text(snapshot.waiting > 0 ? "YOU" : snapshot.working > 0 ? "BUSY" : "NEW")
            .font(.system(size: 8, weight: .semibold, design: .monospaced))
        }
      } else {
        Image(systemName: "checkmark").font(.system(size: 16, weight: .semibold))
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(head.count.map { "\($0) \(head.label.lowercased())" } ?? "All quiet")
    .widgetURL(pewFocusRow(snapshot).flatMap(pewLink))
  }
}

struct PewAgentsRectangular: View {
  let snapshot: PewSnapshot

  var body: some View {
    let head = pewHeadline(snapshot)
    let row = pewFocusRow(snapshot) ?? snapshot.rows.first { $0.state == "working" }
    VStack(alignment: .leading, spacing: 1) {
      Text(head.count.map { "\($0) \(head.label.lowercased())" } ?? "All quiet")
        .font(.system(size: 14, weight: .semibold))
        .widgetAccentable()
      if let row = row {
        Text(row.title).font(.system(size: 13)).lineLimit(1)
        let detail = caption(row)
        if !detail.isEmpty {
          Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
        }
      } else {
        Text(snapshot.machine ?? "pew2").font(.system(size: 13)).foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(row.flatMap(pewLink))
  }
}

struct PewAgentsInline: View {
  let snapshot: PewSnapshot

  var body: some View {
    let head = pewHeadline(snapshot)
    Text(head.count.map { "pew2 · \($0) \(head.label.lowercased())" } ?? "pew2 · all quiet")
  }
}

// MARK: - New chat

struct PewNewChatSmall: View {
  /// Nil before pairing: the button still opens the app, which then pairs.
  let snapshot: PewSnapshot?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      pewMark().resizable().frame(width: 64, height: 64).padding(.leading, -8).padding(.top, -8)
        .accessibilityHidden(true)
      Spacer(minLength: 0)
      HStack(spacing: 6) {
        Image(systemName: "plus").font(.system(size: 13, weight: .bold)).foregroundStyle(Color.pewCoral)
        Text("New chat").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.pewText)
      }
      Text(snapshot?.machine.map { "on \($0)" } ?? "Ask an agent anything")
        .font(.system(size: 11))
        .foregroundStyle(Color.pewDim)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .accessibilityElement(children: .combine)
    .widgetURL(pewNewChatLink)
  }
}

struct PewNewChatCircular: View {
  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      Image(systemName: "plus.bubble").font(.system(size: 20, weight: .semibold))
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("New chat in pew2")
    .widgetURL(pewNewChatLink)
  }
}
