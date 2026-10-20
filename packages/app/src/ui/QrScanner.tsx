/**
 * QR scanning for pairing.
 *
 * The app only ever *reads* codes. The pairing token belongs to the desktop —
 * that machine mints it and prints it — so the phone has nothing of its own to
 * publish. Re-displaying a received secret would only add shoulder-surf and
 * screenshot exposure for no gain.
 *
 * Scanning is the only way to pair, so a refused camera is offered the way back
 * (Settings) rather than treated as an error.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { theme } from "../theme";
import { text } from "../appStyles";
import { Pew } from "../pew/Pew";
import { Led } from "./stage/Led";
import { haptics } from "./haptics";
import { CircleButton } from "./controls";
import { ScreenHeader, HeaderButton } from "./ScreenHeader";
import { Glass } from "./Glass";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called with the raw scanned string; the caller validates it. */
  onScan: (value: string) => void;
  /** Set when the last scan produced an invalid link, so it can be shown here. */
  error?: string | null;
  /**
   * Set while a scanned code is being checked against the machine.
   *
   * Reading a code is instant, but proving it works is a round trip that can
   * take seconds on mobile data. Without this the viewfinder just sits there
   * after a good scan, looking like it failed to read anything.
   */
  busy?: boolean;
}

export function QrScanner({ visible, onClose, onScan, error, busy }: Props) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  // The camera fires continuously while a code is in frame. Without a latch the
  // same code is delivered dozens of times and the app pairs, re-renders and
  // pairs again.
  const handled = useRef(false);
  // The last code handed to the caller, and the one it refused. A refused code
  // is skipped so the camera can stay live for a *different* one without
  // re-submitting the bad code on every frame it remains in view.
  const submitted = useRef<string | undefined>(undefined);
  const rejected = useRef<string | undefined>(undefined);
  const [torch, setTorch] = useState(false);
  // Drives the corners green; a refused code puts them back to coral.
  const [read, setRead] = useState(false);

  const handleScan = useCallback(
    ({ data }: { data: string }) => {
      if (handled.current || data === rejected.current) return;
      handled.current = true;
      submitted.current = data;
      setRead(true);
      // The camera is held at arm's length and the sheet dismisses itself, so a
      // pulse is the clearest confirmation that the code actually registered.
      haptics.finished();
      onScan(data);
    },
    [onScan],
  );

  // A refused code leaves the sheet open so the reason can be read over the
  // camera. Without re-arming, the scanner is deaf from that moment on: the
  // user points at a corrected code and nothing happens, and only closing and
  // reopening revives it. Retry is the entire point of staying on the camera.
  useEffect(() => {
    if (!error) return;
    rejected.current = submitted.current;
    handled.current = false;
    setRead(false);
  }, [error]);

  // A retry must be able to scan the same code again, so the latch is released
  // whenever the sheet is reopened rather than only on a new code.
  const close = useCallback(() => {
    handled.current = false;
    rejected.current = undefined;
    setTorch(false);
    setRead(false);
    onClose();
  }, [onClose]);

  const granted = permission?.granted === true;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onShow={() => {
        handled.current = false;
        rejected.current = undefined;
      }}
      onRequestClose={close}
    >
      <View style={styles.root}>
        {granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torch}
            // Only QR: narrowing the set makes recognition faster and stops a
            // barcode on a nearby package from being read as a pairing link.
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={handleScan}
          />
        ) : null}

        {/* Sits above the camera, so it is declared after it. */}
        <View style={styles.overlay}>
          {/* The shared header sits on the gutter itself, so it reaches past this overlay's own. */}
          <ScreenHeader
            style={styles.header}
            leading={<HeaderButton glyph="close" label="Cancel scanning" onPress={close} />}
            trailing={
              granted ? (
                <CircleButton
                  label={torch ? "Turn off torch" : "Turn on torch"}
                  onPress={() => setTorch((on) => !on)}
                  feel={torch ? () => haptics.toggleOff() : () => haptics.toggleOn()}
                >
                  <Ionicons name={torch ? "flashlight" : "flashlight-outline"} size={18} color={theme.color.text} />
                </CircleButton>
              ) : null
            }
          />

          {granted ? (
            <View style={styles.centre} pointerEvents="none">
              {/* Pew right above the box he's reading, with what's happening
                  under him; the box itself is a frame, not a mask. */}
              <View style={styles.guide}>
                <Pew size={72} mood={read || busy ? "happy" : "reading"} accessibilityLabel="Pew" />
                {busy ? (
                  <Led tone="plus">Checking the code…</Led>
                ) : error ? (
                  <Text style={[text.subline, styles.error]} numberOfLines={2}>
                    {error}
                  </Text>
                ) : (
                  <Led>Point me at the QR code</Led>
                )}
              </View>
              <Viewfinder read={read || !!busy} />
            </View>
          ) : (
            <View style={styles.centre}>
              <Ionicons name="camera-outline" size={40} color={theme.color.textFaint} />
              <Text style={styles.permissionTitle}>
                {permission?.canAskAgain === false ? "Camera is off" : "Camera needed"}
              </Text>
              {/* Once refused, iOS never shows the prompt again, so the only way
                  back is Settings. The sentence itself opens it rather than a
                  new button, so the screen looks exactly as it did. */}
              <Text
                style={styles.permissionBody}
                {...(permission?.canAskAgain === false
                  ? {
                      accessibilityRole: "link" as const,
                      accessibilityHint: "Opens this app's settings",
                      onPress: () => {
                        haptics.tap();
                        void Linking.openSettings();
                      },
                    }
                  : null)}
              >
                {permission?.canAskAgain === false
                  ? "Turn it on in Settings."
                  : "Only used to read the code."}
              </Text>
              {permission?.canAskAgain !== false ? (
                <Glass radius={theme.radius.lg} interactive>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Allow camera access"
                    onPress={() => {
                      haptics.tap();
                      void requestPermission();
                    }}
                    style={({ pressed }) => [styles.allow, pressed && styles.pressed]}
>
                    <Text style={styles.allowText}>Allow camera</Text>
                  </Pressable>
                </Glass>
              ) : null}
            </View>
          )}
          {/* Holds the bottom inset, so the box sits a little above centre. */}
          {granted ? <View style={{ height: insets.bottom + theme.space(10) }} /> : null}
        </View>
      </View>
    </Modal>
  );
}

