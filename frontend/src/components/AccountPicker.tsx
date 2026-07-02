import { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Modal, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/lib/api";
import { colors, radii, spacing } from "@/src/theme";

type Platform = "linkedin" | "facebook" | "instagram";

export type AccountsMap = {
  linkedin: Array<{ id: string; connection_id: string; display_name: string; kind: "linkedin" }>;
  facebook_pages: Array<{ id: string; page_id: string; connection_id: string; display_name: string; kind: "facebook_page" }>;
  instagram: Array<{ id: string; connection_id: string; display_name: string; ig_user_id?: string; kind: "instagram" }>;
};

export type SelectedAccounts = { linkedin?: string; facebook?: string; instagram?: string };

const PLATFORM_META: Record<Platform, { label: string; icon: keyof typeof Ionicons.glyphMap; color: string; picker_key: keyof AccountsMap }> = {
  linkedin: { label: "LinkedIn", icon: "logo-linkedin", color: "#0A66C2", picker_key: "linkedin" },
  facebook: { label: "Facebook Page", icon: "logo-facebook", color: "#1877F2", picker_key: "facebook_pages" },
  instagram: { label: "Instagram", icon: "logo-instagram", color: "#E1306C", picker_key: "instagram" },
};

type Props = {
  visible: boolean;
  onClose: () => void;
  platforms: Platform[];  // which platforms to show sections for
  selected: SelectedAccounts;
  onChange: (next: SelectedAccounts) => void;
  title?: string;
};

/**
 * Bottom-sheet picker that lets the user choose which social account (LinkedIn
 * profile, Facebook Page, or Instagram Business account) a post will use.
 *
 * Selection is stored back into the parent via `onChange` and can be persisted
 * per-history-entry from there.
 */
export default function AccountPicker({ visible, onClose, platforms, selected, onChange, title }: Props) {
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<AccountsMap | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await api.socialAllAccounts();
        if (!cancelled) setAccounts(res);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Couldn't load your social accounts.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const pick = (platform: Platform, id: string | undefined) => {
    onChange({ ...selected, [platform]: id });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <Text style={styles.title}>{title || "Post as"}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={22} color={colors.textSubtle} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ paddingBottom: 20 }}>
            {loading ? (
              <View style={styles.loading}>
                <ActivityIndicator />
                <Text style={styles.loadingText}>Loading your accounts…</Text>
              </View>
            ) : err ? (
              <Text style={styles.errText}>{err}</Text>
            ) : (
              platforms.map((platform) => {
                const meta = PLATFORM_META[platform];
                const items = ((accounts as any)?.[meta.picker_key] || []) as Array<{ id: string; display_name: string }>;
                const currentId = selected[platform];
                return (
                  <View key={platform} style={styles.section}>
                    <View style={styles.sectionHeader}>
                      <Ionicons name={meta.icon} size={16} color={meta.color} />
                      <Text style={styles.sectionTitle}>{meta.label}</Text>
                    </View>
                    {items.length === 0 ? (
                      <Text style={styles.emptyText}>No {meta.label} accounts connected. Connect one from Settings.</Text>
                    ) : (
                      items.map((item) => {
                        const chosen = currentId === item.id;
                        return (
                          <TouchableOpacity
                            key={item.id}
                            testID={`account-picker-${platform}-${item.id}`}
                            style={[styles.row, chosen && styles.rowChosen]}
                            onPress={() => pick(platform, chosen ? undefined : item.id)}
                            activeOpacity={0.75}
                          >
                            <View style={styles.rowIcon}>
                              <Ionicons name={meta.icon} size={16} color={meta.color} />
                            </View>
                            <Text style={styles.rowName} numberOfLines={1}>{item.display_name}</Text>
                            {chosen ? (
                              <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                            ) : (
                              <View style={styles.radio} />
                            )}
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </View>
                );
              })
            )}
          </ScrollView>

          <TouchableOpacity style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}


/** Display helper to render the short "Post as ..." pill inline. */
export function AccountSummary({
  selected,
  accounts,
  platforms,
  onPress,
}: {
  selected: SelectedAccounts;
  accounts: AccountsMap | null;
  platforms: Platform[];
  onPress: () => void;
}) {
  const summary = platforms.map((p) => {
    const meta = PLATFORM_META[p];
    const id = selected[p];
    if (!id || !accounts) return null;
    const list = (accounts as any)[meta.picker_key] || [];
    const found = list.find((x: any) => x.id === id);
    return found ? found.display_name : null;
  }).filter(Boolean);

  return (
    <TouchableOpacity style={styles.summaryPill} onPress={onPress} activeOpacity={0.75} testID="account-summary-pill">
      <Ionicons name="people-outline" size={14} color={colors.primary} />
      <Text style={styles.summaryLabel}>Post as</Text>
      <Text style={styles.summaryValue} numberOfLines={1}>
        {summary.length ? summary.join(" · ") : "Choose account"}
      </Text>
      <Ionicons name="chevron-down" size={14} color={colors.textSubtle} />
    </TouchableOpacity>
  );
}


const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: 8,
    paddingBottom: 20,
    maxHeight: "88%",
  },
  grabber: { alignSelf: "center", width: 44, height: 4, borderRadius: 2, backgroundColor: "#dcdcdc", marginBottom: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title: { fontSize: 18, fontWeight: "800", color: colors.text },
  loading: { alignItems: "center", padding: 32, gap: 8 },
  loadingText: { color: colors.textSubtle, fontSize: 13 },
  errText: { color: colors.error, padding: 16, textAlign: "center" },
  section: { marginTop: 14, paddingTop: 8 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: colors.textSubtle, letterSpacing: 0.5, textTransform: "uppercase" },
  emptyText: { fontSize: 13, color: colors.textSubtle, fontStyle: "italic", paddingVertical: 8 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, marginBottom: 6, backgroundColor: "#fff",
  },
  rowChosen: { borderColor: colors.primary, backgroundColor: "#f4f7ff" },
  rowIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#f4f4f4", alignItems: "center", justifyContent: "center" },
  rowName: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.border },
  doneBtn: { marginTop: 12, paddingVertical: 14, borderRadius: radii.sm, backgroundColor: colors.primary, alignItems: "center" },
  doneBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  summaryPill: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12,
    borderWidth: 1, borderColor: colors.border, borderRadius: 999, backgroundColor: "#f7f8fb",
    alignSelf: "flex-start", maxWidth: "100%", marginTop: 8, marginBottom: 6,
  },
  summaryLabel: { color: colors.textSubtle, fontSize: 12, fontWeight: "600" },
  summaryValue: { color: colors.primary, fontSize: 12, fontWeight: "700", maxWidth: 220 },
});
