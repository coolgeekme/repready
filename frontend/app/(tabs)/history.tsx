import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";

const TYPE_LABELS: Record<string, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  cold_email: { label: "Cold Email", icon: "mail-outline" },
  objection: { label: "Objection", icon: "shield-checkmark-outline" },
  call_script: { label: "Call Script", icon: "call-outline" },
  company_intel: { label: "Company Intel", icon: "search-outline" },
  re_engagement: { label: "Re-Engage", icon: "refresh-outline" },
  linkedin_post: { label: "Social Post", icon: "share-social-outline" },
};

export default function History() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"all" | "saved">("all");

  const load = useCallback(async () => {
    try {
      const res = await api.listHistory(filter === "saved");
      setItems(res.items || []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const toggle = async (id: string) => {
    await api.toggleSave(id);
    load();
  };

  const remove = async (id: string) => {
    await api.deleteHistory(id);
    load();
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.container}>
      <View style={styles.headerWrap}>
        <Text style={styles.overline}>Library</Text>
        <Text style={styles.h1}>Saved & recent</Text>
        <View style={styles.chipsRow}>
          <Chip testID="library-filter-all" label="All" active={filter === "all"} onPress={() => setFilter("all")} />
          <Chip testID="library-filter-saved" label="Saved" active={filter === "saved"} onPress={() => setFilter("saved")} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><Ionicons name="document-text-outline" size={28} color={colors.textSubtle} /></View>
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.emptyDesc}>Generate a cold email or LinkedIn post — it&apos;ll land here automatically.</Text>
            <TouchableOpacity testID="library-empty-cta" style={styles.primaryBtn} onPress={() => router.push("/(tabs)")}>
              <Text style={styles.primaryBtnText}>Open generators</Text>
            </TouchableOpacity>
          </View>
        ) : (
          items.map((it) => {
            const meta = TYPE_LABELS[it.type] || { label: it.type, icon: "document-outline" };
            return (
              <TouchableOpacity
                key={it.id}
                testID={`history-item-${it.id}`}
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => router.push({ pathname: "/generate/[type]", params: { type: it.type.replace("_", "-"), historyId: it.id } } as any)}
              >
                <View style={styles.rowIcon}><Ionicons name={meta.icon as any} size={18} color={colors.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{it.title}</Text>
                  <Text style={styles.rowMeta}>{meta.label} · {new Date(it.created_at).toLocaleDateString()}</Text>
                </View>
                <TouchableOpacity testID={`history-save-${it.id}`} onPress={() => toggle(it.id)} hitSlop={8}>
                  <Ionicons name={it.saved ? "bookmark" : "bookmark-outline"} size={20} color={it.saved ? colors.primary : colors.textSubtle} />
                </TouchableOpacity>
                <TouchableOpacity testID={`history-delete-${it.id}`} onPress={() => remove(it.id)} hitSlop={8} style={{ marginLeft: 12 }}>
                  <Ionicons name="trash-outline" size={18} color={colors.textSubtle} />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Chip({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID: string }) {
  return (
    <TouchableOpacity testID={testID} onPress={onPress} style={[chipStyles.chip, active && chipStyles.chipActive]}>
      <Text style={[chipStyles.chipText, active && chipStyles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const chipStyles = StyleSheet.create({
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  chipActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  chipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.primary },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerWrap: { padding: spacing.lg, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  overline: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase" },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.6, marginTop: 4, fontFamily: fonts.heading as string },
  chipsRow: { flexDirection: "row", gap: 8, marginTop: spacing.md },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl, gap: 8 },

  row: { flexDirection: "row", alignItems: "center", padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", gap: 12 },
  rowIcon: { width: 36, height: 36, borderRadius: radii.sm, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" },
  rowTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  rowMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  empty: { alignItems: "center", padding: spacing.xl, gap: 8, marginTop: 40 },
  emptyIcon: { width: 56, height: 56, borderRadius: radii.sm, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  emptyDesc: { color: colors.textMuted, textAlign: "center", maxWidth: 260, lineHeight: 20 },
  primaryBtn: { backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 12, borderRadius: radii.sm, marginTop: spacing.md },
  primaryBtnText: { color: "#fff", fontWeight: "700" },
});
