// WidgetKit's half of the widgets: timelines and configurations. The views are
// in `PewWidgetViews.swift`.

import SwiftUI
import WidgetKit

// MARK: - Timeline

struct PewEntry: TimelineEntry {
  let date: Date
  let snapshot: PewSnapshot?
}

struct PewProvider: TimelineProvider {
  func placeholder(in context: Context) -> PewEntry {
    PewEntry(date: Date(), snapshot: .sample(now: Date()))
  }

  func getSnapshot(in context: Context, completion: @escaping (PewEntry) -> Void) {
    // The gallery shows the sample until the phone is paired.
    let stored = PewSnapshot.load()
    completion(PewEntry(date: Date(), snapshot: context.isPreview ? (stored ?? .sample(now: Date())) : stored))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<PewEntry>) -> Void) {
    // The content changes only when the app or a push says so, and both ask
    // WidgetKit to reload. The entries are only so "4m" keeps up with the
    // clock: one every ten minutes for two hours, after which the times read
    // in hours and days and the last entry stays true long enough.
    let snapshot = PewSnapshot.load()
    let now = Date()
    let entries = (0..<12).map { PewEntry(date: now.addingTimeInterval(Double($0) * 600), snapshot: snapshot) }
    completion(Timeline(entries: entries, policy: .never))
  }
}

private struct Background: ViewModifier {
  func body(content: Content) -> some View {
    content.containerBackground(for: .widget) { Color.pewBg }
  }
}

// MARK: - Recent

struct PewRecentView: View {
  @Environment(\.widgetFamily) private var family
  let entry: PewEntry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        switch family {
        case .systemMedium: PewRecentList(snapshot: snapshot, limit: 3, now: entry.date)
        case .systemLarge: PewRecentList(snapshot: snapshot, limit: PewStore.rows, now: entry.date)
        case .accessoryRectangular: PewRecentRectangular(snapshot: snapshot, now: entry.date)
        default: PewRecentSmall(snapshot: snapshot, now: entry.date)
        }
      } else if family == .accessoryRectangular {
        Text("Open pew2 to pair").font(.system(size: 13))
      } else {
        PewUnpaired()
      }
    }
    .modifier(Background())
  }
}

struct PewRecentWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "PewRecent", provider: PewProvider()) { entry in
      PewRecentView(entry: entry)
    }
    .configurationDisplayName("Recent")
    .description("Jump back into your latest conversations.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
  }
}

// MARK: - Agents

struct PewAgentsView: View {
  @Environment(\.widgetFamily) private var family
  let entry: PewEntry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        switch family {
        case .systemMedium: PewAgentsList(snapshot: snapshot, limit: 3)
        case .systemLarge: PewAgentsList(snapshot: snapshot, limit: PewStore.rows)
        case .accessoryCircular: PewAgentsCircular(snapshot: snapshot)
        case .accessoryRectangular: PewAgentsRectangular(snapshot: snapshot)
        case .accessoryInline: PewAgentsInline(snapshot: snapshot)
        default: PewAgentsSmall(snapshot: snapshot)
        }
      } else {
        switch family {
        case .accessoryInline: Text("pew2 · not paired")
        case .accessoryCircular, .accessoryRectangular: Text("Open pew2").font(.system(size: 13))
        default: PewUnpaired()
        }
      }
    }
    .modifier(Background())
  }
}

struct PewAgentsWidget: Widget {
  var body: some WidgetConfiguration {
    // Kind kept from the first build ("PewWidget"), so a widget already on
    // someone's home screen keeps working after the update.
    StaticConfiguration(kind: "PewWidget", provider: PewProvider()) { entry in
      PewAgentsView(entry: entry)
    }
    .configurationDisplayName("Agents")
    .description("Which of your agents are waiting on you, working, or done.")
    .supportedFamilies([
      .systemSmall, .systemMedium, .systemLarge,
      .accessoryCircular, .accessoryRectangular, .accessoryInline,
    ])
  }
}

// MARK: - New chat

struct PewNewChatView: View {
  @Environment(\.widgetFamily) private var family
  let entry: PewEntry

  var body: some View {
    Group {
      if family == .accessoryCircular {
        PewNewChatCircular()
      } else {
        PewNewChatSmall(snapshot: entry.snapshot)
      }
    }
    .modifier(Background())
  }
}

struct PewNewChatWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "PewNewChat", provider: PewProvider()) { entry in
      PewNewChatView(entry: entry)
    }
    .configurationDisplayName("New chat")
    .description("Start a new conversation in one tap.")
    .supportedFamilies([.systemSmall, .accessoryCircular])
  }
}

@main
struct PewWidgets: WidgetBundle {
  var body: some Widget {
    PewRecentWidget()
    PewAgentsWidget()
    PewNewChatWidget()
  }
}
