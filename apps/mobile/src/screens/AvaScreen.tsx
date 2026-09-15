import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  View
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type { AvaMessage, AvaState } from "@softplace/shared";
import { api } from "../api/client";
import { ChatComposer } from "../components/ChatComposer";
import { CompanionBubble } from "../components/CompanionBubble";
import { useInitialScrollToLatest } from "../hooks/useInitialScrollToLatest";
import { colors, typography } from "../theme/theme";
import { splitAvaBubbleSegments } from "../utils/avaBubbleSegments";

type Props = {
  accessToken: string;
  active: boolean;
  onUnreadCountChange: (count: number) => void;
};

export function AvaScreen({ accessToken, active, onUnreadCountChange }: Props) {
  const [messages, setMessages] = useState<AvaMessage[]>([]);
  const [state, setState] = useState<AvaState | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const {
    listRef,
    onContentSizeChange,
    onListLayout,
    onLastItemLayout,
    onScrollBeginDrag,
    onScroll
  } = useInitialScrollToLatest<AvaMessage>({
    active,
    itemCount: messages.length,
    resetKey: accessToken
  });

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await api.avaMessages(accessToken);
      setMessages(response.messages);
      setNotice("");
      if (active && response.state.unreadCount) {
        await api.markAvaRead(accessToken);
        setState({ ...response.state, unreadCount: 0 });
        onUnreadCountChange(0);
      } else {
        setState(response.state);
        onUnreadCountChange(response.state.unreadCount);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "暫時無法載入 Ava。");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [accessToken, active, onUnreadCountChange]);

  useEffect(() => {
    if (!active) return;
    load();
    const timer = setInterval(() => load(true), 12_000);
    return () => clearInterval(timer);
  }, [active, load]);

  async function send() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setNotice("");
    setText("");
    Keyboard.dismiss();
    const local: AvaMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content,
      proactive: false,
      createdAt: new Date().toISOString(),
      readAt: new Date().toISOString()
    };
    setMessages((current) => [...current, local]);
    try {
      const response = await api.sendAvaMessage(content, accessToken);
      setMessages((current) => [
        ...current.filter((message) => message.id !== local.id),
        response.message,
        ...(response.assistantMessage ? [response.assistantMessage] : [])
      ]);
      setState(response.state);
      onUnreadCountChange(0);
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== local.id));
      setText(content);
      setNotice(error instanceof Error ? error.message : "這次沒有送出去，請再試一次。");
    } finally {
      setSending(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior="translate-with-padding"
      enabled={active}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <View style={styles.avatar}><Text style={styles.avatarText}>A</Text></View>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Ava</Text>
          <Text style={styles.status}>{state?.statusLabel ?? "載入中"}</Text>
        </View>
        <Text style={styles.usage}>{state ? `${state.dailyUsed}/${state.dailyLimit}` : ""}</Text>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messages}
        initialNumToRender={50}
        maxToRenderPerBatch={50}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={onContentSizeChange}
        onLayout={onListLayout}
        onScrollBeginDrag={onScrollBeginDrag}
        onScroll={onScroll}
        scrollEventThrottle={16}
        ListEmptyComponent={
          loading ? <ActivityIndicator color={colors.accent} style={styles.empty} /> : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>你們還沒說過話</Text>
              <Text style={styles.emptyText}>Ava 有自己的生活節奏。你可以先從今天的一件小事開始。</Text>
            </View>
          )
        }
        renderItem={({ item, index }) => {
          const isLast = index === messages.length - 1;
          const previousRole = index > 0 ? messages[index - 1]?.role : null;
          const spacingStyle = index === 0
            ? undefined
            : previousRole === item.role
              ? styles.groupedMessage
              : styles.turnMessage;

          if (item.role === "user") {
            return (
              <CompanionBubble
                role="user"
                content={item.content}
                style={spacingStyle}
                onLayout={isLast ? onLastItemLayout : undefined}
              />
            );
          }

          const segments = splitAvaBubbleSegments(item.content);
          return (
            <View style={[styles.avaBubbleGroup, spacingStyle]} onLayout={isLast ? onLastItemLayout : undefined}>
              {segments.map((segment, segmentIndex) => (
                <CompanionBubble
                  key={`${item.id}-${segmentIndex}`}
                  role="assistant"
                  tone="ava"
                  content={segment}
                  proactive={item.proactive && segmentIndex === 0}
                  style={styles.avaSegment}
                />
              ))}
            </View>
          );
        }}
      />

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <ChatComposer
        value={text}
        onChangeText={setText}
        onSend={send}
        sending={sending}
        disabled={!text.trim()}
        maxLength={4000}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  header: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.line },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "#D8B7B0" },
  avatarText: { color: "#fff", fontSize: 20, fontWeight: "800" },
  headerCopy: { flex: 1, gap: 2 },
  title: { ...typography.sectionTitle, color: colors.ink },
  status: { ...typography.caption, color: colors.muted },
  usage: { ...typography.caption, color: colors.softText },
  messages: { flexGrow: 1, padding: 16 },
  empty: { alignItems: "center", justifyContent: "center", padding: 40, gap: 8 },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  emptyText: { color: colors.muted, lineHeight: 21, textAlign: "center" },
  groupedMessage: { marginTop: 6 },
  turnMessage: { marginTop: 14 },
  avaBubbleGroup: { alignSelf: "flex-start", maxWidth: "88%", gap: 5 },
  avaSegment: { maxWidth: "100%" },
  notice: { color: colors.warning, paddingHorizontal: 16, paddingVertical: 7 }
});
