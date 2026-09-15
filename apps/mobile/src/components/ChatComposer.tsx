import { Camera, Send } from "lucide-react-native";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { colors, typography } from "../theme/theme";

type Props = {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled: boolean;
  onImagePress?: () => void;
  maxLength?: number;
};

export function ChatComposer({
  value,
  onChangeText,
  onSend,
  sending,
  disabled,
  onImagePress,
  maxLength
}: Props) {
  const sendDisabled = disabled || sending;

  return (
    <View style={styles.composer}>
      <View style={styles.inputShell}>
        {onImagePress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="選擇圖片"
            disabled={sending}
            onPress={onImagePress}
            style={({ pressed }) => [styles.iconAction, pressed && styles.pressed, sending && styles.disabledAction]}
          >
            <Camera size={22} color={colors.accentDark} />
          </Pressable>
        ) : null}
        <TextInput
          accessibilityLabel="訊息"
          value={value}
          onChangeText={onChangeText}
          style={styles.input}
          multiline
          maxLength={maxLength}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="送出訊息"
          accessibilityState={{ disabled: sendDisabled, busy: sending }}
          disabled={sendDisabled}
          onPress={onSend}
          style={({ pressed }) => [
            styles.sendAction,
            disabled && !sending && styles.sendDisabled,
            pressed && !sendDisabled && styles.pressed
          ]}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Send size={21} color={sendDisabled ? colors.softText : "#FFFFFF"} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  composer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.bg
  },
  inputShell: {
    minHeight: 54,
    maxHeight: 130,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.surface
  },
  iconAction: {
    width: 44,
    height: 44,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center"
  },
  input: {
    ...typography.message,
    flex: 1,
    minHeight: 44,
    maxHeight: 114,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.ink
  },
  sendAction: {
    width: 44,
    height: 44,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent
  },
  sendDisabled: {
    backgroundColor: colors.accentSoft
  },
  pressed: {
    opacity: 0.7
  },
  disabledAction: {
    opacity: 0.5
  }
});
