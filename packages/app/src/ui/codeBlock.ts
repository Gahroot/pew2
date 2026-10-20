/**
 * The chat's code look, for commands shown outside a message (onboarding,
 * pairing). Separate from markdownCodeStyles.ts, which pure tests import and
 * so must stay free of React Native.
 */
import { Platform, StyleSheet } from "react-native";
import { theme } from "../theme";

/**
 * The chat's code block look (MarkdownText `codeBlockContainer`/`codeBlock`),
 * for any command shown outside a message: onboarding, pairing. One look for
 * code everywhere. Pass the body text size; the code runs a point smaller.
 */
export const CODE_FONT = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export function codeBlockStyles(fontSize: number, lineHeight: number) {
  return {
    container: {
      backgroundColor: theme.color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.color.border,
      borderRadius: theme.radius.md,
    },
    text: {
      color: theme.color.text,
      fontFamily: CODE_FONT,
      fontSize: Math.max(12, fontSize - 1),
      lineHeight: Math.max(18, lineHeight - 2),
    },
    padding: { paddingHorizontal: theme.space(3), paddingVertical: theme.space(2.5) },
  } as const;
}
