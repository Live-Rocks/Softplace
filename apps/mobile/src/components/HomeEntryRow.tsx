import type { ComponentType } from "react";
import { ChevronRight, type LucideProps } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, typography } from "../theme/theme";

type Swatch = "sage" | "rose" | "blue";

type Props = {
  label: string;
  icon: ComponentType<LucideProps>;
  swatch: Swatch;
  onPress: () => void;
};

const swatchStyles = {
  sage: { backgroundColor: colors.accentSoft, color: colors.accentDark },
  rose: { backgroundColor: colors.roseSoft, color: colors.rose },
  blue: { backgroundColor: colors.blueSoft, color: colors.blue }
} satisfies Record<Swatch, { backgroundColor: string; color: string }>;

export function HomeEntryRow({ label, icon: Icon, swatch, onPress }: Props) {
  const swatchStyle = swatchStyles[swatch];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.iconSwatch, { backgroundColor: swatchStyle.backgroundColor }]}>
        <Icon size={20} color={swatchStyle.color} />
      </View>
      <Text style={styles.label}>{label}</Text>
      <ChevronRight size={19} color={colors.softText} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 4,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  pressed: {
    backgroundColor: colors.surface
  },
  iconSwatch: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  label: {
    ...typography.label,
    flex: 1,
    color: colors.ink
  }
});
