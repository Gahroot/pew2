/** The explainer before the system notification prompt (`useAlerts.ts`). */
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { ALERTS_LINE, ALERTS_TITLE, type CardMode } from "../notificationAsk";
import { Sheet } from "./Sheet";
import { StageButton } from "./stage/StageButton";

interface Props {
  card: CardMode | undefined;
  onAllow: () => void;
  onNotNow: () => void;
}

export function AlertsCard({ card, onAllow, onNotNow }: Props) {
  return (
    <Sheet visible={card !== undefined} label="Alerts" pewMood="happy" title={ALERTS_TITLE} onClose={onNotNow} dismissLabel="Not now">
      <View style={styles.content}>
        <Text style={styles.line}>{ALERTS_LINE}</Text>
        <StageButton label={card === "settings" ? "Open Settings" : "Allow"} feel="chosen" onPress={onAllow} />
        <StageButton kind="secondary" label="Not now" onPress={onNotNow} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: theme.space(3), paddingBottom: theme.sectionGap },
  line: { color: theme.color.text, fontSize: theme.font.body, lineHeight: 20 },
});
