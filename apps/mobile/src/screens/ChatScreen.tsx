import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { X } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type { ChatRequest } from "@softplace/shared";
import { api } from "../api/client";
import { ChatComposer } from "../components/ChatComposer";
import { CompanionBubble } from "../components/CompanionBubble";
import { CompanionModeControl } from "../components/CompanionModeControl";
import { useInitialScrollToLatest } from "../hooks/useInitialScrollToLatest";
import { colors, typography } from "../theme/theme";
import type { LocalMessage, PendingMemory } from "../types";

const DEEP_MODE_KEY = "softplace.deepMode";

type Props = {
  accessToken: string;
  active: boolean;
  initialPrompt?: string;
  resetVersion: number;
  onInitialPromptConsumed: () => void;
};

export function ChatScreen({
  accessToken,
  active,
  initialPrompt,
  resetVersion,
  onInitialPromptConsumed
}: Props) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ uri: string; base64: string } | null>(null);
  const [pendingMemories, setPendingMemories] = useState<PendingMemory[]>([]);
  const [notice, setNotice] = useState("");
  const [deepMode, setDeepMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const {
    listRef,
    onContentSizeChange,
    onListLayout,
    onLastItemLayout,
    onScrollBeginDrag,
    onScroll,
    resetInitialScroll,
  } = useInitialScrollToLatest<LocalMessage>({
    active,
    itemCount: messages.length,
    resetKey: `${accessToken}:${resetVersion}`
  });

  useEffect(() => {
    AsyncStorage.getItem(DEEP_MODE_KEY)
      .then((value) => setDeepMode(value === "true"))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const keyboardSubscription = Keyboard.addListener("keyboardDidShow", () => {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 120);
    });

    return () => keyboardSubscription.remove();
  }, []);

  useEffect(() => {
    setLoadingHistory(true);
    setMessages([]);
    setPendingMemories([]);
    api
      .conversationMessages(accessToken)
      .then((response) => {
        resetInitialScroll();
        setMessages(response.messages);
        setNextCursor(response.nextCursor);
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "無法載入聊天內容。"))
      .finally(() => setLoadingHistory(false));
  }, [accessToken, resetInitialScroll, resetVersion]);

  useEffect(() => {
    if (initialPrompt) {
      setText(initialPrompt);
      onInitialPromptConsumed();
    }
  }, [initialPrompt, onInitialPromptConsumed]);

  async function setDeepModePersisted(enabled: boolean) {
    setDeepMode(enabled);
    await AsyncStorage.setItem(DEEP_MODE_KEY, String(enabled));
  }

  async function loadOlder() {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await api.conversationMessages(accessToken, nextCursor);
      setMessages((current) => [...response.messages, ...current]);
      setNextCursor(response.nextCursor);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "無法載入更早的訊息。");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice("需要相簿權限才能傳圖片。");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: false
    });
    if (picked.canceled || !picked.assets[0]) return;
    const compressed = await ImageManipulator.manipulateAsync(
      picked.assets[0].uri,
      [{ resize: { width: 1280 } }],
      { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    if (compressed.base64) {
      setImage({ uri: compressed.uri, base64: compressed.base64 });
    }
  }

  async function send() {
    const message = text.trim();
    if ((!message && !image) || sending) return;
    const selectedImage = image;
    setSending(true);
    setNotice("");
    const localId = `local-${Date.now()}`;
    const localUserMessage: LocalMessage = {
      id: localId,
      role: "user",
      content: message || "我想給你看這張圖。",
      createdAt: new Date().toISOString(),
      imagePresent: Boolean(selectedImage)
    };
    setMessages((current) => [...current, localUserMessage]);
    setText("");
    setImage(null);
    Keyboard.dismiss();

    try {
      const request: ChatRequest = {
        message: localUserMessage.content,
        requestedMode: deepMode ? "deep" : "light",
        imageBase64: selectedImage?.base64,
        imageMimeType: selectedImage ? "image/jpeg" : undefined
      };
      const response = await api.chat(request, accessToken);
      setMessages((current) => [...current, response.assistantMessage]);
      setNotice(response.quotaNotice ?? "");
      if (deepMode && response.mode === "light") {
        await setDeepModePersisted(false);
      }
      setPendingMemories((current) => [
        ...response.memorySuggestions.map((suggestion, index) => ({
          ...suggestion,
          id: `${Date.now()}-${index}`
        })),
        ...current
      ]);
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== localId));
      setText(message);
      setNotice(error instanceof Error ? error.message : "送出失敗，請再試一次。");
    } finally {
      setSending(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }

  async function confirmMemory(memory: PendingMemory) {
    try {
      await api.createMemory({ content: memory.content, category: memory.category }, accessToken);
      setPendingMemories((current) => current.filter((item) => item.id !== memory.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "記憶儲存失敗。");
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior="translate-with-padding"
      enabled={active}
      keyboardVerticalOffset={0}
    >
      <View style={styles.fixedHeader}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>我在這裡</Text>
          <Text style={styles.subtitle}>先把這一刻放下來一點點。</Text>
        </View>
        <CompanionModeControl
          value={deepMode ? "deep" : "light"}
          disabled={sending}
          onChange={(mode) => void setDeepModePersisted(mode === "deep")}
        />
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
        ListHeaderComponent={
          nextCursor ? (
            <Pressable onPress={loadOlder} style={styles.olderButton} disabled={loadingOlder}>
              {loadingOlder ? (
                <ActivityIndicator color={colors.accentDark} />
              ) : (
                <Text style={styles.olderText}>載入更早的訊息</Text>
              )}
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          loadingHistory ? (
            <ActivityIndicator color={colors.accent} style={styles.emptyState} />
          ) : (
            <Text style={styles.emptyState}>這裡還是空的。你可以慢慢開始。</Text>
          )
        }
        renderItem={({ item, index }) => {
          const displayRole = item.role === "user" ? "user" : "assistant";
          const previousRole = index > 0
            ? messages[index - 1]?.role === "user" ? "user" : "assistant"
            : null;
          return (
            <CompanionBubble
              role={displayRole}
              content={item.content}
              imagePresent={item.imagePresent}
              style={index === 0 ? undefined : previousRole === displayRole ? styles.groupedBubble : styles.turnBubble}
              onLayout={index === messages.length - 1 ? onLastItemLayout : undefined}
            />
          );
        }}
      />

      {pendingMemories.length ? (
        <View style={styles.memoryTray}>
          <Text style={styles.memoryTitle}>我可以記住嗎？</Text>
          {pendingMemories.slice(0, 2).map((memory) => (
            <View key={memory.id} style={styles.memoryRow}>
              <Text style={styles.memoryText}>{memory.content}</Text>
              <Pressable onPress={() => confirmMemory(memory)} style={styles.memoryAction}>
                <Text style={styles.memoryActionText}>記住</Text>
              </Pressable>
              <Pressable onPress={() => setPendingMemories((current) => current.filter((item) => item.id !== memory.id))}>
                <X size={18} color={colors.softText} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {image ? (
        <View style={styles.previewRow}>
          <Image source={{ uri: image.uri }} style={styles.preview} />
          <Text style={styles.previewText}>圖片</Text>
          <Pressable onPress={() => setImage(null)} accessibilityLabel="移除圖片">
            <X size={22} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      <ChatComposer
        value={text}
        onChangeText={setText}
        onImagePress={pickImage}
        onSend={send}
        sending={sending}
        disabled={!text.trim() && !image}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg
  },
  messages: {
    padding: 16,
    flexGrow: 1
  },
  fixedHeader: {
    minHeight: 76,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  title: {
    ...typography.sectionTitle,
    color: colors.ink,
  },
  subtitle: {
    ...typography.caption,
    color: colors.muted,
  },
  olderButton: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center"
  },
  olderText: {
    color: colors.accentDark,
    fontWeight: "700"
  },
  emptyState: {
    color: colors.softText,
    textAlign: "center",
    paddingVertical: 40
  },
  groupedBubble: {
    marginTop: 6
  },
  turnBubble: {
    marginTop: 14
  },
  memoryTray: {
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderColor: colors.line,
    backgroundColor: "#FBF7F1"
  },
  memoryTitle: {
    color: colors.accentDark,
    fontWeight: "800"
  },
  memoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10
  },
  memoryText: {
    flex: 1,
    color: colors.ink,
    lineHeight: 20
  },
  memoryAction: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.accent
  },
  memoryActionText: {
    color: "#fff",
    fontWeight: "800"
  },
  notice: {
    color: colors.warning,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 8
  },
  preview: {
    width: 64,
    height: 64,
    borderRadius: 8
  },
  previewText: {
    flex: 1,
    color: colors.muted,
    fontSize: 12
  }
});
