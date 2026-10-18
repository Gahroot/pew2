// The widgets' data, shared by every extension target.
//
// The same JSON `src/widgetSnapshot.ts` writes. The app writes it while it is
// awake; the notification service extension edits it while the app is asleep,
// so the widgets say "needs you" the moment an approval push lands, which is
// the moment it matters. Rename a field here and it must be renamed there.

import Foundation

enum PewStore {
  /// `group.` + the app's bundle id, the rule `app.config.js` signs with, so a
  /// fork signing under its own id reads its own group. Every extension's id is
  /// the app's plus one component (`.widget`, `.notifications`).
  static let appGroup: String = {
    let mine = Bundle.main.bundleIdentifier ?? ""
    let app = mine.split(separator: ".").dropLast().joined(separator: ".")
    return "group.\(app)"
  }()
  static let key = "pew2.snapshot"
  /// The most rows any widget shows (the large ones).
  static let rows = 7
}

struct PewRow: Codable, Hashable, Identifiable {
  var id: String
  var title: String
  var project: String?
  var agent: String?
  var color: String?
  /// "waiting" | "working" | "unread" | "idle"
  var state: String
  /// Last activity, ms since the epoch.
  var at: Double?

  var rank: Int {
    switch state {
    case "waiting": return 0
    case "working": return 1
    case "unread": return 2
    default: return 3
    }
  }

  var lastActive: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct PewSnapshot: Codable {
  var v: Int = 1
  var machine: String?
  var waiting: Int = 0
  var working: Int = 0
  /// For the Agents widget: most urgent first.
  var rows: [PewRow] = []
  /// For the Recent widget: most recently active first.
  var recent: [PewRow] = []
  /// When this was last written, in ms since the epoch.
  var at: Double = 0

  var updated: Date { Date(timeIntervalSince1970: at / 1000) }

  init(machine: String? = nil, waiting: Int = 0, working: Int = 0, rows: [PewRow] = [], recent: [PewRow] = [], at: Double = 0) {
    self.machine = machine
    self.waiting = waiting
    self.working = working
    self.rows = rows
    self.recent = recent
    self.at = at
  }

  /// Every field optional on the way in: a snapshot written by an older app
  /// (no `recent`) must still draw, not leave every widget unpaired.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
    machine = try c.decodeIfPresent(String.self, forKey: .machine)
    waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
    working = try c.decodeIfPresent(Int.self, forKey: .working) ?? 0
    rows = try c.decodeIfPresent([PewRow].self, forKey: .rows) ?? []
    recent = try c.decodeIfPresent([PewRow].self, forKey: .recent) ?? rows
    at = try c.decodeIfPresent(Double.self, forKey: .at) ?? 0
  }

  static func load() -> PewSnapshot? {
    guard let text = UserDefaults(suiteName: PewStore.appGroup)?.string(forKey: PewStore.key),
          let data = text.data(using: .utf8)
    else { return nil }
    return try? JSONDecoder().decode(PewSnapshot.self, from: data)
  }

  func save() {
    guard let data = try? JSONEncoder().encode(self),
          let text = String(data: data, encoding: .utf8)
    else { return }
    UserDefaults(suiteName: PewStore.appGroup)?.set(text, forKey: PewStore.key)
  }

  /// Fold in a push the app slept through.
  ///
  /// - Parameters:
  ///   - kind: the push's `kind`: "approval" and "question" mean the agent is
  ///     stopped on you; "finished" and "failed" mean a turn ended.
  ///   - badge: the daemon's count of conversations waiting on you, which is
  ///     authoritative across every conversation, not just the rows held here.
  ///   - title: the banner title ("pew2 · Claude Code"), for a conversation
  ///     the snapshot does not hold yet.
  mutating func apply(sessionId: String, kind: String, badge: Int?, title: String, now: Date) {
    let next = (kind == "approval" || kind == "question") ? "waiting" : "unread"
    let stamp = now.timeIntervalSince1970 * 1000
    let parts = title.components(separatedBy: " · ")
    let stranger = PewRow(
      id: sessionId,
      title: "Waiting on you",
      project: parts.first.flatMap { $0.isEmpty ? nil : $0 },
      agent: parts.count > 1 ? parts[1] : nil,
      color: nil,
      state: next,
      at: stamp
    )

    // Agents: the state changes; a conversation it does not hold is added only
    // when it is waiting, since that is the one thing that must not be missed.
    if let index = rows.firstIndex(where: { $0.id == sessionId }) {
      if rows[index].state == "working" { working = max(0, working - 1) }
      rows[index].state = next
      rows[index].at = stamp
    } else if next == "waiting" {
      rows.insert(stranger, at: 0)
    }
    rows = rows.enumerated()
      .sorted { ($0.element.rank, $0.offset) < ($1.element.rank, $1.offset) }
      .map(\.element)
    rows = Array(rows.prefix(PewStore.rows))

    // Recent: something just happened here, so it is the latest conversation.
    var row = recent.first(where: { $0.id == sessionId })
      ?? rows.first(where: { $0.id == sessionId })
      ?? stranger
    row.state = next
    row.at = stamp
    recent.removeAll { $0.id == sessionId }
    recent.insert(row, at: 0)
    recent = Array(recent.prefix(PewStore.rows))

    if let badge = badge {
      waiting = badge
    } else {
      waiting = rows.filter { $0.state == "waiting" }.count
    }
    at = stamp
  }
}
