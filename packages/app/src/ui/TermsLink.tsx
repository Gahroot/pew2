/**
 * The terms of use, reachable from inside the app. Mirrors `PrivacyLink` and
 * is shown beside it everywhere, in the in-app browser for the same reason.
 */
import { Alert, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";

/** Where the terms are published, beside PRIVACY.md. */
const TERMS_URL = "https://github.com/KenKaiii/pew2/blob/main/TERMS.md";

/** The rendered height of one line of this label, which the slop grows to 44. */
const LINE = 19;

export function TermsLink({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Terms of use"
      hitSlop={touchSlop(LINE)}
      onPress={() => {
        haptics.tap();
        void WebBrowser.openBrowserAsync(TERMS_URL, {
          toolbarColor: theme.color.surface,
          controlsColor: theme.color.accent,
        }).catch(() => {
          Alert.alert(
            "Could not open terms",
            "Please try again. You can also find them on pew2's GitHub page.",
          );
        });
      }}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      <Text style={styles.text}>Terms</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  text: {
    color: theme.color.textFaint,
    fontSize: 13,
    lineHeight: LINE,
    textDecorationLine: "underline",
  },
  pressed: { opacity: 0.6 },
});
