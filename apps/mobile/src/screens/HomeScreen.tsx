import { Camera, CloudRain, Coffee, HandHeart, HeartHandshake, Moon, Sparkles } from "lucide-react-native";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { HomeEntryRow } from "../components/HomeEntryRow";
import { colors, typography } from "../theme/theme";

const entries = [
  { label: "哄哄我", prompt: "你可以哄哄我嗎？", icon: HandHeart, swatch: "rose" },
  { label: "我有點不安", prompt: "我有點不安，但我不知道怎麼說。", icon: CloudRain, swatch: "blue" },
  { label: "我想哭一下", prompt: "我想哭一下，你可以陪我嗎？", icon: Moon, swatch: "blue" },
  { label: "陪我整理今天", prompt: "可以陪我整理今天發生的事嗎？", icon: Coffee, swatch: "sage" },
  { label: "我想給你看一張圖", prompt: "我想傳一張圖給你看，陪我看看。", icon: Camera, swatch: "sage" },
  { label: "隨便陪我聊聊", prompt: "我不知道要說什麼，但想有人陪我一下。", icon: Sparkles, swatch: "rose" }
] as const;

type Props = {
  onStart: (prompt: string) => void;
};

export function HomeScreen({ onStart }: Props) {
  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <View style={styles.brand}>
        <HeartHandshake size={18} color={colors.accentDark} />
        <Text style={styles.brandText}>SoftPlace</Text>
      </View>
      <View style={styles.hero}>
        <Text style={styles.kicker}>今天想怎麼被陪？</Text>
        <Text style={styles.title}>先不用懂事，也不用把話說漂亮。</Text>
        <Text style={styles.body}>選一個比較接近現在的入口。進去之後，你可以慢慢改、慢慢說。</Text>
      </View>
      <View style={styles.entryList}>
        {entries.map((entry) => (
          <HomeEntryRow
            key={entry.label}
            label={entry.label}
            icon={entry.icon}
            swatch={entry.swatch}
            onPress={() => onStart(entry.prompt)}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg
  },
  content: {
    padding: 20,
    paddingBottom: 32,
    gap: 20
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 10
  },
  brandText: {
    ...typography.brand,
    color: colors.accentDark
  },
  hero: {
    gap: 10,
    paddingTop: 4,
    paddingBottom: 4
  },
  kicker: {
    color: colors.accentDark,
    fontWeight: "800",
    fontSize: 15
  },
  title: {
    ...typography.pageTitle,
    color: colors.ink,
  },
  body: {
    ...typography.body,
    color: colors.muted,
  },
  entryList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  }
});
