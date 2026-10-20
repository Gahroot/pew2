/**
 * The top row of every full-screen page: the same rail, height and buttons as
 * the main screen's top bar (`styles.topBar`), so moving between pages never
 * shifts a control or a title.
 *
 *   [leading]   title, centred   [trailing]
 *
 * - The row starts at the safe-area top plus `theme.headerInset`, sits on
 *   `theme.gutter`, and is one 44pt control tall.
 * - Buttons are 44pt `CircleButton`s (`HeaderButton`).
 * - Dismissing (close, back) is always the leading button; actions trail.
 * - Both sides take the same width, so the title is centred on the screen and
 *   is what gives way (it truncates) when space runs out.
 */
import type { ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { styles as appStyles } from "../appStyles";
import { theme } from "../theme";
import { CircleButton } from "./controls";
import { DotGlyph, type DotGlyphName } from "./stage/DotGlyph";
import type { Feel } from "./haptics";
import { haptics } from "./haptics";

interface Props {
  title?: string;
  titleStyle?: StyleProp<TextStyle>;
  /** Middle-truncate the title (a file name), instead of the tail. */
  ellipsize?: "tail" | "middle";
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Controls on the wider side: both sides take this many slots. Default 1. */
  slots?: 1 | 2;
  /** Inside a view that already clears the safe area. */
  noInset?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ScreenHeader({ title, titleStyle, ellipsize = "tail", leading, trailing, slots = 1, noInset = false, style }: Props) {
  const insets = useSafeAreaInsets();
  const side = slots === 2 ? appStyles.navActionsGoal : appStyles.navAction;
  return (
    // One height whether or not a side has a button: an empty row collapsed,
    // and a page without a back button sat everything higher than the next.
    <View style={[appStyles.topBar, { paddingTop: (noInset ? 0 : insets.top) + theme.headerInset, minHeight: (noInset ? 0 : insets.top) + theme.headerInset * 2 + theme.size.control }, style]}>
      <View style={[side, appStyles.navLeadGoal]}>{leading}</View>
      <Text
        style={[appStyles.sessionTitle, titleStyle]}
        numberOfLines={1}
        ellipsizeMode={ellipsize}
        accessibilityRole={title ? "header" : undefined}
      >
        {title ?? ""}
      </Text>
      <View style={side}>{trailing}</View>
    </View>
  );
}

/** A header control: the main screen's 44pt button with a dot glyph. */
export function HeaderButton({
  glyph,
  label,
  onPress,
  feel,
}: {
  glyph: DotGlyphName;
  label: string;
  onPress: () => void;
  feel?: Feel;
}) {
  return (
    <CircleButton label={label} onPress={onPress} feel={feel ? () => haptics[feel]() : undefined}>
      <DotGlyph name={glyph} size={glyph === "close" ? 14 : 16} />
    </CircleButton>
  );
}
