import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/theme";

type Mode = "light" | "deep";

type Props = {
  value: Mode;
  disabled?: boolean;
  onChange: (mode: Mode) => void;
};

const options: { value: Mode; label: string }[] = [
  { value: "light", label: "輕量" },
  { value: "deep", label: "深度" }
];

export function CompanionModeControl({ value, disabled, onChange }: Props) {
  return (
    <View accessibilityRole="radiogroup" style={[styles.control, disabled && styles.disabled]}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={`${option.label}陪伴`}
            accessibilityState={{ checked: selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.option,
              selected && styles.selected,
              pressed && !disabled && styles.pressed
            ]}
          >
            <Text style={[styles.label, selected && styles.selectedLabel]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  control: {
    width: 132,
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    padding: 3,
    borderRadius: 8,
    backgroundColor: colors.control
  },
  option: {
    flex: 1,
    height: 32,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center"
  },
  selected: {
    backgroundColor: colors.accentSoft
  },
  pressed: {
    opacity: 0.7
  },
  disabled: {
    opacity: 0.55
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700"
  },
  selectedLabel: {
    color: colors.accentDark,
    fontWeight: "800"
  }
});
