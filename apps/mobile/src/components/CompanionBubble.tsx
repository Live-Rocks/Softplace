import type { LayoutChangeEvent, StyleProp, ViewStyle } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { colors, typography } from "../theme/theme";

type Props = {
  role: "user" | "assistant";
  content: string;
  tone?: "softplace" | "ava";
  imagePresent?: boolean;
  proactive?: boolean;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
};

export function CompanionBubble({
  role,
  content,
  tone = "softplace",
  imagePresent,
  proactive,
  style,
  onLayout
}: Props) {
  const isUser = role === "user";

  return (
    <View
      onLayout={onLayout}
      style={[
        styles.bubble,
        isUser ? styles.userBubble : tone === "ava" ? styles.avaBubble : styles.assistantBubble,
        style
      ]}
    >
      {imagePresent ? <Text style={styles.imageFlag}>已附上一張圖片</Text> : null}
      {proactive ? <Text style={styles.proactive}>Ava 主動傳來</Text> : null}
      <Text style={[styles.message, isUser && styles.userText]}>{content}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: "88%",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: colors.accent
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface
  },
  avaBubble: {
    alignSelf: "flex-start",
    backgroundColor: colors.roseSoft
  },
  message: {
    ...typography.message,
    color: colors.ink
  },
  userText: {
    color: "#FFFFFF"
  },
  imageFlag: {
    color: "#FFFFFF",
    fontWeight: "700",
    marginBottom: 6
  },
  proactive: {
    color: colors.rose,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: "700",
    marginBottom: 5
  }
});