const RETICLE = 240;
const CORNER = 44;
/** Stage's coral for the viewfinder: no theme token, local to the scanner. */
const CORAL = "#ff7a66";

function Corner({ at, color }: { at: "tl" | "tr" | "bl" | "br"; color: string; }) {
  const top = at[0] === "t";
  const left = at[1] === "l";
  return (
    <View
      style={[
        styles.corner,
        {
          borderColor: color,
          shadowColor: color,
          borderStyle: color === CORAL ? "dotted" : "solid",
          [top ? "top" : "bottom"]: 0,
          [left ? "left" : "right"]: 0,
          [top ? "borderTopWidth" : "borderBottomWidth"]: 3,
          [left ? "borderLeftWidth" : "borderRightWidth"]: 3,
        },
      ]}
    />
  );
}

/** Four dotted coral brackets and a sweeping line; solid green once read. */
function Viewfinder({ read }: { read: boolean }) {
  const reduce = useReducedMotion();
  const t = useSharedValue(0);
  const sweeping = !reduce && !read;
  useEffect(() => {
    if (!sweeping) {
      cancelAnimation(t);
      return;
    }
    t.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(t);
  }, [sweeping, t]);
  const line = useAnimatedStyle(() => ({ transform: [{ translateY: t.value * (RETICLE - 2) }] }));
  const color = read ? theme.color.success : CORAL;
  return (
    <View style={styles.reticle}>
      <Corner at="tl" color={color} />
      <Corner at="tr" color={color} />
      <Corner at="bl" color={color} />
      <Corner at="br" color={color} />
      {sweeping ? <Animated.View style={[styles.scanLine, line]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: theme.gutter,
  },
  header: { marginHorizontal: -theme.gutter },
  pressed: { opacity: 0.6 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space(4) },
  reticle: { width: RETICLE, height: RETICLE },
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    shadowOpacity: 0.9,
    shadowRadius: theme.stage.glow,
    shadowOffset: { width: 0, height: 0 },
  },
  scanLine: {
    position: "absolute",
    left: theme.space(3),
    right: theme.space(3),
    top: 0,
    height: 2,
    backgroundColor: CORAL,
    shadowColor: CORAL,
    shadowOpacity: 1,
    shadowRadius: theme.stage.glow,
    shadowOffset: { width: 0, height: 0 },
  },
  // Pew and the line under him, right above the box (the globe fills ~60% of
  // its box, so the negative margin closes the air under it).
  guide: { alignItems: "center", gap: theme.space(1), marginBottom: theme.space(2) },
  error: { color: theme.color.danger },
  permissionTitle: {
    color: theme.color.text,
    fontFamily: theme.display.semibold,
    fontSize: 18,
    letterSpacing: 0.4,
  },
  permissionBody: {
    color: theme.color.textDim,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    paddingHorizontal: theme.space(4),
  },
  allow: {
    minHeight: theme.size.touch,
    justifyContent: "center",
    paddingVertical: theme.space(3.5),
    paddingHorizontal: theme.space(8),
  },
  allowText: { color: theme.color.text, fontSize: 16, fontWeight: "700" },
});
